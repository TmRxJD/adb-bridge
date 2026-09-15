import {
  clearAccountLink,
  describeAccountLink,
  isAccountLinked,
  readAccountLink,
  writeAccountLink,
} from './account-link.mjs'
import { exchangeLinkToken, revokeBridgeSession } from './session-exchange.mjs'
import {
  SETTINGS_SCHEMA,
  isAutoUploadEnabled,
  readSettings,
  setAutoUploadEnabled,
  writeSettings,
} from './config.mjs'
import { acquireSaveBytes, sumCounts, uploadRunsFromSaveBytes } from './run-upload.mjs'

/**
 * The Tower's uploader for adb-bridge.
 *
 * Upload cannot live in adb-bridge itself: it means parsing one game's save
 * format and talking to that game's backend, and doing it in the core would put
 * the Appwrite SDK and the whole tracker platform package into the install of
 * every user who only plays a different game. adb-bridge loads this only when
 * The Tower is enabled and this package is actually present.
 *
 * Implements the contract in adb-bridge's src/upload/uploader-plugin.mjs.
 */

/** Human-readable lines for the bridge to log, built from an upload result. */
function summarize(runs, domains) {
  const messages = []
  if (runs?.uploaded > 0) {
    messages.push(`${runs.uploaded} new run(s) sent to your tracker.`)
  }
  const filteredCount = sumCounts(runs?.filtered)
  if (filteredCount > 0) {
    messages.push(`${filteredCount} run(s) skipped by your upload rules.`)
  }
  if (runs?.replaced > 0) {
    messages.push(`${runs.replaced} tournament run(s) replaced by a higher wave.`)
  }
  if (domains?.written?.length > 0) {
    messages.push(`updated ${domains.written.join(', ')}.`)
  }
  return messages
}

const uploader = {
  isLinked: () => isAccountLinked(),

  isAutoUploadEnabled: () => isAutoUploadEnabled(),

  async setAutoUpload(enabled) {
    setAutoUploadEnabled(enabled)
  },

  describeLink: () => describeAccountLink(),

  /** What uploads and how runs are filtered; drawn by the tray's settings window. */
  settingsSchema: SETTINGS_SCHEMA,
  getSettings: () => readSettings(),
  async setSettings(patch) {
    return writeSettings(patch)
  },

  /**
   * Exchange the website's one-time link token for this bridge's own session.
   *
   * The session grants full account access, so account-link.mjs writes it 0600
   * and ACL-restricts it on Windows. It appears in the account's session list
   * and can be revoked there, or by unlinking.
   */
  async link(payload) {
    const exchanged = await exchangeLinkToken({
      endpoint: payload?.endpoint,
      projectId: payload?.projectId,
      userId: payload?.linkToken?.userId,
      secret: payload?.linkToken?.secret,
    })
    // Replacing an existing link: drop the old session rather than orphaning it.
    const previous = readAccountLink()
    writeAccountLink({
      endpoint: payload.endpoint,
      projectId: payload.projectId,
      sessionSecret: exchanged.sessionSecret,
      userId: exchanged.userId,
      username: exchanged.username ?? payload?.username,
    })
    if (previous && previous.sessionSecret !== exchanged.sessionSecret) {
      await revokeBridgeSession(previous)
    }
    return describeAccountLink()
  },

  async unlink() {
    await revokeBridgeSession(readAccountLink())
    clearAccountLink()
  },

  acquireSaveBytes: options => acquireSaveBytes(options),

  /**
   * Upload whatever the enabled domains allow, from a save already in hand.
   *
   * Never throws for an ordinary failure: this runs from a file watcher, and a
   * transient Appwrite error must not take the bridge down with it.
   */
  async upload(bytes, options = {}) {
    const log = options.log ?? (() => {})
    const settings = readSettings()
    const domainsEnabled = settings.domains

    let runs = { uploaded: 0, skipped: 0, total: 0 }
    if (domainsEnabled.includes('runs')) {
      try {
        runs = await uploadRunsFromSaveBytes(bytes, { log, filters: settings })
      } catch (error) {
        log(`Run upload failed: ${error?.message || error}`)
      }
    }

    // Opted-in domains ride along on the save already in hand, and are imported
    // lazily so a runs-only user never loads that code path.
    let domains = { written: [], skipped: [], unchanged: [] }
    if (domainsEnabled.some(domain => domain !== 'runs')) {
      try {
        const { uploadDomainsFromSaveBytes } = await import('./domain-upload.mjs')
        domains = await uploadDomainsFromSaveBytes(bytes, { log, domains: domainsEnabled })
      } catch (error) {
        log(`Domain upload failed: ${error?.message || error}`)
      }
    }

    return { ...runs, domains, messages: summarize(runs, domains) }
  },
}

export default uploader
