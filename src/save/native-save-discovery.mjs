import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bytesLookLikeSaveFile } from './save-bytes.mjs'

/**
 * Finds a game's save in a *desktop* install (macOS app, Steam) when there is
 * no Android device attached.
 *
 * Every location here is specific to one game's bundle id and folder layout,
 * so it is driven by the optional `nativeHost` block of a game profile. A game
 * with no such block -- an Android-only game -- simply has no desktop save to
 * find, and discovery returns nothing rather than guessing.
 */

/** Depth cap for the bounded fallback walk (container Data trees are shallow). */
const MAC_WALK_MAX_DEPTH = 6

/**
 * @param {object} profile A normalized game profile.
 * @returns {object|null} Resolved lookup descriptor, or null when unsupported.
 */
function describeNativeHost(profile) {
  const nativeHost = profile?.nativeHost
  if (!nativeHost?.macBundleId) return null
  return {
    bundleId: nativeHost.macBundleId,
    label: nativeHost.label || `macOS (${profile.name})`,
    // The preferences plist a sandboxed app writes is the strongest
    // "this really is that game's container" signal.
    prefsPlist: `${nativeHost.macBundleId}.plist`,
    saveFilenameLower: profile.saveFilename.toLowerCase(),
    // Application Support layouts: bundle-id folder, or publisher/title.
    appSupportSubdirs:
      nativeHost.appSupportSubdirs?.length
        ? nativeHost.appSupportSubdirs
        : [[nativeHost.macBundleId]],
    // Lowercase substrings used to spot a differently-named Application
    // Support folder during the bounded fallback walk.
    appSupportNameHints:
      nativeHost.appSupportNameHints?.length
        ? nativeHost.appSupportNameHints.map(hint => hint.toLowerCase())
        : [nativeHost.macBundleId.toLowerCase()],
  }
}

/**
 * The three directories inside a sandbox container's `Data/` dir that may hold the save,
 * in the order the game is most likely to use them.
 * @param {string} dataDir absolute path to a container's `Data` directory
 * @returns {string[]}
 */
function containerSaveDirs(desc, dataDir) {
  return [
    path.join(dataDir, 'Documents'),
    ...desc.appSupportSubdirs.map(segments =>
      path.join(dataDir, 'Library', 'Application Support', ...segments),
    ),
  ]
}

/** Non-sandboxed / Steam-style save dirs directly under ~/Library/Application Support. */
function nonSandboxedSaveDirs(desc, home) {
  return desc.appSupportSubdirs.map(segments =>
    path.join(home, 'Library', 'Application Support', ...segments),
  )
}

function canonicalContainerDir(desc, home) {
  return path.join(home, 'Library', 'Containers', desc.bundleId)
}

/**
 * Candidate on-disk save locations for the simple (non-darwin) case, plus the static
 * canonical macOS container paths. Darwin discovery also enumerates UUID containers and
 * runs a bounded search — see {@link discoverNativeHostPlayerInfoSave}.
 * @returns {Array<{ source: string, absolutePath: string }>}
 */
export function buildNativeHostSaveCandidates(profile, platform = process.platform) {
  const home = os.homedir()
  const candidates = []
  const saveFilename = profile.saveFilename
  const desc = describeNativeHost(profile)

  // A game with no nativeHost block has no desktop install to look in; the
  // Android emulator paths below still apply, since those are derived from the
  // package id every profile has.
  if (platform === 'darwin' && desc) {
    const dataDir = path.join(canonicalContainerDir(desc, home), 'Data')
    const dirs = [...containerSaveDirs(desc, dataDir), ...nonSandboxedSaveDirs(desc, home)]
    for (const dir of dirs) {
      candidates.push({ source: desc.label, absolutePath: path.join(dir, saveFilename) })
    }
  }

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    // Windows Subsystem for Android installs the APK as an MSIX package; the
    // publisher suffix is constant for WSA-sideloaded apps.
    for (const pkg of profile.androidPackages) {
      for (const tail of [[saveFilename], ['files', saveFilename]]) {
        candidates.push({
          source: 'Windows (app data)',
          absolutePath: path.join(
            localAppData, 'Packages', `${pkg}_8wekyb3d8bbwe`, 'LocalState', ...tail,
          ),
        })
      }
    }
  }

  if (platform === 'linux') {
    // Waydroid and Anbox expose the Android filesystem on the host, so the
    // save sits at the same in-Android path under a container root.
    const containerRoots = [
      path.join(home, '.local', 'share', 'waydroid', 'data', 'media', '0'),
      path.join(home, '.var', 'lib', 'waydroid', 'data', 'media', '0'),
      path.join(home, 'anbox-data', 'data', 'media', '0'),
      path.join('/var', 'lib', 'anbox', 'rootfs', 'data', 'media', '0'),
    ]
    for (const root of containerRoots) {
      for (const pkg of profile.androidPackages) {
        candidates.push({
          source: 'Linux (Waydroid/Anbox)',
          absolutePath: path.join(root, 'Android', 'data', pkg, 'files', saveFilename),
        })
      }
    }
  }

  const seen = new Set()
  return candidates.filter(entry => {
    if (seen.has(entry.absolutePath)) return false
    seen.add(entry.absolutePath)
    return true
  })
}

async function readIfValidSave(absolutePath) {
  try {
    const bytes = await fs.readFile(absolutePath)
    if (bytesLookLikeSaveFile(bytes)) {
      return bytes
    }
  } catch {
    // missing or unreadable
  }
  return null
}

