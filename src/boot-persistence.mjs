import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const BOOT_LABEL = 'TrackerBridge'
/**
 * Windows autostart uses a Scheduled Task rather than the per-user Run
 * registry key.
 *
 * Writing a Run key from a script and then launching the result windowless is
 * one of the behaviours Microsoft Defender's ML model scores as a dropper. The
 * bridge was being reported as Trojan:Script/Wacatac.C!ml on install despite
 * being ordinary open-source software. Task Scheduler is the mechanism Windows
 * provides for background helpers: it starts a task with no console window (so
 * no VBS wrapper is needed) and the entry is visible and removable in the Task
 * Scheduler UI.
 *
 * schtasks.exe is invoked directly, so no PowerShell -- and therefore no
 * -ExecutionPolicy Bypass -- is involved in autostart at all.
 */
const WINDOWS_TASK_NAME = 'TrackerBridge'

/** Command used for OS startup entries — runs detached in the background. */
export function buildBootLaunchCommand() {
  return 'npx tracker-bridge --daemon --skip-intro --no-boot'
}

function macLaunchAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.thetowerruntracker.tracker-bridge.plist')
}

function linuxAutostartPath() {
  return path.join(os.homedir(), '.config', 'autostart', 'tracker-bridge.desktop')
}

async function runSchtasks(args, timeoutMs = 15_000) {
  return await execFileAsync('schtasks', args, { timeout: timeoutMs, windowsHide: true })
}

async function resolveWindowsNpxPath() {
  try {
    const { stdout } = await execFileAsync('where', ['npx'], { timeout: 10_000, windowsHide: true })
    const first = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
    return first || null
  } catch {
    return null
  }
}

// Windows Startup folder entry, used when a Scheduled Task cannot be created
// (ONLOGON tasks require elevation, which this per-user install does not have).
function windowsStartupEntryPath() {
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'Tracker Bridge.cmd',
  )
}

export async function isBootEntryInstalled() {
  if (process.platform === 'win32') {
    // Either mechanism counts: a Scheduled Task when elevation allowed one,
    // otherwise the Startup-folder script.
    if (fs.existsSync(windowsStartupEntryPath())) return true
    try {
      // schtasks exits non-zero when the task does not exist; the catch below
      // turns that into `false`.
      const { stdout } = await runSchtasks(['/Query', '/TN', WINDOWS_TASK_NAME])
      return String(stdout || '').includes(WINDOWS_TASK_NAME)
    } catch {
      return false
    }
  }

  if (process.platform === 'darwin') {
    return fs.existsSync(macLaunchAgentPath())
  }

  if (process.platform === 'linux') {
    return fs.existsSync(linuxAutostartPath())
  }

  return false
}

export async function installBootEntry(log = console.log) {
  const launchCommand = buildBootLaunchCommand()

  if (process.platform === 'win32') {
    const npxPath = await resolveWindowsNpxPath()
    const resolvedCommand = npxPath
      ? `"${npxPath}" tracker-bridge --daemon --skip-intro --no-boot`
      : launchCommand
    // Wrapped through cmd.exe so the npx.cmd shim runs via a shell, using the
    // absolute path when one was found so boot-time PATH is never a factor.
    const fullCommand = `cmd.exe /c "${resolvedCommand.replace(/"/g, '\\"')}"`

    // Prefer a Scheduled Task: it starts the command with no console window (so
    // no VBS wrapper is needed) and the entry is visible and removable in the
    // Task Scheduler UI. /F replaces any existing task, so re-running is
    // idempotent.
    //
    // But /SC ONLOGON requires elevation, and this installs per-user with no
    // UAC prompt by design, so for most users it fails with "Access is denied"
    // -- which used to throw straight out of here and leave autostart silently
    // unregistered. Fall back to a Startup-folder script: no elevation needed,
    // and it is a plain file the user can see and delete -- unlike a registry
    // Run key, which is hidden and part of the behaviour Defender scores as a
    // dropper.
    try {
      await runSchtasks(['/Create', '/TN', WINDOWS_TASK_NAME, '/TR', fullCommand, '/SC', 'ONLOGON', '/F'])
      log('Registered Tracker Bridge to start when you sign in to Windows (Scheduled Task).')
      return
    } catch {
      // Elevation unavailable -- use the Startup folder instead.
    }

    const startupPath = windowsStartupEntryPath()
    fs.mkdirSync(path.dirname(startupPath), { recursive: true })
    // Write resolvedCommand, not fullCommand: the backslash-escaped quotes in
    // fullCommand are for passing a single argument to schtasks. A .cmd file
    // needs plain quoting, and needs no cmd.exe wrapper -- it is already a
    // batch file. CRLF because cmd.exe parses LF-only batch files unreliably.
    const eol = String.fromCharCode(13, 10)
    fs.writeFileSync(startupPath, '@echo off' + eol + resolvedCommand + eol, 'utf8')
    log('Registered Tracker Bridge to start when you sign in to Windows (Startup folder).')
    return
  }

  if (process.platform === 'darwin') {
    const plistPath = macLaunchAgentPath()
    fs.mkdirSync(path.dirname(plistPath), { recursive: true })
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.thetowerruntracker.tracker-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${launchCommand}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>
`
    fs.writeFileSync(plistPath, plist, 'utf8')
    try {
      await execFileAsync('launchctl', ['load', plistPath], { timeout: 10_000 })
    } catch {
      // launchctl refuses when the agent is already loaded; harmless.
    }
    log('Registered Tracker Bridge Launch Agent (starts at login).')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    const desktop = `[Desktop Entry]
Type=Application
Name=Tracker Bridge
Comment=Local save finder for The Tower Run Tracker
Exec=/bin/sh -lc "${launchCommand.replace(/"/g, '\\"')}"
Terminal=false
X-GNOME-Autostart-enabled=true
`
    fs.writeFileSync(desktopPath, desktop, 'utf8')
    log('Registered Tracker Bridge autostart entry.')
    return
  }

  log('Automatic startup is not supported on this platform.')
}

export async function removeBootEntry(log = console.log) {
  if (process.platform === 'win32') {
    // Clear both mechanisms: which one was used depends on whether the task
    // could be created, so removal must not assume either.
    try {
      await runSchtasks(['/Delete', '/TN', WINDOWS_TASK_NAME, '/F'])
    } catch {
      // No Scheduled Task registered.
    }
    try {
      fs.rmSync(windowsStartupEntryPath(), { force: true })
    } catch {
      // No Startup-folder entry either.
    }
    log('Removed Tracker Bridge from Windows startup.')
    return
  }

  if (process.platform === 'darwin') {
    const plistPath = macLaunchAgentPath()
    try {
      await execFileAsync('launchctl', ['unload', plistPath], { timeout: 10_000 })
    } catch {
      // Not loaded, so there is nothing to unload.
    }
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath)
    }
    log('Removed Tracker Bridge Launch Agent.')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    if (fs.existsSync(desktopPath)) {
      fs.unlinkSync(desktopPath)
    }
    log('Removed Tracker Bridge autostart entry.')
    return
  }

  log('No startup entry to remove on this platform.')
}
