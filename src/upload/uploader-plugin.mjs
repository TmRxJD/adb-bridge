/**
 * Optional per-game upload support.
 *
 * Uploading means parsing one specific game's save format and talking to that
 * game's backend. That cannot be made game-agnostic, and wiring it into the
 * core would drag one game's dependencies -- for The Tower, the Appwrite SDK
 * and the whole platform package -- into the install of every user who only
 * plays a different game.
 *
 * So the core knows only this interface. A profile names a module; if that
 * module is installed, it is loaded and used, and if it is not, the game still
 * works as a plain save bridge. Nothing here imports a game's code.
 *
 * A plugin module must default-export an object with:
 *
 *   isLinked(): boolean
 *     Has the user linked an account for this game?
 *
 *   isAutoUploadEnabled(): boolean
 *     Has the user opted in to background uploads?
 *
 *   acquireSaveBytes({ log }): Promise<{ bytes: Buffer } | null>
 *     Fetch the save when the watcher has no local file to read.
 *
 *   upload(bytes, { log, reason, domains }): Promise<{ messages?: string[] }>
 *     Do the upload. `domains` is the bridge's list of what the user allows
 *     uploading; the bridge owns that setting, not the plugin.
 *     Return human-readable lines to log, if any.
 *     Must not throw for ordinary failures -- report them in messages.
 *
 * And, if it supports linking an account:
 *
 *   describeLink(): object            Safe-to-send link state (never secrets).
 *   link(payload): Promise<object>    Store a link; returns describeLink().
 *   unlink(): Promise<void>
 *   setAutoUpload(enabled): Promise<void>
 *
 * The LINK_ACCOUNT / UNLINK_ACCOUNT / SET_AUTO_UPLOAD / UPLOAD_NOW protocol
 * messages are answered from these. A plugin without them makes the bridge
 * report the feature as unsupported rather than failing the connection.
 */

import { importInstalledPlugin, installPlugin } from './plugin-install.mjs'

/** A plugin that does nothing, used whenever a game has no uploader. */
export const NO_UPLOADER = Object.freeze({
  isLinked: () => false,
  isAutoUploadEnabled: () => false,
  acquireSaveBytes: async () => null,
  upload: async () => ({ messages: [] }),
  supportsLinking: false,
})

/** True when this plugin can link an account, not merely upload. */
export function supportsLinking(uploader) {
  return Boolean(
    uploader &&
    typeof uploader.link === 'function' &&
    typeof uploader.unlink === 'function' &&
    typeof uploader.describeLink === 'function',
  )
}

function isUsable(candidate) {
  return Boolean(
    candidate &&
    typeof candidate.isLinked === 'function' &&
    typeof candidate.isAutoUploadEnabled === 'function' &&
    typeof candidate.upload === 'function',
  )
}

/**
 * Load the uploader a profile names, if it is installed.
 *
 * A missing module is the normal case, not an error: the plugin is an optional
 * peer, so "not installed" simply means this game is a plain save bridge here.
 * A module that is present but broken is worth telling the user about, since
 * they installed it on purpose and would otherwise see uploads silently do
 * nothing.
 *
 * Looks inside adb-bridge's own tree first, then the bridge's plugins folder and
 * the global npm root (see plugin-install.mjs). With `install`, a plugin found
 * nowhere is installed into the plugins folder -- the CLI passes that, so a
 * user who enabled The Tower gets uploads without a second install step.
 *
 * @param {{ install?: boolean }} [options]
 * @returns {Promise<{ uploader: object, error: string|null }>}
 */
export async function loadUploaderForProfile(profile, log = console.log, options = {}) {
  if (!profile?.uploader) return { uploader: NO_UPLOADER, error: null }

  const failed = error => {
    const message = `Upload support for ${profile.name} failed to load: ${error?.message || error}`
    log(message)
    return { uploader: NO_UPLOADER, error: message }
  }

  let loaded
  try {
    loaded = await import(profile.uploader)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') return failed(error)
    try {
      loaded = await importInstalledPlugin(profile.uploader)
      if (!loaded && options.install) {
        await installPlugin(profile.uploader, log)
        loaded = await importInstalledPlugin(profile.uploader)
      }
    } catch (fallbackError) {
      return failed(fallbackError)
    }
    // Still absent without an install request: a plain save bridge, which is normal.
    if (!loaded) return { uploader: NO_UPLOADER, error: null }
  }

  const candidate = loaded?.default ?? loaded
  if (!isUsable(candidate)) {
    const message =
      `Upload support for ${profile.name} ("${profile.uploader}") does not look like an ` +
      'uploader plugin; ignoring it.'
    log(message)
    return { uploader: NO_UPLOADER, error: message }
  }

  return { uploader: serializeUploads(candidate), error: null }
}

/**
 * Run a plugin's uploads one at a time.
 *
 * The watcher and "Upload now" both call upload(). Two passes at once each read
 * the account's existing runs before either wrote, so both uploaded the same
 * new runs: measured, 30 battles became 49 documents with 19 duplicated. Queued,
 * the second pass reads what the first wrote and skips it.
 *
 * Wraps rather than copies, so a plugin's other methods and `this` are untouched.
 */
export function serializeUploads(plugin) {
  let tail = Promise.resolve()
  const upload = (bytes, options) => {
    const run = tail.then(() => plugin.upload(bytes, options))
    tail = run.catch(() => {})
    return run
  }
  return Object.assign(Object.create(plugin), { upload })
}
