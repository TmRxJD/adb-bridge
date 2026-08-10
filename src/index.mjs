/** Public API. The CLI is the usual entry point; this is for embedding. */
export { startBridge } from './bridge.mjs'
export { startGameBridge, BRIDGE_VERSION, DEFAULT_HOST } from './game-bridge.mjs'
export {
  findGameProfile,
  findPortConflicts,
  loadAllGameProfiles,
  configDir,
  userGamesDir,
} from './games/registry.mjs'
export { normalizeGameProfile, ProfileError } from './games/profile-schema.mjs'
export {
  bridgeIsConfigured,
  disableGame,
  enableGame,
  isGameEnabled,
  readEnabledGameIds,
} from './bridge-state.mjs'
export {
  installBootEntry,
  isBootEntryInstalled,
  removeBootEntry,
  removeLegacyBootEntries,
} from './boot-persistence.mjs'
export { NO_UPLOADER, loadUploaderForProfile, supportsLinking } from './upload/uploader-plugin.mjs'
export { buildEmulatorPullPaths, buildUsbPullPaths } from './save/device-paths.mjs'

/**
 * Save acquisition, for uploader plugins.
 *
 * A plugin has to fetch the save itself when the watcher has no local file to
 * read -- an emulator keeps the save inside the emulator, reachable only over
 * adb. Without these a plugin would have to reimplement device discovery, which
 * is exactly the duplication this package exists to remove.
 */
export { pullSave, BridgeNoDeviceError, BridgeSaveNotFoundError } from './save/pull-save.mjs'
export { discoverNativeHostSave } from './save/native-save-discovery.mjs'
