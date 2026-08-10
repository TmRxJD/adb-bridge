import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { probeHostAdbStatus } from './adb/adb-status.mjs'
import {
  AdbNotFoundError,
  normalizeAdbExecError,
  requireAdbExecutable,
} from './adb/adb-resolve.mjs'
import { handlePrivateNetworkHttp } from './http-handlers.mjs'
import { NO_UPLOADER, supportsLinking } from './upload/uploader-plugin.mjs'
import {
  getLastDevice,
  getUploadDomains,
  isAutoConnectEnabled,
  setAutoConnectEnabled,
  setLastDevice,
  setUploadDomains,
} from './bridge-config.mjs'
import { BridgePullConsole } from './bridge-console.mjs'
import {
  BridgeNoDeviceError,
  BridgeSaveNotFoundError,
  isPhysicalAppSavePath,
  pullSave,
} from './save/pull-save.mjs'

const execFileAsync = promisify(execFile)

export const DEFAULT_HOST = '127.0.0.1'

/**
 * Only this game's own sites may connect.
 *
 * A missing Origin is allowed: native clients and curl send none, and the port
 * is loopback-only. What must be refused is a *different* site's origin, which
 * is what browsers always send and what the previous bridges reflected back.
 */
function isOriginAllowed(profile, origin) {
  if (!origin) return true
  return profile.allowedOrigins.includes(origin)
}

export const BRIDGE_VERSION = '0.1.0'

