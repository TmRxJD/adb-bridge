import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { discoverNativeHostSave } from './native-save-discovery.mjs'
import { NO_UPLOADER } from '../upload/uploader-plugin.mjs'

/**
 * Watches the local playerInfo.dat and uploads new runs when the game writes it,
 * so runs reach the tracker without the website being open.
 *
 * The game rewrites the save repeatedly around a round ending, so writes are
 * debounced and passes are serialised — never overlap two uploads.
 */
const DEBOUNCE_MS = 5_000
/** How often to look for the save when it has not been found yet. */
const REDISCOVER_MS = 60_000
/**
 * Emulator saves live inside the emulator, so there is no local file to watch.
 * Those are polled over adb instead — infrequently, since each poll spawns adb.
 */
const EMULATOR_POLL_MS = 60_000

export function createSaveWatcher(options = {}) {
  const log = options.log ?? console.log
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS
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

  async function runUpload(reason) {
    if (stopped) return
    if (!uploader.isAutoUploadEnabled() || !uploader.isLinked()) return
    if (running) {
      pendingWhileRunning = true
      return
    }
    running = true
    try {
      // Prefer the watched file when we have one; otherwise let the uploader
      // acquire it however this machine provides it (native install or adb).
      const bytes = watchedPath
        ? await fsp.readFile(watchedPath)
        : (await uploader.acquireSaveBytes?.({ log, profile }))?.bytes
      if (!bytes) return
      const result = await uploader.upload(bytes, { log, reason, profile })
      for (const message of result?.messages ?? []) {
        log(`Auto-upload (${reason}): ${message}`)
      }
    } catch (error) {
      // Never throw out of the watcher: a transient failure must not kill the bridge.
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
   * No local file means the save is on an emulator. Poll it on a slow timer so
   * emulator users get background uploads too, instead of nothing at all.
   */
  async function emulatorPoll() {
    if (stopped || watcher) return
    if (!uploader.isAutoUploadEnabled() || !uploader.isLinked()) return
    await runUpload('emulator poll')
  }

  return {
    async start() {
      stopped = false
      const attached = await attach()
      if (!attached) {
        log('No local save file; will watch for one and poll any connected emulator.')
      }
      rediscoverTimer = setInterval(() => void sweep(), REDISCOVER_MS)
      if (typeof rediscoverTimer.unref === 'function') rediscoverTimer.unref()
      emulatorTimer = setInterval(() => void emulatorPoll(), EMULATOR_POLL_MS)
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
    /** Exposed so the website can force a pass without waiting for a file event. */
    uploadNow: reason => runUpload(reason ?? 'requested'),
    get watchedPath() {
      return watchedPath
    },
  }
}