async function pathExists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve playerInfo.dat inside a directory, case-insensitively (macOS volumes are usually
 * case-insensitive, but Steam / external volumes may not be). Returns the real filename path.
 * @returns {Promise<string | null>}
 */
async function resolveSaveInDir(desc, dir) {
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const match = entries.find(name => name.toLowerCase() === desc.saveFilenameLower)
  return match ? path.join(dir, match) : null
}

/**
 * A container's Data dir "is The Tower's" when it carries the app's preferences plist, or —
 * failing that — the save file itself sits in one of the known sub-paths.
 */
async function isGameDataDir(desc, dataDir) {
  const plist = path.join(dataDir, 'Library', 'Preferences', desc.prefsPlist)
  if (await pathExists(plist)) return true
  for (const dir of containerSaveDirs(desc, dataDir)) {
    if (await resolveSaveInDir(desc, dir)) return true
  }
  return false
}

/**
 * Non-Mac-App-Store builds get a random-UUID container name instead of the bundle id.
 * Enumerate ~/Library/Containers/*, skip the canonical one, keep any whose Data dir is
 * The Tower's.
 * @returns {Promise<string[]>} absolute paths to matching container directories
 */
async function findUuidGameContainerDirs(desc, home) {
  const containersRoot = path.join(home, 'Library', 'Containers')
  let entries
  try {
    entries = await fs.readdir(containersRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const matches = []
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (entry.name === desc.bundleId) continue
    const containerDir = path.join(containersRoot, entry.name)
    const dataDir = path.join(containerDir, 'Data')
    if (await isGameDataDir(desc, dataDir)) {
      matches.push(containerDir)
    }
  }
  return matches
}

/**
 * Bounded, symlink-resolving, case-insensitive walk for playerInfo.dat under a tight set of
 * roots. Only runs when the known-path scan misses. Returns the first path that reads back as
 * a plausible save.
 * @param {string[]} roots
 * @returns {Promise<string | null>}
 */
async function walkForSave(desc, roots) {
  const visited = new Set()
  const queue = roots.map(dir => ({ dir, depth: 0 }))
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()
    let real
    try {
      real = await fs.realpath(dir)
    } catch {
      continue
    }
    if (visited.has(real)) continue
    visited.add(real)

    let entries
    try {
      entries = await fs.readdir(real, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(real, entry.name)
      if (entry.name.toLowerCase() === desc.saveFilenameLower) {
        const bytes = await readIfValidSave(full)
        if (bytes) return full
      }
      if ((entry.isDirectory() || entry.isSymbolicLink()) && depth < MAC_WALK_MAX_DEPTH) {
        queue.push({ dir: full, depth: depth + 1 })
      }
    }
  }
  return null
}

/** Extra fallback roots under ~/Library/Application Support named like The Tower. */
async function appSupportGameRoots(desc, home) {
  const appSupport = path.join(home, 'Library', 'Application Support')
  let entries
  try {
    entries = await fs.readdir(appSupport, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .filter(entry => desc.appSupportNameHints.some(hint => entry.name.toLowerCase().includes(hint)))
    .map(entry => path.join(appSupport, entry.name))
}

/**
 * macOS-specific discovery: canonical bundle-id container, UUID-named sandbox containers,
 * non-sandboxed installs, then a bounded fallback walk.
 * @returns {Promise<{ source: string, absolutePath: string, bytes: Buffer } | null>}
 */
async function discoverMacSave(desc, home) {
  const uuidContainerDirs = await findUuidGameContainerDirs(desc, home)
  const containerDataDirs = [
    path.join(canonicalContainerDir(desc, home), 'Data'),
    ...uuidContainerDirs.map(dir => path.join(dir, 'Data')),
  ]

  const knownDirs = []
  for (const dataDir of containerDataDirs) {
    knownDirs.push(...containerSaveDirs(desc, dataDir))
  }
  knownDirs.push(...nonSandboxedSaveDirs(desc, home))

  for (const dir of knownDirs) {
    const file = await resolveSaveInDir(desc, dir)
    if (!file) continue
    const bytes = await readIfValidSave(file)
    if (bytes) {
      return { source: desc.label, absolutePath: file, bytes }
    }
  }

  const searchRoots = [
    canonicalContainerDir(desc, home),
    ...uuidContainerDirs,
    ...(await appSupportGameRoots(desc, home)),
  ]
  const found = await walkForSave(desc, searchRoots)
  if (found) {
    const bytes = await readIfValidSave(found)
    if (bytes) {
      return { source: desc.label, absolutePath: found, bytes }
    }
  }
  return null
}

/**
 * Read a game's save from a native Mac/Windows/Linux install (no adb).
 * @param {object} profile A normalized game profile.
 * @returns {Promise<{ source: string, absolutePath: string, bytes: Buffer } | null>}
 */
export async function discoverNativeHostSave(profile, platform = process.platform) {
  if (platform === 'darwin') {
    const desc = describeNativeHost(profile)
    // Android-only game: nothing on this Mac to find.
    if (!desc) return null
    return discoverMacSave(desc, os.homedir())
  }
  for (const candidate of buildNativeHostSaveCandidates(profile, platform)) {
    const bytes = await readIfValidSave(candidate.absolutePath)
    if (bytes) {
      return {
        source: candidate.source,
        absolutePath: candidate.absolutePath,
        bytes,
      }
    }
  }
  return null
}

export function formatNativeHostPullResult(native) {
  return {
    remotePath: `native:${native.source}:${native.absolutePath}`,
    deviceSerial: 'native-host',
    base64: native.bytes.toString('base64'),
    byteLength: native.bytes.byteLength,
    deviceLabel: native.source,
  }
}