async function runAdb(args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout, stderr } = await execFileAsync(adb, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return `${stdout || ''}${stderr || ''}`.trim()
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

/** Everything the website's bridge settings dialog renders from. */
function settingsSnapshot(ctx) {
  return {
    game: ctx.profile.id,
    gameName: ctx.profile.name,
    account: supportsLinking(ctx.uploader) ? ctx.uploader.describeLink() : null,
    autoUpload: ctx.uploader.isAutoUploadEnabled(),
    autoConnect: isAutoConnectEnabled(),
    lastDevice: getLastDevice(),
    uploadDomains: getUploadDomains(),
    watchedPath: ctx.saveWatcher?.watchedPath ?? null,
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function attachWebSocketHandlers(wss, ctx) {
  const { profile, uploader } = ctx
  wss.on('headers', (headers, req) => {
    // Echo only an origin we actually allow. Reflecting whatever asked is what
    // let any open page reach the bridge; verifyClient already refuses those,
    // and this makes sure the handshake never advertises otherwise.
    const origin = req.headers?.origin
    if (typeof origin === 'string' && isOriginAllowed(profile, origin)) {
      headers.push(`Access-Control-Allow-Origin: ${origin}`)
      headers.push('Vary: Origin')
    }
    headers.push('Access-Control-Allow-Private-Network: true')
  })

  wss.on('connection', ws => {
    sendJson(ws, { type: 'HELLO', version: BRIDGE_VERSION, port: wss.options.server?.address()?.port })

    ws.on('message', async raw => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        sendJson(ws, { type: 'ERROR', code: 'bad-request', message: 'Invalid JSON message.' })
        return
      }

      if (message?.type === 'PING') {
        sendJson(ws, {
          type: 'PONG',
          version: BRIDGE_VERSION,
          account: supportsLinking(uploader) ? uploader.describeLink() : null,
          autoUpload: uploader.isAutoUploadEnabled(),
          autoConnect: isAutoConnectEnabled(),
          lastDevice: getLastDevice(),
          uploadDomains: getUploadDomains(),
        })
        return
      }

      // The website hands over its Appwrite session so the bridge can upload runs
      // while the site is closed. Loopback-only, and the site is the only origin
      // that can reach this port.
      if (message?.type === 'LINK_ACCOUNT') {
        if (!supportsLinking(uploader)) {
          sendJson(ws, {
            type: 'ERROR',
            code: 'linking-unsupported',
            message: `${profile.name} does not support linking an account on this bridge.`,
          })
          return
        }
        try {
          const account = await uploader.link(message)
          if (typeof message.autoUpload === 'boolean') {
            await uploader.setAutoUpload?.(message.autoUpload)
          }
          console.log(`Linked ${profile.name} account${message.username ? ` (${message.username})` : ''}.`)
          sendJson(ws, {
            type: 'ACCOUNT_LINKED',
            account,
            autoUpload: uploader.isAutoUploadEnabled(),
          })
        } catch (error) {
          sendJson(ws, {
            type: 'ERROR',
            code: 'link-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      if (message?.type === 'UNLINK_ACCOUNT') {
        if (supportsLinking(uploader)) await uploader.unlink()
        console.log(`${profile.name} account unlinked; background uploads are off.`)
        sendJson(ws, {
          type: 'ACCOUNT_LINKED',
          account: supportsLinking(uploader) ? uploader.describeLink() : null,
          autoUpload: uploader.isAutoUploadEnabled(),
        })
        return
      }

      if (message?.type === 'SET_AUTO_UPLOAD') {
        await uploader.setAutoUpload?.(Boolean(message.enabled))
        sendJson(ws, { type: 'AUTO_UPLOAD_STATUS', ...settingsSnapshot(ctx) })
        return
      }

      if (message?.type === 'SET_AUTO_CONNECT') {
        setAutoConnectEnabled(Boolean(message.enabled))
        sendJson(ws, { type: 'SETTINGS', ...settingsSnapshot(ctx) })
        return
      }

      if (message?.type === 'SET_LAST_DEVICE') {
        setLastDevice(message.device ?? null)
        sendJson(ws, { type: 'SETTINGS', ...settingsSnapshot(ctx) })
        return
      }

      if (message?.type === 'SET_UPLOAD_DOMAINS') {
        setUploadDomains(message.domains ?? [])
        sendJson(ws, { type: 'SETTINGS', ...settingsSnapshot(ctx) })
        return
      }

      // Lets the site trigger a pass immediately instead of waiting for the
      // game to write the save again.
      if (message?.type === 'UPLOAD_NOW') {
        try {
          if (!uploader.isLinked()) {
            throw new Error(`No ${profile.name} account is linked on this bridge.`)
          }
          const consoleUi = new BridgePullConsole({ physical: false })
          // Checks a native install first, then falls back to an adb pull, so
          // this works for emulator users exactly like Connect to Emulator does.
          const found = await uploader.acquireSaveBytes?.({
            log: msg => console.log(msg),
            console: consoleUi,
            profile,
          })
          if (!found) {
            throw new Error(
              `No save found. Open ${profile.name} (or start your emulator with ADB enabled), `
              + 'save your progress, then try again.',
            )
          }
          const result = await uploader.upload(found.bytes, {
            log: msg => console.log(msg),
            reason: 'requested',
            profile,
          })
          sendJson(ws, { type: 'UPLOAD_RESULT', ...result, source: found.source })
        } catch (error) {
          sendJson(ws, {
            type: 'ERROR',
            code: 'upload-failed',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      if (message?.type === 'CHECK_ADB') {
        try {
          const status = await probeHostAdbStatus(runAdb)
          sendJson(ws, { type: 'ADB_STATUS', ...status })
        } catch (error) {
          const normalized = normalizeAdbExecError(error)
          const msg = normalized instanceof Error ? normalized.message : String(normalized)
          const code =
            normalized instanceof AdbNotFoundError || normalized?.code === 'adb-not-found'
              ? 'adb-not-found'
              : 'status-failed'
          sendJson(ws, { type: 'ERROR', code, message: msg })
        }
        return
      }

      if (message?.type === 'PULL_SAVE') {
        const customPort =
          message?.customPort != null ? String(message.customPort).trim() : undefined
        const preferPhysicalDevice = Boolean(message?.preferPhysicalDevice)
        const preferNativeHost = Boolean(message?.preferNativeHost)
        const consoleUi = new BridgePullConsole({ physical: preferPhysicalDevice })
        try {
          const result = await pullSave(profile, {
            customPort,
            preferPhysicalDevice,
            preferNativeHost,
            console: consoleUi,
          })
          if (
            preferPhysicalDevice
            && result?.remotePath
            && !isPhysicalAppSavePath(result.remotePath)
          ) {
            throw new BridgeSaveNotFoundError(
              `USB import refused a non-app save path (${result.remotePath}). Stop the bridge and run: npx tracker-bridge`,
              result.deviceSerial,
            )
          }
          sendJson(ws, {
            type: 'SUCCESS',
            data: result.base64,
            remotePath: result.remotePath,
            deviceSerial: result.deviceSerial,
            deviceLabel: result.deviceLabel ?? null,
            byteLength: result.byteLength,
          })
        } catch (error) {
          const normalized = normalizeAdbExecError(error)
          const msg = normalized instanceof Error ? normalized.message : String(normalized)
          consoleUi.logError(
            preferPhysicalDevice
              ? `USB pull failed: ${msg}`
              : `ADB pull failed: ${msg}`,
          )
          let code =
            normalized instanceof AdbNotFoundError || normalized?.code === 'adb-not-found'
              ? 'adb-not-found'
              : 'pull-failed'
          let deviceSerial
          if (error instanceof BridgeSaveNotFoundError) {
            code = 'save-not-found'
            deviceSerial = error.deviceSerial
          } else if (error instanceof BridgeNoDeviceError) {
            code = 'no-device'
          }
          sendJson(ws, { type: 'ERROR', code, message: msg, deviceSerial })
        }
        return
      }

      sendJson(ws, {
        type: 'ERROR',
        code: 'unknown-type',
        message: `Unknown message type: ${message?.type ?? '(missing)'}`,
      })
    })
  })
}

/**
 * Start one game's bridge on its own port.
 *
 * Each enabled game gets its own port so that every site keeps connecting the
 * way it always has -- adding a second game must not require redeploying the
 * first game's website.
 */
export function startGameBridge(profile, options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? profile.port
  const uploader = options.uploader ?? NO_UPLOADER
  const version = options.version ?? BRIDGE_VERSION
  const ctx = { profile, uploader, saveWatcher: null }

  // Watch the local save so linked accounts get uploads without the site open.
  // Only worth doing when something can actually receive them.
  if (options.watchSave !== false && uploader !== NO_UPLOADER) {
    void (async () => {
      try {
        const { createSaveWatcher } = await import('./save/save-watcher.mjs')
        ctx.saveWatcher = createSaveWatcher({
          log: message => console.log(`[${profile.id}] ${message}`),
          uploader,
          profile,
        })
        await ctx.saveWatcher.start()
      } catch (error) {
        console.log(`[${profile.id}] Save watching unavailable: ${error?.message || error}`)
      }
    })()
  }

  const server = http.createServer((req, res) => {
    if (!isOriginAllowed(profile, req.headers?.origin)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (handlePrivateNetworkHttp(req, res, { version, game: profile.id })) return
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({
    server,
    // The bridge serves save-file bytes off the user's device, so a page that
    // is not this game's site has no business opening a socket to it. The
    // bridges this replaces accepted any origin.
    verifyClient: ({ origin }) => isOriginAllowed(profile, origin),
  })
  attachWebSocketHandlers(wss, ctx)

  server.listen(port, host, () => {
    // Report the bound port, not the requested one: port 0 means "any free
    // port", so the requested value is not what a client should connect to.
    const bound = server.address()?.port ?? port
    console.log(`[${profile.id}] ${profile.name} listening on http://${host}:${bound}`)
  })

  server.on('error', error => {
    if (error?.code === 'EADDRINUSE') {
      console.error(
        `[${profile.id}] Port ${port} is already in use. `
        + 'Another bridge is probably already running -- close it, or run '
        + '`adb-bridge games list` to see what is enabled.',
      )
    } else {
      console.error(`[${profile.id}] server error:`, error)
    }
    process.exitCode = 1
  })

  return { profile, server, wss, port, close: () => new Promise(r => server.close(r)) }
}
