import { Client, Databases, Permission, Role } from 'appwrite'
import { decodePlayerInfoSaveBytes } from '@tmrxjd/platform/node'
import {
  buildBotsTrackerImportPayload,
  buildLabsTrackerImportPayload,
  applyUwProgressLevelsToTrackerProgress,
  buildLifetimeTrackerImportPayload,
  buildRelicsTrackerImportPayloadFromSaveRoot,
  buildModulesTrackerImportPayload,
  buildUltimateWeaponsTrackerImportPayload,
  buildCardsTrackerImportPayload,
  buildGuardiansTrackerImportPayload,
  buildVaultTrackerImportPayload,
  extractBotsFromSaveRoot,
  extractLabsFromSaveRoot,
  extractModulesFromSaveRoot,
  extractLifetimeFromSaveRoot,
  extractUltimateWeaponsFromSaveRoot,
  extractCardsFromSaveRoot,
  extractGuardiansFromSaveRoot,
  extractVaultFromSaveRoot,
  extractWorkshopFromSaveRoot,
  resolvePresetSnapshot,
} from '@tmrxjd/platform/tools'
import { readAccountLink } from './account-link.mjs'
import { getUploadDomains } from './config.mjs'

/**
 * Pushes tracked domain data (workshop, labs, …) to the cloud while the website
 * is closed.
 *
 * Each domain is a blob document in the `cloud-saves` database keyed by user id:
 * `{ version, data, createdAt, updatedAt }` where `data` is JSON — see
 * docs/APPWRITE_SCHEMA.md. That makes this an ordinary user-scoped write, no
 * Appwrite function required.
 *
 * READ-MERGE-WRITE is mandatory. A blob holds both save-derived progress AND
 * user-authored values (targets, UI settings) that exist nowhere in the save.
 * Only the keys listed in `saveDerivedKeys` are replaced; everything else is
 * carried through untouched, so a background upload can never wipe a user's
 * configuration.
 */

const CLOUD_SAVES_DATABASE_ID = 'cloud-saves'
const BLOB_VERSION = 1

/**
 * Domains the bridge knows how to derive.
 *
 * `derive` returns the object merged into `data.progress`; anything it does not
 * return is preserved. Add a domain by supplying its collection, its platform
 * extractor, and the exact progress keys that extractor owns.
 */
