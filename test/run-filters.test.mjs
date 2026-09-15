import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MIN_BASELINE_RUNS,
  bestRunPerTournament,
  filterBattleRuns,
  tournamentWindowStartMs,
} from '../plugins/uploader-thetower/run-filters.mjs'
import { normalizeSettings } from '../plugins/uploader-thetower/config.mjs'

/**
 * Users asked for control over what uploads. Each rule must remove the runs it
 * names, only those, only for its run type, and account for every run it
 * leaves out -- counts are checked here, not just what survives.
 */
const farm = (tier, wave, coins) => ({ tier, wave, coinsEarned: coins, isTournament: false })
const tourney = (tier, wave, coins) => ({ tier, wave, coinsEarned: coins, isTournament: true })
const rules = patch => normalizeSettings(patch)

test('a fresh install uploads everything', () => {
  const entries = [farm(21, 9000, 5e12), tourney(12, 300, 1e9), farm(1, 5, 10)]
  const { kept, filtered, coinsNoBaseline } = filterBattleRuns(entries, rules({}))
  assert.equal(kept.length, 3)
  assert.deepEqual(filtered, { farmingWave: 0, farmingTier: 0, coins: 0, tournamentWave: 0 })
  assert.equal(coinsNoBaseline, 0)
})

test('a rule that is off does nothing, even with a value set', () => {
  const entries = [farm(21, 50, 1)]
  const result = filterBattleRuns(entries, rules({ farmingMinWaveOn: false, farmingMinWave: 100 }))
  assert.equal(result.kept.length, 1)
})

test('farming minimum wave skips short farming runs only', () => {
  const entries = [farm(21, 99, 1), farm(21, 100, 1), tourney(12, 40, 1)]
  const result = filterBattleRuns(entries, rules({ farmingMinWaveOn: true, farmingMinWave: 100 }))
  assert.deepEqual(result.kept, [entries[1], entries[2]], 'a short tournament run is not a farming run')
  assert.equal(result.filtered.farmingWave, 1)
})

test('tournament minimum wave skips short tournament runs only', () => {
  const entries = [tourney(12, 150, 1), tourney(12, 250, 1), farm(21, 40, 1)]
  const result = filterBattleRuns(entries, rules({ tournamentMinWaveOn: true, tournamentMinWave: 200 }))
  assert.deepEqual(result.kept, [entries[1], entries[2]])
  assert.equal(result.filtered.tournamentWave, 1)
})

test('tier range applies to farming runs only', () => {
  const entries = [farm(13, 1000, 1), farm(21, 9000, 1), tourney(5, 300, 1)]
  const result = filterBattleRuns(entries, rules({ farmingTierOn: true, farmingTierMin: 20, farmingTierMax: 23 }))
  assert.deepEqual(result.kept, [entries[1], entries[2]], 'a tournament league is not a plain tier')
  assert.equal(result.filtered.farmingTier, 1)
})

test('one coin percentage skips outliers on both sides of the tier median', () => {
  const normal = Array.from({ length: MIN_BASELINE_RUNS }, () => farm(21, 9000, 100))
  const low = farm(21, 9000, 40)
  const high = farm(21, 9000, 200)
  const near = farm(21, 9000, 130)
  const result = filterBattleRuns([...normal, low, high, near], rules({ coinsOutlierOn: true, coinsOutlierPct: 50 }))
  assert.equal(result.filtered.coins, 2)
  assert.ok(!result.kept.includes(low) && !result.kept.includes(high))
  assert.ok(result.kept.includes(near), 'within 50% of the median is kept')
})

test('tournament runs never feed or face the coin rule', () => {
  const normal = Array.from({ length: MIN_BASELINE_RUNS }, () => farm(21, 9000, 100))
  const tournament = tourney(21, 300, 1)
  const result = filterBattleRuns([...normal, tournament], rules({ coinsOutlierOn: true, coinsOutlierPct: 50 }))
  assert.ok(result.kept.includes(tournament))
  assert.equal(result.coinsNoBaseline, 0)
})

test('a thin farming history is not a baseline', () => {
  const few = Array.from({ length: MIN_BASELINE_RUNS - 2 }, () => farm(21, 9000, 100))
  const result = filterBattleRuns([...few, farm(21, 9000, 1)], rules({ coinsOutlierOn: true, coinsOutlierPct: 50 }))
  assert.equal(result.kept.length, MIN_BASELINE_RUNS - 1)
  assert.equal(result.filtered.coins, 0)
  assert.equal(result.coinsNoBaseline, MIN_BASELINE_RUNS - 1)
})

test('a run belongs to the tournament that started on the latest Wednesday or Saturday', () => {
  const at = iso => Date.parse(iso)
  // 2026-09-12 is a Saturday, 2026-09-16 a Wednesday.
  assert.equal(tournamentWindowStartMs(at('2026-09-14T12:00:00Z')), at('2026-09-12T00:00:00Z'))
  assert.equal(tournamentWindowStartMs(at('2026-09-15T23:59:59Z')), at('2026-09-12T00:00:00Z'))
  assert.equal(tournamentWindowStartMs(at('2026-09-16T00:00:00Z')), at('2026-09-16T00:00:00Z'))
  assert.equal(tournamentWindowStartMs(at('2026-09-18T08:00:00Z')), at('2026-09-16T00:00:00Z'))
  assert.equal(tournamentWindowStartMs(at('2026-09-19T00:00:01Z')), at('2026-09-19T00:00:00Z'))
})

test('only the highest wave of each tournament is the best', () => {
  const wed = Date.parse('2026-09-16T00:00:00Z')
  const sat = Date.parse('2026-09-19T00:00:00Z')
  const runs = [
    { id: 'a', windowStart: wed, wave: 300 },
    { id: 'b', windowStart: wed, wave: 450 },
    { id: 'c', windowStart: sat, wave: 200 },
    { id: 'd', windowStart: wed, wave: 410 },
  ]
  const { best, rest } = bestRunPerTournament(runs)
  assert.equal(best.get(wed).id, 'b')
  assert.equal(best.get(sat).id, 'c')
  assert.deepEqual(rest.map(run => run.id).sort(), ['a', 'd'])
})

test('filters saved before the rules existed become farming rules', () => {
  const upgraded = normalizeSettings({ minWave: 250, farmingTierMin: 20, coinsBelowMedianPct: 40, runTypes: ['farming'] })
  assert.equal(upgraded.farmingMinWaveOn, true)
  assert.equal(upgraded.farmingMinWave, 250)
  assert.equal(upgraded.farmingTierOn, true)
  assert.equal(upgraded.coinsOutlierOn, true)
  assert.equal(upgraded.coinsOutlierPct, 40)
  assert.equal(upgraded.tournamentKeepBest, false)
  assert.ok(!('runTypes' in upgraded), 'the old run-type choice is dropped')
})

test('unreadable settings mean no rule, never skip everything', () => {
  const normalized = normalizeSettings({ farmingMinWaveOn: 'yes', farmingMinWave: 'x', farmingTierMin: 30, farmingTierMax: 2 })
  assert.equal(normalized.farmingMinWaveOn, false)
  assert.equal(normalized.farmingMinWave, 100)
  assert.equal(normalized.farmingTierMin, 2, 'a reversed range is swapped, not emptied')
  assert.equal(normalized.farmingTierMax, 30)
})
