import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Autostart, for the bridge as a whole rather than per game.
 *
 * One entry no matter how many games are enabled. Two bridges meant two
 * autostart entries racing to start adb; adding a third game must not add a
 * third.
 *
 * Windows uses a Scheduled Task rather than the per-user Run registry key.
 * Writing a Run key from a script and launching the result windowless is one of
 * the behaviours Microsoft Defender's ML model scores as a dropper -- the
 * bridge this replaces was reported as Trojan:Script/Wacatac.C!ml for exactly
 * that shape. schtasks.exe is invoked directly, so no PowerShell and no
 * -ExecutionPolicy Bypass is involved in autostart at all.
 */
const WINDOWS_TASK_NAME = 'AdbBridge'
const MAC_LABEL = 'io.github.tmrxjd.adb-bridge'
const LINUX_ENTRY = 'adb-bridge.desktop'
const WINDOWS_STARTUP_FILE = 'ADB Bridge.cmd'

/**
 * The per-game bridges this replaces. Their entries are removed when ours is
 * installed, so a user who upgrades does not end up with the old bridge and the
 * new one both starting at sign-in and fighting over the same adb server.
 */
const LEGACY = {
  windowsTasks: ['TrackerBridge', 'CifiBridge'],
  // MATCHED BY PATTERN, NOT BY EXACT NAME, and that distinction is the whole point.
  //
  // This list held 'Tracker Bridge.cmd' and 'CIFI Bridge.cmd' and removed neither, because the
  // per-game Inno Setup installer does not write a .cmd -- it writes a SHORTCUT,
  // "Tracker Bridge.lnk", pointing at a hidden tracker-bridge-hidden.vbs launcher. So the cleanup
  // silently found nothing, the old bridge kept starting at sign-in, and it held port 43781 against
  // the game adb-bridge would otherwise have served. Measured on a real machine: adb-bridge
  // installed and registered for boot, and "Tracker Bridge.lnk" still sitting in Startup beside it.
  //
  // An exact-name list cannot survive an installer changing its extension, so match the NAME and
  // accept any launcher extension. Our own entry is 'ADB Bridge.cmd', which none of these match.
  windowsStartupPatterns: [/^tracker[ _-]?bridge\b.*\.(lnk|cmd|vbs|bat)$/i, /^cifi[ _-]?bridge\b.*\.(lnk|cmd|vbs|bat)$/i],
  macLabels: ['com.thetowerruntracker.tracker-bridge', 'com.cifihuntersim.cifi-bridge'],
  linuxEntries: ['tracker-bridge.desktop', 'cifi-bridge.desktop'],
}

/** Command used for OS startup entries -- runs detached in the background. */
export function buildBootLaunchCommand() {
  return 'npx adb-bridge --daemon --skip-intro --no-boot'
}

function macLaunchAgentPath(label = MAC_LABEL) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
}

function linuxAutostartPath(entry = LINUX_ENTRY) {
  return path.join(os.homedir(), '.config', 'autostart', entry)
}

/**
 * Startup-folder entry, used when a Scheduled Task cannot be created.
 * /SC ONLOGON requires elevation and this installs per-user with no UAC prompt.
 */
function windowsStartupEntryPath(filename = WINDOWS_STARTUP_FILE) {
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    filename,
  )
}

/**
 * Is this Startup-folder entry one of the per-game bridges we replace?
 *
 * Exported so the rule is checkable: the previous version of this cleanup was an exact-filename
 * list that matched nothing on a real machine, and no test could see that because the list was
 * private and only consulted against the live filesystem.
 *
 * @param {string} filename
 * @returns {boolean}
 */
export function isLegacyWindowsStartupEntry(filename) {
  const name = String(filename || '')
  if (name === WINDOWS_STARTUP_FILE) return false // never our own entry
  return LEGACY.windowsStartupPatterns.some(re => re.test(name))
}

