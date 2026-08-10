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
 *   upload(bytes, { log, reason }): Promise<{ messages?: string[] }>
 *     Do the upload. Return human-readable lines to log, if any.
 *     Must not throw for ordinary failures -- report them in messages.
 */

/** A plugin that does nothing, used whenever a game has no uploader. */
export const NO_UPLOADER = Object.freeze({
  isLinked: () => false,
  isAutoUploadEnabled: () => false,
  acquireSaveBytes: async () => null,
  upload: async () => ({ messages: [] }),
})

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
 * @returns {Promise<{ uploader: object, error: string|null }>}
 */
export async function loadUploaderForProfile(profile, log = console.log) {
  if (!profile?.uploader) return { uploader: NO_UPLOADER, error: null }

  let loaded
  try {
    loaded = await import(profile.uploader)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      return { uploader: NO_UPLOADER, error: null }
    }
    const message = `Upload support for ${profile.name} failed to load: ${error?.message || error}`
    log(message)
    return { uploader: NO_UPLOADER, error: message }
  }

  const candidate = loaded?.default ?? loaded
  if (!isUsable(candidate)) {
    const message =
      `Upload support for ${profile.name} ("${profile.uploader}") does not look like an ` +
      'uploader plugin; ignoring it.'
    log(message)
    return { uploader: NO_UPLOADER, error: message }
  }

  return { uploader: candidate, error: null }
}
