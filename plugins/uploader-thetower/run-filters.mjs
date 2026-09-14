/**
 * The user's upload filters, applied to battle-history entries from the save.
 *
 * Every run left out is counted by reason and returned: a filter that drops
 * runs without saying so looks exactly like a bridge that failed to upload.
 *
 * Tournament runs are played in leagues, which are "tier +" difficulty rather
 * than a plain tier, so the tier range applies to farming runs only.
 *
 * The coin baseline is the median coins per run among the save's own battle
 * history, grouped by run type and tier, so a tournament run is never measured
 * against farming runs. Fewer than MIN_BASELINE_RUNS runs in a group means no
 * baseline: those runs are kept, and counted as `coinsNoBaseline`.
 */
export const MIN_BASELINE_RUNS = 5

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
 * @param {object} [filters] normalised upload filters (bridge-config normalizeUploadFilters)
 * @returns {{ kept: object[], filtered: { type: number, wave: number, tier: number, coins: number }, coinsNoBaseline: number }}
 */
export function filterBattleRuns(entries, filters) {
  const f = filters ?? {}
  const runs = entries.map(entry => ({ entry, ...readRun(entry) }))

  const coinGroups = new Map()
  for (const run of runs) {
    if (!Number.isFinite(run.coins) || !Number.isFinite(run.tier)) continue
    const key = `${run.type}|${run.tier}`
    coinGroups.set(key, [...(coinGroups.get(key) ?? []), run.coins])
  }

  const filtered = { type: 0, wave: 0, tier: 0, coins: 0 }
  let coinsNoBaseline = 0
  const kept = []
  const coinFilterOn = f.coinsBelowMedianPct != null || f.coinsAboveMedianPct != null

  for (const run of runs) {
    if (Array.isArray(f.runTypes) && !f.runTypes.includes(run.type)) {
      filtered.type += 1
      continue
    }
    if (f.minWave > 0 && !(run.wave >= f.minWave)) {
      filtered.wave += 1
      continue
    }
    if (
      run.type === 'farming'
      && ((f.farmingTierMin != null && !(run.tier >= f.farmingTierMin))
        || (f.farmingTierMax != null && !(run.tier <= f.farmingTierMax)))
    ) {
      filtered.tier += 1
      continue
    }
    if (coinFilterOn) {
      const sample = coinGroups.get(`${run.type}|${run.tier}`) ?? []
      if (sample.length < MIN_BASELINE_RUNS || !Number.isFinite(run.coins)) {
        coinsNoBaseline += 1
      } else {
        const baseline = median(sample)
        const tooLow = f.coinsBelowMedianPct != null && run.coins < baseline * (1 - f.coinsBelowMedianPct / 100)
        const tooHigh = f.coinsAboveMedianPct != null && run.coins > baseline * (1 + f.coinsAboveMedianPct / 100)
        if (tooLow || tooHigh) {
          filtered.coins += 1
          continue
        }
      }
    }
    kept.push(run.entry)
  }

  return { kept, filtered, coinsNoBaseline }
}
