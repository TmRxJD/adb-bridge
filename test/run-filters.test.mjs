import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterBattleRuns, MIN_BASELINE_RUNS } from '../plugins/uploader-thetower/run-filters.mjs'
import { normalizeSettings as normalizeUploadFilters } from '../plugins/uploader-thetower/config.mjs'

/**
 * Users asked for control over what uploads. Each filter must actually remove
 * runs, never remove runs it was not asked to, and account for every run it
 * leaves out -- counts are checked here, not just what survives.
 */
const farm = (tier, wave, coins) => ({ tier, wave, coinsEarned: coins, isTournament: false })
const tourney = (tier, wave, coins) => ({ tier, wave, coinsEarned: coins, isTournament: true })

test('defaults upload everything', () => {
  const entries = [farm(21, 9000, 5e12), tourney(12, 300, 1e9), farm(1, 5, 10)]
  const { kept, filtered, coinsNoBaseline } = filterBattleRuns(entries, normalizeUploadFilters({}))
  assert.equal(kept.length, 3)
  assert.deepEqual(filtered, { type: 0, wave: 0, tier: 0, coins: 0 })
  assert.equal(coinsNoBaseline, 0)
})

test('run type keeps only the chosen kind', () => {
  const entries = [farm(21, 9000, 1), tourney(12, 300, 1), tourney(12, 310, 1)]
  const result = filterBattleRuns(entries, normalizeUploadFilters({ runTypes: ['farming'] }))
  assert.deepEqual(result.kept, [entries[0]])
  assert.equal(result.filtered.type, 2)
})

test('minimum wave drops short runs', () => {
  const entries = [farm(21, 99, 1), farm(21, 100, 1), farm(21, 5000, 1)]
  const result = filterBattleRuns(entries, normalizeUploadFilters({ minWave: 100 }))
  assert.deepEqual(result.kept, [entries[1], entries[2]])
  assert.equal(result.filtered.wave, 1)
})

test('tier range applies to farming runs only', () => {
  const entries = [farm(13, 1000, 1), farm(21, 9000, 1), tourney(5, 300, 1)]
  const result = filterBattleRuns(entries, normalizeUploadFilters({ farmingTierMin: 20, farmingTierMax: 23 }))
  assert.deepEqual(result.kept, [entries[1], entries[2]], 'a tournament league is not a plain tier')
  assert.equal(result.filtered.tier, 1)
})

test('coins far below the tier median are dropped, within one run type', () => {
  const normal = Array.from({ length: MIN_BASELINE_RUNS }, () => farm(21, 9000, 100))
  const weak = farm(21, 9000, 10)
  const tournamentAtSameTier = tourney(21, 300, 1)
  const result = filterBattleRuns(
    [...normal, weak, tournamentAtSameTier],
    normalizeUploadFilters({ coinsBelowMedianPct: 50 }),
  )
  assert.equal(result.filtered.coins, 1)
  assert.ok(!result.kept.includes(weak))
  assert.ok(result.kept.includes(tournamentAtSameTier), 'no tournament baseline, so it is kept')
  assert.equal(result.coinsNoBaseline, 1)
})

test('coins far above the median are dropped only when asked', () => {
  const normal = Array.from({ length: MIN_BASELINE_RUNS }, () => farm(21, 9000, 100))
  const huge = farm(21, 9000, 1000)
  const below = filterBattleRuns([...normal, huge], normalizeUploadFilters({ coinsBelowMedianPct: 50 }))
  assert.ok(below.kept.includes(huge))
  const above = filterBattleRuns([...normal, huge], normalizeUploadFilters({ coinsAboveMedianPct: 200 }))
  assert.ok(!above.kept.includes(huge))
  assert.equal(above.filtered.coins, 1)
})

test('a thin history is not a baseline', () => {
  // One short of a baseline in total, counting the low run itself.
  const few = Array.from({ length: MIN_BASELINE_RUNS - 2 }, () => farm(21, 9000, 100))
  const result = filterBattleRuns([...few, farm(21, 9000, 1)], normalizeUploadFilters({ coinsBelowMedianPct: 50 }))
  assert.equal(result.kept.length, MIN_BASELINE_RUNS - 1)
  assert.equal(result.filtered.coins, 0)
  assert.equal(result.coinsNoBaseline, MIN_BASELINE_RUNS - 1)
})

test('unreadable settings mean no filter, never filter everything', () => {
  const normalized = normalizeUploadFilters({ runTypes: 'nonsense', minWave: 'x', farmingTierMin: 30, farmingTierMax: 2 })
  assert.deepEqual(normalized.runTypes, ['farming', 'tournament'])
  assert.equal(normalized.minWave, 0)
  assert.equal(normalized.farmingTierMin, 2, 'a reversed range is swapped, not emptied')
  assert.equal(normalized.farmingTierMax, 30)
})
