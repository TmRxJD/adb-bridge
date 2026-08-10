/**
 * A game profile is the only thing that differs between one game's bridge and
 * another's. Everything else -- device discovery, adb, pulling, serving,
 * autostart, the installer -- is shared.
 *
 * Profiles are plain JSON so a user can add a game by writing a file, with no
 * code and nothing to publish. That means this file is the contract: validate
 * hand-written input properly and say exactly what is wrong, because the person
 * who wrote it has no types and no editor support.
 */

/** Ports are per-game so each site keeps connecting the way it always has. */
const MIN_PORT = 1024
const MAX_PORT = 65535

/** Android package ids are dot-separated segments starting with a letter. */
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/
/** Ids become filenames, config keys and CLI arguments, so keep them boring. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/

class ProfileError extends Error {
  constructor(message, { source } = {}) {
    super(source ? `${message} (in ${source})` : message)
    this.name = 'ProfileError'
    this.source = source
  }
}

function fail(message, source) {
  throw new ProfileError(message, { source })
}

function asStringArray(value, field, source) {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry.trim()) {
      fail(`"${field}" must be a string or array of non-empty strings`, source)
    }
  }
  return list.map(entry => entry.trim())
}

/**
 * Normalize and validate a profile.
 *
 * @param {unknown} input Parsed JSON (or a built-in profile object).
 * @param {{ source?: string, builtin?: boolean }} [options]
 */
export function normalizeGameProfile(input, options = {}) {
  const source = options.source
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('a game profile must be a JSON object', source)
  }

  const id = input.id
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    fail('"id" must be lowercase letters, digits and dashes, e.g. "thetower"', source)
  }

  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : id

  const port = input.port
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    fail(`"port" must be a whole number between ${MIN_PORT} and ${MAX_PORT}`, source)
  }

  const androidPackages = asStringArray(input.androidPackages, 'androidPackages', source)
  if (androidPackages.length === 0) {
    fail('"androidPackages" must list at least one Android package id', source)
  }
  for (const pkg of androidPackages) {
    if (!PACKAGE_RE.test(pkg)) {
      fail(`"${pkg}" does not look like an Android package id (e.g. "com.example.game")`, source)
    }
  }

  const saveFilename = input.saveFilename
  if (typeof saveFilename !== 'string' || !saveFilename.trim()) {
    fail('"saveFilename" is required, e.g. "playerInfo.dat"', source)
  }
  if (saveFilename.includes('/') || saveFilename.includes('\\')) {
    fail('"saveFilename" must be a bare filename, not a path', source)
  }

  // Tried in order after the primary. Covers both spellings seen in the wild
  // (Android's filesystem is case-sensitive, game save writers often are not)
  // and genuine secondary files, like CIFI's rolling backup.
  const alternateSaveFilenames = asStringArray(input.alternateSaveFilenames, 'alternateSaveFilenames', source)
  for (const alternate of alternateSaveFilenames) {
    if (alternate.includes('/') || alternate.includes('\\')) {
      fail(`"alternateSaveFilenames" entries must be bare filenames; got "${alternate}"`, source)
    }
  }

  // Escape hatch: a game that stores its save somewhere the derived paths do
  // not cover can list absolute device paths directly.
  const extraDevicePaths = asStringArray(input.extraDevicePaths, 'extraDevicePaths', source)
  for (const devicePath of extraDevicePaths) {
    if (!devicePath.startsWith('/')) {
      fail(`"extraDevicePaths" entries must be absolute device paths; got "${devicePath}"`, source)
    }
  }

  // Origins allowed to connect to this game's port. Anything not listed is
  // refused: the bridge serves save-file bytes, so it must not be reachable
  // from any page that happens to be open.
  const allowedOrigins = asStringArray(input.allowedOrigins, 'allowedOrigins', source)
  if (allowedOrigins.length === 0) {
    fail('"allowedOrigins" must list at least one site origin allowed to connect', source)
  }
  for (const origin of allowedOrigins) {
    if (origin === '*') {
      fail('"allowedOrigins" cannot be "*" -- the bridge serves save-file bytes', source)
    }
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      fail(`"${origin}" is not a valid origin, e.g. "https://example.com"`, source)
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
      fail(`"${origin}" must be a bare origin with no path or query`, source)
    }
  }

  /**
   * Optional per-game upload support. Deliberately a module name rather than
   * inline config: uploading means parsing a specific game's save and talking
   * to that game's backend, which cannot be game-agnostic and would drag that
   * game's dependencies into everyone else's install. The module is imported
   * only when the game is enabled and the package is actually present.
   */
  let uploader = null
  if (input.uploader !== undefined && input.uploader !== null) {
    if (typeof input.uploader !== 'string' || !input.uploader.trim()) {
      fail('"uploader" must be the name of a Node module to import, if present', source)
    }
    uploader = input.uploader.trim()
  }

  return Object.freeze({
    id,
    name,
    port,
    androidPackages: Object.freeze(androidPackages),
    saveFilename: saveFilename.trim(),
    alternateSaveFilenames: Object.freeze(alternateSaveFilenames),
    extraDevicePaths: Object.freeze(extraDevicePaths),
    allowedOrigins: Object.freeze(allowedOrigins),
    uploader,
    builtin: options.builtin === true,
    source: source ?? null,
  })
}

export { ProfileError }