const DOMAIN_WRITERS = {
  labs: {
    collectionId: 'tracker_labs',
    saveDerivedKeys: ['records'],
    derive(saveRoot, currentProgress) {
      const payload = buildLabsTrackerImportPayload(extractLabsFromSaveRoot(saveRoot))
      const levels = payload?.currentLabLevels
      if (!levels) return null
      const records = currentProgress?.records
      if (!Array.isArray(records)) return null
      // Records carry user fields (startedAt, isFavorite) that the save has no
      // notion of, so update currentLevel in place and leave the rest alone.
      return {
        records: records.map(record => {
          const level = levels[record?.labName]
          return typeof level === 'number' ? { ...record, currentLevel: level } : record
        }),
      }
    },
  },
  modules: {
    collectionId: 'tracker_modules',
    saveDerivedKeys: ['modules'],
    derive(saveRoot, currentProgress) {
      const payload = buildModulesTrackerImportPayload(extractModulesFromSaveRoot(saveRoot))
      const inventory = payload?.inventory
      if (!Array.isArray(inventory)) return null

      // The save owns which modules exist and at what level/quantity, so the
      // list is rebuilt from it. Existing rows keep their id and createdAt so
      // anything referencing a row by id keeps working.
      const existing = new Map(
        (Array.isArray(currentProgress?.modules) ? currentProgress.modules : [])
          .map(row => [`${row?.moduleId}|${row?.rarity}|${row?.level}`, row]),
      )
      const now = new Date().toISOString()

      return {
        modules: inventory.map(entry => {
          const key = `${entry.moduleId}|${entry.rarity}|${entry.level}`
          const prior = existing.get(key)
          // Keep the prior updatedAt when nothing about the row changed, so an
          // unchanged inventory does not rewrite the blob on every pass.
          const unchanged = prior && prior.quantity === entry.quantity
          return {
            id: prior?.id ?? `module-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 8)}`,
            moduleId: entry.moduleId,
            rarity: entry.rarity,
            level: entry.level,
            quantity: entry.quantity,
            createdAt: prior?.createdAt ?? now,
            updatedAt: unchanged ? prior.updatedAt : now,
          }
        }),
      }
    },
  },
  uw: {
    collectionId: 'tracker_uw',
    saveDerivedKeys: ['ultimateWeaponsProgress'],
    derive(saveRoot, currentProgress) {
      const payload = buildUltimateWeaponsTrackerImportPayload(
        extractUltimateWeaponsFromSaveRoot(saveRoot),
      )
      const levels = payload?.statStarts
      const progress = currentProgress?.ultimateWeaponsProgress
      const weapons = currentProgress?.ultimateWeapons
      if (!levels || !progress || !Array.isArray(weapons)) return null
      // Same helper src/services/domain-settings/uw-settings.ts uses, so the
      // bridge and the website produce identical results. It indexes starts by
      // the weapon's stat order and only ever raises a target that sits below
      // its start, so user-authored targets are never lost.
      return {
        ultimateWeaponsProgress: applyUwProgressLevelsToTrackerProgress(levels, progress, weapons),
      }
    },
  },
  relics: {
    collectionId: 'tracker_relics',
    saveDerivedKeys: ['collectedRelics', 'collectedThemes'],
    derive(saveRoot) {
      const payload = buildRelicsTrackerImportPayloadFromSaveRoot(saveRoot)
      if (!payload) return null
      return {
        collectedRelics: payload.collectedRelicIds,
        collectedThemes: payload.collectedThemeNames,
      }
    },
  },
  lifetime: {
    collectionId: 'tracker_lifetime',
    saveDerivedKeys: ['entries'],
    derive(saveRoot, currentProgress) {
      const snapshot = buildLifetimeTrackerImportPayload(extractLifetimeFromSaveRoot(saveRoot))
      if (!snapshot?.date) return null
      // Entries are dated snapshots. Replace the one for today rather than
      // appending, otherwise a one-minute poll would add an entry per pass.
      const entries = Array.isArray(currentProgress?.entries) ? currentProgress.entries : []
      const index = entries.findIndex(entry => entry?.date === snapshot.date)
      const next = [...entries]
      if (index >= 0) next[index] = { ...entries[index], ...snapshot }
      else next.unshift(snapshot)
      return { entries: next }
    },
  },
  cards: {
    collectionId: 'tracker_cards',
    saveDerivedKeys: ['entries'],
    derive(saveRoot) {
      const payload = buildCardsTrackerImportPayload(extractCardsFromSaveRoot(saveRoot))
      return payload?.entries ? { entries: payload.entries } : null
    },
  },
  vault: {
    collectionId: 'tracker_vault',
    // `flips` is user-recorded and has no save equivalent, so it is preserved.
    saveDerivedKeys: ['levels', 'spentKeys'],
    derive(saveRoot) {
      const payload = buildVaultTrackerImportPayload(extractVaultFromSaveRoot(saveRoot))
      if (!payload) return null
      return { levels: payload.levels, spentKeys: payload.spentKeys }
    },
  },
  bots: {
    collectionId: 'tracker_bots',
    saveDerivedKeys: ['levels', 'plusLevels', 'unlocked', 'plusUnlocked', 'labLevels'],
    derive(saveRoot) {
      const payload = buildBotsTrackerImportPayload(extractBotsFromSaveRoot(saveRoot))
      if (!payload) return null
      return {
        levels: payload.levels,
        plusLevels: payload.plusLevels,
        unlocked: payload.unlocked,
        plusUnlocked: payload.plusUnlocked,
        labLevels: payload.labLevels,
      }
    },
  },
  guardian: {
    collectionId: 'tracker_guardians',
    saveDerivedKeys: ['levels'],
    derive(saveRoot) {
      const payload = buildGuardiansTrackerImportPayload(extractGuardiansFromSaveRoot(saveRoot))
      return payload?.levels ? { levels: payload.levels } : null
    },
  },
  workshop: {
    collectionId: 'tracker_workshop',
    saveDerivedKeys: ['levels', 'enhancementLevels'],
    derive(saveRoot, currentProgress) {
      const extract = extractWorkshopFromSaveRoot(saveRoot)
      if (!extract) return null
      // Mirror whichever preset the player currently has selected.
      const activeTab = Number(currentProgress?.activeTab ?? 0)
      const snapshot = resolvePresetSnapshot(extract, activeTab)
      if (!snapshot) return null
      return {
        levels: snapshot.levels,
        enhancementLevels: snapshot.enhancementLevels,
      }
    },
  },
}