/** Everything currently in the per-user Startup folder; empty when it does not exist. */
function listWindowsStartupEntries() {
  try {
    return fs.readdirSync(path.dirname(windowsStartupEntryPath()))
  } catch {
    return []
  }
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

async function readWindowsTask(name) {
  try {
    const { stdout } = await runSchtasks(['/Query', '/TN', name])
    return String(stdout || '').includes(name)
  } catch {
    return false
  }
}

export async function isBootEntryInstalled() {
  if (process.platform === 'win32') {
    // Either mechanism counts: a Scheduled Task when elevation allowed one,
    // otherwise the Startup-folder script.
    if (fs.existsSync(windowsStartupEntryPath())) return true
    return readWindowsTask(WINDOWS_TASK_NAME)
  }
  if (process.platform === 'darwin') return fs.existsSync(macLaunchAgentPath())
  if (process.platform === 'linux') return fs.existsSync(linuxAutostartPath())
  return false
}

/**
 * Remove autostart entries left by the per-game bridges.
 *
 * Best-effort and silent about absence: most users will have none of these, and
 * failing to clean one up must never stop our own entry being installed.
 *
 * @returns {Promise<string[]>} Human-readable descriptions of what was removed.
 */
export async function removeLegacyBootEntries() {
  const removed = []

  if (process.platform === 'win32') {
    for (const task of LEGACY.windowsTasks) {
      if (!(await readWindowsTask(task))) continue
      try {
        await runSchtasks(['/Delete', '/TN', task, '/F'])
        removed.push(`scheduled task "${task}"`)
      } catch {
        // Present but not removable (created by another user); leave it.
      }
    }
    for (const filename of listWindowsStartupEntries()) {
      if (!isLegacyWindowsStartupEntry(filename)) continue
      try {
        fs.rmSync(windowsStartupEntryPath(filename), { force: true })
        removed.push(`startup entry "${filename}"`)
      } catch {
        // Locked; not worth failing the install over.
      }
    }
    return removed
  }

  if (process.platform === 'darwin') {
    for (const label of LEGACY.macLabels) {
      const plist = macLaunchAgentPath(label)
      if (!fs.existsSync(plist)) continue
      try {
        await execFileAsync('launchctl', ['unload', plist], { timeout: 10_000 })
      } catch {
        // Not loaded.
      }
      try {
        fs.rmSync(plist, { force: true })
        removed.push(`launch agent "${label}"`)
      } catch {
        // Leave it.
      }
    }
    return removed
  }

  if (process.platform === 'linux') {
    for (const entry of LEGACY.linuxEntries) {
      const target = linuxAutostartPath(entry)
      if (!fs.existsSync(target)) continue
      try {
        fs.rmSync(target, { force: true })
        removed.push(`autostart entry "${entry}"`)
      } catch {
        // Leave it.
      }
    }
  }
  return removed
}

export async function installBootEntry(log = console.log) {
  const launchCommand = buildBootLaunchCommand()

  // Do this first: a user upgrading from tracker-bridge or cifi-bridge would
  // otherwise have both the old and new entries starting at sign-in.
  const removed = await removeLegacyBootEntries()
  for (const entry of removed) {
    log(`Removed the old per-game ${entry}; adb-bridge starts them all now.`)
  }

  if (process.platform === 'win32') {
    const npxPath = await resolveWindowsNpxPath()
    const resolvedCommand = npxPath
      ? `"${npxPath}" adb-bridge --daemon --skip-intro --no-boot`
      : launchCommand
    // Wrapped through cmd.exe so the npx.cmd shim runs via a shell, using the
    // absolute path when one was found so boot-time PATH is never a factor.
    const fullCommand = `cmd.exe /c "${resolvedCommand.replace(/"/g, '\\"')}"`

    // Prefer a Scheduled Task: it starts the command with no console window and
    // the entry is visible and removable in the Task Scheduler UI. /F replaces
    // any existing task, so re-running is idempotent.
    //
    // But /SC ONLOGON requires elevation, and this installs per-user with no
    // UAC prompt by design, so for most users it fails with "Access is denied".
    // Fall back to a Startup-folder script: no elevation needed, and it is a
    // plain file the user can see and delete.
    try {
      await runSchtasks(['/Create', '/TN', WINDOWS_TASK_NAME, '/TR', fullCommand, '/SC', 'ONLOGON', '/F'])
      log('Registered adb-bridge to start when you sign in to Windows (Scheduled Task).')
      return
    } catch {
      // Elevation unavailable -- use the Startup folder instead.
    }

    const startupPath = windowsStartupEntryPath()
    fs.mkdirSync(path.dirname(startupPath), { recursive: true })
    // Write resolvedCommand, not fullCommand: the backslash-escaped quotes in
    // fullCommand are for passing a single argument to schtasks. A .cmd file
    // needs plain quoting and no cmd.exe wrapper -- it is already a batch file.
    // CRLF because cmd.exe parses LF-only batch files unreliably.
    const eol = String.fromCharCode(13, 10)
    fs.writeFileSync(startupPath, `@echo off${eol}${resolvedCommand}${eol}`, 'utf8')
    log('Registered adb-bridge to start when you sign in to Windows (Startup folder).')
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
  <string>${MAC_LABEL}</string>
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
    log('Registered the adb-bridge Launch Agent (starts at login).')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    const desktop = `[Desktop Entry]
Type=Application
Name=ADB Bridge
Comment=Local save bridge for Android games
Exec=/bin/sh -lc "${launchCommand.replace(/"/g, '\\"')}"
Terminal=false
X-GNOME-Autostart-enabled=true
`
    fs.writeFileSync(desktopPath, desktop, 'utf8')
    log('Registered the adb-bridge autostart entry.')
    return
  }

  log('Automatic startup is not supported on this platform.')
}

export async function removeBootEntry(log = console.log) {
  // Clear the legacy entries too, so "remove autostart" means it.
  await removeLegacyBootEntries()

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
    log('Removed adb-bridge from Windows startup.')
    return
  }

  if (process.platform === 'darwin') {
    const plistPath = macLaunchAgentPath()
    try {
      await execFileAsync('launchctl', ['unload', plistPath], { timeout: 10_000 })
    } catch {
      // Not loaded, so there is nothing to unload.
    }
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath)
    log('Removed the adb-bridge Launch Agent.')
    return
  }

  if (process.platform === 'linux') {
    const desktopPath = linuxAutostartPath()
    if (fs.existsSync(desktopPath)) fs.unlinkSync(desktopPath)
    log('Removed the adb-bridge autostart entry.')
    return
  }

  log('No startup entry to remove on this platform.')
}
