import { getLogLevel, LOG_LEVELS } from './bridge-config.mjs'

/**
 * Whether routine detail (each pull step, each scan) should be printed.
 *
 * ADB_BRIDGE_LOG_LEVEL overrides the stored setting, so a user chasing a problem
 * can run `ADB_BRIDGE_LOG_LEVEL=verbose adb-bridge` without changing config.
 */
export function isVerboseLogging() {
  const fromEnv = String(process.env.ADB_BRIDGE_LOG_LEVEL ?? '').trim().toLowerCase()
  if (LOG_LEVELS.includes(fromEnv)) return fromEnv === 'verbose'
  return getLogLevel() === 'verbose'
}