export function listSupportedUploadDomains() {
  return Object.keys(DOMAIN_WRITERS)
}

function createDatabases(link) {
  const client = new Client().setEndpoint(link.endpoint).setProject(link.projectId)
  client.setSession(link.sessionSecret)
  return new Databases(client)
}

function decodeSaveRoot(bytes) {
  const decoded = decodePlayerInfoSaveBytes(bytes)
  return decoded?.parsedRoot ?? decoded?.root ?? decoded ?? null
}

async function readBlob(databases, collectionId, userId) {
  try {
    const doc = await databases.getDocument(CLOUD_SAVES_DATABASE_ID, collectionId, userId)
    let parsed = {}
    try {
      parsed = JSON.parse(doc.data || '{}')
    } catch {
      parsed = {}
    }
    return { exists: true, parsed, version: doc.version ?? BLOB_VERSION, createdAt: doc.createdAt }
  } catch (error) {
    if (error?.code === 404) return { exists: false, parsed: {}, version: BLOB_VERSION, createdAt: null }
    throw error
  }
}

/**
 * Upload the domains the user has opted into.
 * @returns {Promise<{ written: string[], skipped: string[], unchanged: string[] }>}
 */
export async function uploadDomainsFromSaveBytes(bytes, options = {}) {
  const link = options.link ?? readAccountLink()
  if (!link?.userId) throw new Error('No tracker account is linked.')

  const log = options.log ?? (() => {})
  const requested = options.domains ?? getUploadDomains()
  const saveRoot = decodeSaveRoot(bytes)
  if (!saveRoot) throw new Error('Could not read the save file.')

  const databases = createDatabases(link)
  const permissions = [
    Permission.read(Role.user(link.userId)),
    Permission.update(Role.user(link.userId)),
    Permission.delete(Role.user(link.userId)),
  ]

  const written = []
  const skipped = []
  const unchanged = []

  for (const domainId of requested) {
    // 'runs' is handled by run-upload.mjs, not as a settings blob.
    if (domainId === 'runs') continue

    const writer = DOMAIN_WRITERS[domainId]
    if (!writer) {
      skipped.push(domainId)
      continue
    }

    try {
      const blob = await readBlob(databases, writer.collectionId, link.userId)
      const currentProgress = blob.parsed?.progress ?? {}
      const derived = writer.derive(saveRoot, currentProgress)
      if (!derived) {
        skipped.push(domainId)
        continue
      }

      const nextProgress = { ...currentProgress, ...derived }
      if (JSON.stringify(nextProgress) === JSON.stringify(currentProgress)) {
        unchanged.push(domainId)
        continue
      }

      const now = new Date().toISOString()
      const nextData = { ...blob.parsed, progress: nextProgress }
      const payload = {
        version: blob.version ?? BLOB_VERSION,
        data: JSON.stringify(nextData),
        createdAt: blob.createdAt ?? now,
        updatedAt: now,
      }

      if (blob.exists) {
        await databases.updateDocument(
          CLOUD_SAVES_DATABASE_ID, writer.collectionId, link.userId, payload,
        )
      } else {
        await databases.createDocument(
          CLOUD_SAVES_DATABASE_ID, writer.collectionId, link.userId, payload, permissions,
        )
      }
      written.push(domainId)
    } catch (error) {
      log(`Domain upload failed for ${domainId}: ${error?.message || error}`)
      skipped.push(domainId)
    }
  }

  if (written.length) log(`Uploaded domain data: ${written.join(', ')}.`)
  return { written, skipped, unchanged }
}
