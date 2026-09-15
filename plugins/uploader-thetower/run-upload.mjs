import { Account, Client, Databases, ID, Permission, Role, Query } from 'appwrite'
import { decodePlayerInfoSaveBytes } from '@tmrxjd/platform/node'
import {
  buildBattleRunDedupKeyFromBattleEntry,
  buildBattleRunDedupKeyFromStoredRun,
  buildTrackerRunDataFromBattleHistoryEntry,
  buildTrackerRunDocumentPermissions,
  findBattleHistoryItems,
  looksLikeBattleRun,
  softDeleteTrackerRunCloudDocuments,
  writeTrackerRunCloudDocumentPair,
  TRACKER_RUN_COLLECTION_IDS,
} from '@tmrxjd/platform/tools'
import { readAccountLink } from './account-link.mjs'
import { filterBattleRuns, planTournamentKeepBest } from './run-filters.mjs'
import { discoverNativeHostSave, pullSave } from 'adb-bridge'
import { towerProfile } from './profile.mjs'

/**
 * Uploads runs found in playerInfo.dat straight to Appwrite, so imports work
 * while the tracker website is closed.
 *
 * This deliberately calls the SAME canonical helpers the website uses
 * (`buildTrackerRunDataFromBattleHistoryEntry` + `writeTrackerRunCloudDocumentPair`),
 * rather than reimplementing the mapping or the main/extended pair write. See
 * docs/TRACKER_RUN_SYNC_CONTRACT.md — runs must always be written as a pair.
 */

/** Must match RUNS_DATABASE_ID in src/services/runs-cloud.service.ts. */
const RUNS_DATABASE_ID = 'run-tracker-data'
/** Cap per pass so a first-ever link cannot fire hundreds of writes at once. */
const MAX_RUNS_PER_PASS = 100

function createClient(link) {
  const client = new Client().setEndpoint(link.endpoint).setProject(link.projectId)
  // The website hands over its session secret; we act as that user, with that
  // user's own document permissions. No API key is involved.
  client.setSession(link.sessionSecret)
  return client
}

/**
 * Get the current save from wherever this machine actually keeps it.
 *
 * A native install writes a file we can read directly; an emulator keeps the
 * save inside the emulator, reachable only over adb. "Connect to Emulator"
 * already handles the second case, so background uploads must too — otherwise
 * emulator users are told there is no save file when there plainly is one.
 *
 * @returns {Promise<{ bytes: Buffer, source: string } | null>}
 */
export async function acquireSaveBytes(options = {}) {
  const log = options.log ?? (() => {})

  // Native first: it is instant and needs no adb.
  const native = await discoverNativeHostSave(towerProfile())
  if (native) {
    return { bytes: native.bytes, source: native.source }
  }

  if (options.nativeOnly) return null

  // Fall back to the same adb pull the website's emulator button uses.
  try {
    const pulled = await pullSave(towerProfile(), { console: options.console })
    if (pulled?.base64) {
      return {
        bytes: Buffer.from(pulled.base64, 'base64'),
        source: pulled.deviceLabel || pulled.deviceSerial || 'emulator',
        // Lets the watcher check this exact file cheaply next time instead of pulling it again.
        deviceSerial: pulled.deviceSerial,
        remotePath: pulled.remotePath,
      }
    }
  } catch (error) {
    log(`No save available over adb: ${error?.message || error}`)
  }
  return null
}

/** Battle-history entries in the save, newest first, filtered to real runs. */
export function extractBattleRunsFromSave(bytes) {
  const decoded = decodePlayerInfoSaveBytes(bytes)
  const parsedRoot = decoded?.parsedRoot ?? decoded?.root ?? decoded
  const history = findBattleHistoryItems(parsedRoot)
  if (!history) return []
  return history.filter(looksLikeBattleRun).slice(0, MAX_RUNS_PER_PASS)
}

/**
 * A stored session can expire or be revoked. Appwrite then treats us as a guest
 * and rejects the write with "Permissions must be one of: (any, guests)", which
 * says nothing useful. Check first and fail with an actionable message.
 */
async function assertSessionValid(client) {
  try {
    await new Account(client).get()
  } catch {
    throw new Error(
      'This computer is no longer signed in to your tracker account. Open the import page and link this computer again.',
    )
  }
}

