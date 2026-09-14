import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { discoverNativeHostSave } from './native-save-discovery.mjs'
import { probeRemoteSaveStamp } from './pull-save.mjs'
import { NO_UPLOADER } from '../upload/uploader-plugin.mjs'
import { getScanIntervalSeconds } from '../bridge-config.mjs'
import { isVerboseLogging } from '../log-level.mjs'
import { recordSaveRead, recordUpload, recordUploadError } from '../activity.mjs'

/**
 * Watches the local playerInfo.dat and uploads new runs when the game writes it,
 * so runs reach the tracker without the website being open.
 *
 * The game rewrites the save repeatedly around a round ending, so writes are
 * debounced and passes are serialised — never overlap two uploads.
 *
 * A pass that finds the same save as last time does nothing. Emulator saves are
 * checked with a one-line `stat` over adb before anything is pulled, so an idle
 * emulator costs one tiny adb call per scan rather than a full pull and upload.
 */
const DEBOUNCE_MS = 5_000
/** How often to look for the save when it has not been found yet. */
const REDISCOVER_MS = 60_000

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createSaveWatcher(options = {}) {
  const log = options.log ?? console.log
  const verbose = message => {
    if (isVerboseLogging()) log(message)
  }
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
  let scanIntervalMs = options.scanIntervalMs ?? getScanIntervalSeconds() * 1000
  const probeStamp = options.probeRemoteSaveStamp ?? probeRemoteSaveStamp
  // Injected rather than imported: the core must not depend on any one game's
  // save format or backend. See upload/uploader-plugin.mjs.
  const uploader = options.uploader ?? NO_UPLOADER
  const profile = options.profile ?? null

  let watcher = null
  let rediscoverTimer = null
  let emulatorTimer = null
  let debounceTimer = null
  let running = false
  let pendingWhileRunning = false
  let stopped = false
  let lastMtimeMs = 0
  let watchedPath = null
  /** Hash of the last save handed to the uploader. */
  let lastHash = null
  /** Where the last emulator save came from, and its stamp at the time. */
  let lastRemote = null

  /** True when the emulator save is provably the one already processed. */
  async function remoteSaveUnchanged() {
    if (!lastRemote?.stamp) return false
    const stamp = await probeStamp(lastRemote.deviceSerial, lastRemote.remotePath, profile)
    return stamp != null && stamp === lastRemote.stamp
  }

  async function acquire() {
    if (watchedPath) return fsp.readFile(watchedPath)
    const found = await uploader.acquireSaveBytes?.({ log: verbose, profile })
    if (!found?.bytes) return null
    if (found.deviceSerial && found.remotePath) {
      lastRemote = {
        deviceSerial: found.deviceSerial,
        remotePath: found.remotePath,
        stamp: await probeStamp(found.deviceSerial, found.remotePath, profile),
      }
    } else {
      lastRemote = null
    }
    return found.bytes
  }

  /** @param {string} reason @param {{ force?: boolean }} [opts] force: upload even an unchanged save. */
  async function runUpload(reason, opts = {}) {
    if (stopped) return
    if (!uploader.isAutoUploadEnabled() || !uploader.isLinked()) return
    if (running) {
      pendingWhileRunning = true
      return
    }
    running = true
    try {
      if (!opts.force && !watchedPath && (await remoteSaveUnchanged())) {
        verbose(`Scan (${reason}): save unchanged, nothing pulled.`)
        return
      }
      const bytes = await acquire()
      if (!bytes) return
      recordSaveRead(profile?.id)
      const hash = hashBytes(bytes)
      if (!opts.force && hash === lastHash) {
        verbose(`Scan (${reason}): save unchanged, nothing uploaded.`)
        return
      }
      const result = await uploader.upload(bytes, { log, reason, profile })
      lastHash = hash
      recordUpload(profile?.id, result)
      for (const message of result?.messages ?? []) {
        log(`Auto-upload (${reason}): ${message}`)
      }
    } catch (error) {
      // Never throw out of the watcher: a transient failure must not kill the bridge.
      recordUploadError(profile?.id, error)
      log(`Auto-upload failed: ${error?.message || error}`)
    } finally {
      running = false
      if (pendingWhileRunning) {
        pendingWhileRunning = false
        scheduleUpload('queued change')
      }
    }
  }

  function scheduleUpload(reason) {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void runUpload(reason), debounceMs)
  }

  async function onFsEvent() {
    if (!watchedPath) return
    try {
      const stat = await fsp.stat(watchedPath)
      // fs.watch fires several times per save; only react to real content changes.
      if (stat.mtimeMs === lastMtimeMs) return
      lastMtimeMs = stat.mtimeMs
      scheduleUpload('save changed')
    } catch {
      // File replaced mid-write; the next event will pick it up.
    }
  }

  async function attach() {
    if (stopped || watcher) return true
    const found = await discoverNativeHostSave(profile)
    if (!found) return false

    watchedPath = found.absolutePath
    try {
      lastMtimeMs = (await fsp.stat(watchedPath)).mtimeMs
    } catch {
      lastMtimeMs = 0
    }

    try {
      watcher = fs.watch(watchedPath, { persistent: false }, () => void onFsEvent())
      watcher.on('error', () => {
        // Editors/games sometimes replace the inode; re-attach on the next sweep.
        detachWatcher()
      })
    } catch {
      return false
    }

    log(`Watching save file for changes: ${watchedPath}`)
    return true
  }

  function detachWatcher() {
    try {
      watcher?.close()
    } catch {
      // already gone
    }
    watcher = null
  }

  async function sweep() {
    if (stopped) return
    if (!watcher) {
      await attach()
    }
  }

  /**
   * No local file means the save is on an emulator. Check it on a slow timer so
   * emulator users get background uploads too, instead of nothing at all.
   */
  async function emulatorPoll() {
    if (stopped || watcher) return
    if (!uploader.isAutoUploadEnabled() || !uploader.isLinked()) return
    await runUpload('emulator scan')
  }

  return {
    async start() {
      stopped = false
      const attached = await attach()
      if (!attached) {
        verbose('No local save file; will watch for one and check any connected emulator.')
      }
      rediscoverTimer = setInterval(() => void sweep(), REDISCOVER_MS)
      if (typeof rediscoverTimer.unref === 'function') rediscoverTimer.unref()
      emulatorTimer = setInterval(() => void emulatorPoll(), scanIntervalMs)
      if (typeof emulatorTimer.unref === 'function') emulatorTimer.unref()
      return attached
    },
    stop() {
      stopped = true
      clearTimeout(debounceTimer)
      clearInterval(rediscoverTimer)
      clearInterval(emulatorTimer)
      detachWatcher()
    },
    /** Change how often the emulator is checked, taking effect immediately. */
    setScanInterval(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return
      scanIntervalMs = ms
      if (!emulatorTimer) return
      clearInterval(emulatorTimer)
      emulatorTimer = setInterval(() => void emulatorPoll(), scanIntervalMs)
      if (typeof emulatorTimer.unref === 'function') emulatorTimer.unref()
    },
    get scanIntervalMs() {
      return scanIntervalMs
    },
    /** Exposed so the website can force a pass without waiting for a file event. */
    uploadNow: reason => runUpload(reason ?? 'requested', { force: true }),
    /** One ordinary scan: skipped when the save has not changed. */
    scanNow: reason => runUpload(reason ?? 'scan'),
    get watchedPath() {
      return watchedPath
    },
  }
}
