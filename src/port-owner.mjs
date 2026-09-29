import { execFile } from 'node:child_process'
import net from 'node:net'
import { promisify } from 'node:util'
import { PRIVATE_NETWORK_PING_PATH } from './http-handlers.mjs'

const execFileAsync = promisify(execFile)

/**
 * Who is on a game's port, and whether we may replace them.
 *
 * A busy port used to end in "Port 43791 is already in use, so CIFI was not
 * started ... close it, or uninstall it", and the user had to work out which
 * invisible process that was. Almost always it is one of ours: an old per-game
 * bridge (cifi-bridge, tracker-bridge) still starting at sign-in, or an older
 * adb-bridge. Those are safe to stop, and stopping them is the fix.
 *
 * What is NOT safe is killing an arbitrary program that happens to use the
 * port. So a process is only stopped when the OS says it owns the port AND
 * its command line names one of the known bridge packages.
 */

/**
 * Is this the command line of a bridge? Matched on the FILE NAME of an
 * argument -- the bridge's own entry script or the tray executable -- never on
 * a substring. The first version matched "adb-bridge" anywhere, and the
 * clean-room test caught it stopping an unrelated server whose only link was
 * living under a folder named adb-bridge-sandbox. A user's project folder
 * called that would have had its dev server killed.
 */
const BRIDGE_SCRIPT = /^(?:adb-bridge|cifi-bridge|tracker-bridge|local-adb-bridge)\.[cm]?js$/i
const BRIDGE_EXE = /^(?:adb-bridge-tray|ADB Bridge)\.exe$/i
// Unix global installs run the bin link, which has no extension: .../bin/adb-bridge
const BRIDGE_BIN_LINK = /[\\/]bin[\\/](?:adb-bridge|cifi-bridge|tracker-bridge|local-adb-bridge)$/i

export function isBridgeCommandLine(commandLine) {
  if (/[\\/](?:adb-bridge-tray|ADB Bridge)\.exe\b/i.test(commandLine)) return true
  for (const match of String(commandLine).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const token = match[1] ?? match[2] ?? match[3]
    const name = token.split(/[\\/]/).pop()
    if (BRIDGE_SCRIPT.test(name) || BRIDGE_EXE.test(name) || BRIDGE_BIN_LINK.test(token)) return true
  }
  return false
}

/**
 * Asks the port's ping endpoint who it is. Bridges older than this ping (and
 * every non-bridge) answer null.
 *
 * @returns {Promise<{ product?: string, version?: string, game?: string, pid?: number } | null>}
 */
export async function pingBridge(port, host = '127.0.0.1', timeoutMs = 1500) {
  try {
    const response = await fetch(`http://${host}:${port}${PRIVATE_NETWORK_PING_PATH}`, {
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const body = await response.json()
    return body?.type === 'PRIVATE_NETWORK_PING' ? body : null
  } catch {
    return null
  }
}

/** Parses `netstat -ano` output for the PID listening on a TCP port. */
export function parseNetstatListener(output, port) {
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // Proto  Local Address  Foreign Address  State  PID
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP' || cols[3].toUpperCase() !== 'LISTENING') continue
    if (!cols[1].endsWith(`:${port}`)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0) return pid
  }
  return null
}

export async function findListeningPid(port) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { timeout: 10_000, windowsHide: true })
      return parseNetstatListener(stdout, port)
    }
    const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 10_000 })
    const pid = Number(stdout.trim().split(/\s+/)[0])
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

async function commandLineOf(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
        { timeout: 15_000, windowsHide: true },
      )
      return stdout.trim()
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: 5_000 })
    return stdout.trim()
  } catch {
    return ''
  }
}

export function portIsFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}

/** Resolves true once nothing is listening on the port, false after the timeout. */
export async function waitForPortFree(port, host = '127.0.0.1', timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await portIsFree(port, host)) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

/**
 * Describes the port's owner.
 *
 * `version` is null for the old per-game bridges, which predate the ping; it
 * is what lets the caller keep a running adb-bridge that is already current.
 *
 * @returns {Promise<{ kind: 'free' } | { kind: 'self' }
 *   | { kind: 'bridge', pid: number | null, version: string | null }
 *   | { kind: 'other', pid: number | null, commandLine: string }>}
 */
export async function identifyPortOwner(port, host = '127.0.0.1') {
  if (await portIsFree(port, host)) return { kind: 'free' }
  const ping = await pingBridge(port, host)
  // The pid always comes from the OS, never from the ping: anything local can
  // answer the ping, and a claimed pid is not a reason to stop that process.
  const pid = await findListeningPid(port)
  if (pid === process.pid) return { kind: 'self' }
  const commandLine = pid ? await commandLineOf(pid) : ''
  if (pid && isBridgeCommandLine(commandLine)) {
    const version = ping?.product === 'adb-bridge' && typeof ping.version === 'string' ? ping.version : null
    return { kind: 'bridge', pid, version }
  }
  return { kind: 'other', pid, commandLine }
}

/**
 * Stops the bridge holding `port` and waits for the port to come free.
 *
 * @returns {Promise<boolean>} true when the port is free afterwards.
 */
export async function stopBridgeOnPort(owner, port, log = console.log, host = '127.0.0.1') {
  if (owner.kind !== 'bridge' || !owner.pid) return false
  log(`Stopping the older bridge on port ${port} (process ${owner.pid}) so this one can serve it...`)
  try {
    process.kill(owner.pid)
  } catch (error) {
    // ESRCH: it exited on its own between the lookup and now -- fine.
    if (error?.code !== 'ESRCH') {
      log(`Could not stop process ${owner.pid}: ${error?.message || error}`)
      return false
    }
  }
  return waitForPortFree(port, host)
}
