/**
 * Builds the list of on-device paths to try for a game's save file.
 *
 * This replaces the hand-written path tables each game's bridge used to carry.
 * The orders below are not arbitrary -- they reproduce what those tables did,
 * because the ordering is the difference between a pull that takes a moment and
 * one that probes a dozen dead paths over a slow USB link first.
 */

/**
 * External-storage roots, in the order worth probing. `/sdcard` and
 * `/storage/emulated/0` are the same place on essentially every device;
 * `/mnt/sdcard` is an older alias some emulators still expose.
 */
const EXTERNAL_ROOTS = [
  '/storage/emulated/0',
  '/sdcard',
  '/mnt/sdcard',
]

/** Where a user who exported their save by hand is likely to have put it. */
const DOWNLOAD_DIRS = [
  '/storage/emulated/0/Download',
  '/sdcard/Download',
  '/storage/emulated/0/Downloads',
  '/sdcard/Downloads',
]

function dedupe(paths) {
  const seen = new Set()
  const out = []
  for (const value of paths) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** Every filename to try, primary first. */
function filenamesFor(profile) {
  return dedupe([profile.saveFilename, ...profile.alternateSaveFilenames])
}

/** `/storage/emulated/0/Android/data/<pkg>/files/<file>` and friends. */
function appDataPaths(profile) {
  const paths = []
  for (const filename of filenamesFor(profile)) {
    for (const pkg of profile.androidPackages) {
      for (const root of EXTERNAL_ROOTS) {
        paths.push(`${root}/Android/data/${pkg}/files/${filename}`)
      }
    }
  }
  return paths
}

/**
 * `/data/data/<pkg>/files/<file>` -- readable only on a rooted device or via
 * `run-as` on a debuggable build. Tried last precisely because it usually
 * fails, and failing costs a round trip.
 */
function internalPaths(profile) {
  const paths = []
  for (const filename of filenamesFor(profile)) {
    for (const pkg of profile.androidPackages) {
      paths.push(`/data/data/${pkg}/files/${filename}`)
    }
  }
  return paths
}

function downloadPaths(profile) {
  const paths = []
  for (const filename of filenamesFor(profile)) {
    for (const dir of DOWNLOAD_DIRS) {
      paths.push(`${dir}/${filename}`)
    }
  }
  return paths
}

/**
 * Order for a physical device over USB: check the Download folder first.
 *
 * This looks backwards -- the app's own directory is where the save really
 * lives -- but on a non-rooted phone `/Android/data` is unreadable to adb on
 * Android 11+, so for most USB users the only file that can be pulled is one
 * they exported themselves. Probing the unreadable path first made every pull
 * wait on a guaranteed failure.
 */
export function buildUsbPullPaths(profile) {
  return dedupe([
    ...downloadPaths(profile),
    ...appDataPaths(profile),
    ...profile.extraDevicePaths,
    ...internalPaths(profile),
  ])
}

/**
 * Order for an emulator: the app directory first.
 *
 * Emulators run a debuggable image where `/Android/data` is readable, so the
 * real save is reachable and there is no reason to probe Download folders that
 * are almost always empty.
 */
export function buildEmulatorPullPaths(profile) {
  return dedupe([
    ...appDataPaths(profile),
    ...profile.extraDevicePaths,
    ...downloadPaths(profile),
    ...internalPaths(profile),
  ])
}

/** Known emulator ADB endpoints worth connecting to before scanning. */
export const KNOWN_EMULATOR_ADB_HOSTS = Object.freeze([
  '127.0.0.1:7555',
  '127.0.0.1:16384',
  '127.0.0.1:5555',
  '127.0.0.1:5556',
  '127.0.0.1:5557',
  '127.0.0.1:5558',
  '127.0.0.1:5559',
  '127.0.0.1:21503',
  '127.0.0.1:62001',
])
