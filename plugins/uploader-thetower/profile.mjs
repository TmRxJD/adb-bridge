import { findGameProfile } from 'adb-bridge'

/**
 * The Tower's game profile, read from adb-bridge rather than restated here.
 *
 * Save paths and package ids belong to exactly one place. Keeping a second copy
 * in this package is how the two drift, and a drifted path shows up as "no save
 * found" long after the change that caused it.
 *
 * Resolved lazily: a user profile can override the built-in, and that override
 * should apply here too.
 */
export function towerProfile() {
  const profile = findGameProfile('thetower')
  if (!profile) {
    throw new Error(
      'The Tower profile is missing from adb-bridge. Reinstall adb-bridge, or check ' +
      '~/.adb-bridge/games/ for a thetower.json that fails to load.',
    )
  }
  return profile
}