/**
 * The account's recent runs, and their dedup keys. Soft-deleted runs keep their
 * key, so a run the user deleted is not uploaded again.
 */
async function fetchRecentRuns(databases, userId) {
  const keys = new Set()
  let docs
  try {
    const res = await databases.listDocuments(RUNS_DATABASE_ID, TRACKER_RUN_COLLECTION_IDS.main, [
      Query.equal('userId', userId),
      Query.limit(100),
      Query.orderDesc('$createdAt'),
    ])
    docs = res?.documents ?? []
  } catch (error) {
    // A failed dedup read must not cause duplicate writes, so surface it.
    throw new Error(`Could not read existing runs for de-duplication: ${error?.message || error}`)
  }
  for (const doc of docs) {
    const key = buildBattleRunDedupKeyFromStoredRun(doc)
    if (key) keys.add(key)
  }
  return { keys, docs }
}

/**
 * Parse the save and upload any runs the account does not already have.
 * @returns {Promise<{uploaded:number, skipped:number, total:number}>}
 */
export async function uploadRunsFromSaveBytes(bytes, options = {}) {
  const link = options.link ?? readAccountLink()
  if (!link) throw new Error('No tracker account is linked. Link this computer from the import page.')
  if (!link.userId) throw new Error('Linked account is missing a user id; re-link from the import page.')

  const log = options.log ?? (() => {})
  const settings = options.filters ?? {}
  const entries = extractBattleRunsFromSave(bytes)
  const { kept, filtered: ruleFiltered, coinsNoBaseline } = filterBattleRuns(entries, settings)
  const filtered = { ...ruleFiltered, tournamentNotBest: 0 }
  if (entries.length === 0) return { uploaded: 0, skipped: 0, replaced: 0, total: 0, filtered, coinsNoBaseline }

  const client = createClient(link)
  await assertSessionValid(client)
  const databases = new Databases(client)
  const { keys: existing, docs: storedDocs } = await fetchRecentRuns(databases, link.userId)

  const username = link.username || 'Unknown'
  // Same helper the website uses, so bridge-written documents carry identical
  // permissions rather than a hand-rolled approximation.
  const permissions = buildTrackerRunDocumentPermissions({
    userIds: [link.userId],
    permissionFactory: Permission,
    roleFactory: Role,
  })

  let uploaded = 0
  let skipped = 0
  let replaced = 0

  const candidates = []
  for (const entry of kept) {
    const dedupKey = buildBattleRunDedupKeyFromBattleEntry(entry)
    if (dedupKey && existing.has(dedupKey)) {
      skipped += 1
      continue
    }
    if (dedupKey) existing.add(dedupKey)
    // No note: an auto-imported run should look exactly like a manual one.
    candidates.push({ run: buildTrackerRunDataFromBattleHistoryEntry(entry, { notePrefix: '' }) })
  }

  let toUpload = candidates
  let toReplace = []
  if (settings.tournamentKeepBest) {
    const plan = planTournamentKeepBest(candidates, storedDocs)
    toUpload = plan.upload
    toReplace = plan.replace
    filtered.tournamentNotBest = plan.notBest.length
  }

  for (const { run } of toUpload) {
    await writeTrackerRunCloudDocumentPair({
      databases,
      databaseId: RUNS_DATABASE_ID,
      runId: ID.unique(),
      userId: link.userId,
      username,
      run: { ...run, userId: link.userId, username },
      permissions,
    })

    uploaded += 1
  }

  // Only after the better run is safely written, so a failure never leaves a
  // tournament with no run at all.
  for (const doc of toReplace) {
    await softDeleteTrackerRunCloudDocuments({
      databases,
      databaseId: RUNS_DATABASE_ID,
      mainCollectionId: TRACKER_RUN_COLLECTION_IDS.main,
      extendedCollectionId: TRACKER_RUN_COLLECTION_IDS.extended,
      runId: doc.$id,
    })
    replaced += 1
  }

  const filteredCount = sumCounts(filtered)
  log(`Uploaded ${uploaded} new run(s); ${skipped} already present; ${filteredCount} skipped by your rules; ${replaced} replaced by a better tournament run.`)
  return { uploaded, skipped, replaced, total: entries.length, filtered, coinsNoBaseline }
}

export function sumCounts(counts) {
  return Object.values(counts ?? {}).reduce((sum, n) => sum + Number(n || 0), 0)
}
