import {
  clearAccountLink,
  describeAccountLink,
  isAccountLinked,
  writeAccountLink,
} from './account-link.mjs'
import {
  getUploadDomains,
  isAutoUploadEnabled,
  setAutoUploadEnabled,
  setUploadDomains,
} from './config.mjs'
import { acquireSaveBytes, uploadRunsFromSaveBytes } from './run-upload.mjs'

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

  /**
   * Store the Appwrite session the website hands over.
   *
   * The secret grants full account access, so account-link.mjs writes it 0600
   * and ACL-restricts it on Windows. The site lists it under Linked devices and
   * can revoke it at any time.
   */
  async link(payload) {
    writeAccountLink({
      endpoint: payload?.endpoint,
      projectId: payload?.projectId,
      sessionSecret: payload?.sessionSecret,
      userId: payload?.userId,
      username: payload?.username,
    })
    return describeAccountLink()
  },

  async unlink() {
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
    const domainsEnabled = getUploadDomains()

    let runs = { uploaded: 0, skipped: 0, total: 0 }
    if (domainsEnabled.includes('runs')) {
      try {
        runs = await uploadRunsFromSaveBytes(bytes, { log })
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
        domains = await uploadDomainsFromSaveBytes(bytes, { log })
      } catch (error) {
        log(`Domain upload failed: ${error?.message || error}`)
      }
    }

    return { ...runs, domains, messages: summarize(runs, domains) }
  },
}

export default uploader
export { getUploadDomains, setUploadDomains }
