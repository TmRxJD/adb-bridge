/**
 * The user's upload rules, applied to battle-history entries from the save.
 *
 * Every run left out is counted by reason and returned: a rule that drops runs
 * without saying so looks exactly like a bridge that failed to upload.
 *
 * Farming and tournament runs have separate rules. Tournament difficulty is a
 * league ("tier +"), not a plain tier, so tier and coin rules never touch a
 * tournament run; a tournament's own rules are its minimum wave and keeping only
 * its highest wave (see run-upload.mjs, which needs the cloud to decide that).
 *
 * The coin baseline is the median coins per run among the save's own farming
 * runs at that tier. Fewer than MIN_BASELINE_RUNS runs means no baseline: those
 * runs are kept, and counted as `coinsNoBaseline`.
 */
export const MIN_BASELINE_RUNS = 5

const DAY_MS = 24 * 60 * 60 * 1000
/** Tournaments start every Wednesday and Saturday at 00:00 UTC (tower-oracle `tournament`). */
const TOURNAMENT_START_WEEKDAYS = new Set([3, 6])

function readRun(entry) {
  // `coinsEarnedThisRound` is the newer builds' key for the same value; the SDK's
  // normalizeBattleHistorySaveEntry maps it the same way.
  const coins = entry?.coinsEarned ?? entry?.coinsEarnedThisRound
  return {
    tier: Number(entry?.tier),
    wave: Number(entry?.wave),
    coins: coins == null ? Number.NaN : Number(coins),
    type: entry?.isTournament === true ? 'tournament' : 'farming',
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * @param {object[]} entries battle-history entries
 * @param {object} [settings] normalised settings (config.mjs normalizeSettings)
 */
export function filterBattleRuns(entries, settings) {
  const s = settings ?? {}
  const runs = entries.map(entry => ({ entry, ...readRun(entry) }))

  const coinGroups = new Map()
  for (const run of runs) {
    if (run.type !== 'farming' || !Number.isFinite(run.coins) || !Number.isFinite(run.tier)) continue
    coinGroups.set(run.tier, [...(coinGroups.get(run.tier) ?? []), run.coins])
  }

  const filtered = { farmingWave: 0, farmingTier: 0, coins: 0, tournamentWave: 0 }
  let coinsNoBaseline = 0
  const kept = []

  for (const run of runs) {
    if (run.type === 'tournament') {
      if (s.tournamentMinWaveOn && !(run.wave >= s.tournamentMinWave)) {
        filtered.tournamentWave += 1
        continue
      }
      kept.push(run.entry)
      continue
    }
    if (s.farmingMinWaveOn && !(run.wave >= s.farmingMinWave)) {
      filtered.farmingWave += 1
      continue
    }
    if (
      s.farmingTierOn
      && ((s.farmingTierMin != null && !(run.tier >= s.farmingTierMin))
        || (s.farmingTierMax != null && !(run.tier <= s.farmingTierMax)))
    ) {
      filtered.farmingTier += 1
      continue
    }
    if (s.coinsOutlierOn && s.coinsOutlierPct > 0) {
      const sample = coinGroups.get(run.tier) ?? []
      if (sample.length < MIN_BASELINE_RUNS || !Number.isFinite(run.coins)) {
        coinsNoBaseline += 1
      } else {
        const baseline = median(sample)
        if (Math.abs(run.coins - baseline) > baseline * (s.coinsOutlierPct / 100)) {
          filtered.coins += 1
          continue
        }
      }
    }
    kept.push(run.entry)
  }

  return { kept, filtered, coinsNoBaseline }
}

/**
 * Start of the tournament a moment belongs to: the most recent Wednesday or
 * Saturday 00:00 UTC at or before it. A run that finishes after its tournament's
 * 24 hours still belongs to it, because the next start is days away.
 *
 * @param {number} ms epoch milliseconds
 * @returns {number | null}
 */
export function tournamentWindowStartMs(ms) {
  if (!Number.isFinite(ms)) return null
  let dayStart = Math.floor(ms / DAY_MS) * DAY_MS
  for (let step = 0; step < 7; step += 1) {
    if (TOURNAMENT_START_WEEKDAYS.has(new Date(dayStart).getUTCDay())) return dayStart
    dayStart -= DAY_MS
  }
  return null
}

/** When a stored or about-to-be-stored run happened. runDate/runTime are UTC (see the SDK's dedup keys). */
export function storedRunTimestampMs(run) {
  const reported = Number(run?.reportTimestamp)
  if (Number.isFinite(reported) && reported > 0) return reported
  const parsed = Date.parse(`${run?.runDate ?? ''}T${run?.runTime ?? ''}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

const isTournamentRun = run => String(run?.type ?? '').toLowerCase() === 'tournament'

/**
 * "Keep only the highest wave of each tournament", decided against the cloud.
 *
 * Only tournaments this save has a new run for are touched. In each, the best
 * run across the cloud and the save wins; an equal wave keeps the run already
 * stored. Everything else in that tournament is either not uploaded or, if it
 * is already stored, replaced (soft-deleted after the winner is written).
 *
 * @param {Array<{ run: object }>} candidates runs about to upload (built run data)
 * @param {object[]} storedDocs the account's stored runs
 * @returns {{ upload: object[], notBest: object[], replace: object[] }}
 *   `upload` holds every non-tournament candidate too, untouched.
 */
export function planTournamentKeepBest(candidates, storedDocs) {
  const upload = []
  const tournamentCandidates = []
  for (const candidate of candidates) {
    const windowStart = isTournamentRun(candidate.run) ? tournamentWindowStartMs(storedRunTimestampMs(candidate.run)) : null
    if (windowStart == null) upload.push(candidate)
    else tournamentCandidates.push({ candidate, windowStart, wave: Number(candidate.run.wave), stored: false })
  }
  const touched = new Set(tournamentCandidates.map(item => item.windowStart))
  const storedInTouched = storedDocs
    .filter(doc => isTournamentRun(doc) && !doc.deletedAt)
    .map(doc => ({ doc, windowStart: tournamentWindowStartMs(storedRunTimestampMs(doc)), wave: Number(doc.wave), stored: true }))
    .filter(item => touched.has(item.windowStart))

  // Stored runs go first so a tie keeps what is already there.
  const { best, rest } = bestRunPerTournament([...storedInTouched, ...tournamentCandidates])
  for (const winner of best.values()) {
    if (!winner.stored) upload.push(winner.candidate)
  }
  const notBest = rest.filter(item => !item.stored).map(item => item.candidate)
  const replace = rest.filter(item => item.stored).map(item => item.doc)
  return { upload, notBest, replace }
}

/**
 * Split tournament runs into the best of each tournament and the rest.
 *
 * @template T
 * @param {Array<T & { windowStart: number | null, wave: number }>} runs
 * @returns {{ best: Map<number, T>, rest: T[] }} runs with no window are left in neither
 */
export function bestRunPerTournament(runs) {
  const best = new Map()
  const rest = []
  for (const run of runs) {
    if (run.windowStart == null) continue
    const current = best.get(run.windowStart)
    if (!current || run.wave > current.wave) {
      if (current) rest.push(current)
      best.set(run.windowStart, run)
    } else {
      rest.push(run)
    }
  }
  return { best, rest }
}
