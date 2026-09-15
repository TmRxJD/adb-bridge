import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planTournamentKeepBest, storedRunTimestampMs } from '../plugins/uploader-thetower/run-filters.mjs'

/**
 * "Keep only the highest wave of each tournament": the save's best run wins
 * over the cloud's, the cloud's worse runs are replaced, and nothing outside
 * the tournaments this save touches is ever deleted.
 */
const at = iso => ({ runDate: iso.slice(0, 10), runTime: iso.slice(11, 19) })
const run = (iso, wave, type = 'Tournament') => ({ run: { type, wave: String(wave), ...at(iso) } })
const doc = (id, iso, wave, extra = {}) => ({ $id: id, type: 'Tournament', wave: String(wave), ...at(iso), ...extra })

// 2026-09-16 is a Wednesday: one tournament runs from then until Saturday.
const WED = '2026-09-16T03:00:00Z'
const WED_LATER = '2026-09-17T10:00:00Z'
const PREV_SAT = '2026-09-13T05:00:00Z'

test('a higher wave in the save replaces the stored run', () => {
  const better = run(WED_LATER, 500)
  const plan = planTournamentKeepBest([better], [doc('old', WED, 300)])
  assert.deepEqual(plan.upload, [better])
  assert.deepEqual(plan.replace.map(d => d.$id), ['old'])
  assert.deepEqual(plan.notBest, [])
})

test('a lower wave in the save is not uploaded, and nothing is deleted', () => {
  const worse = run(WED_LATER, 200)
  const plan = planTournamentKeepBest([worse], [doc('kept', WED, 300)])
  assert.deepEqual(plan.upload, [])
  assert.deepEqual(plan.notBest, [worse])
  assert.deepEqual(plan.replace, [])
})

test('an equal wave keeps the run already stored', () => {
  const tie = run(WED_LATER, 300)
  const plan = planTournamentKeepBest([tie], [doc('kept', WED, 300)])
  assert.deepEqual(plan.upload, [])
  assert.deepEqual(plan.replace, [])
})

test('several save runs in one tournament upload only the best', () => {
  const a = run(WED, 250)
  const b = run(WED_LATER, 410)
  const plan = planTournamentKeepBest([a, b], [])
  assert.deepEqual(plan.upload, [b])
  assert.deepEqual(plan.notBest, [a])
})

test('another tournament, deleted runs and farming runs are never touched', () => {
  const farming = run(WED, 50, 'Farming')
  const plan = planTournamentKeepBest(
    [farming, run(WED_LATER, 900)],
    [doc('other-tournament', PREV_SAT, 100), doc('already-gone', WED, 100, { deletedAt: '2026-09-16T04:00:00Z' }), { ...doc('farm', WED, 10), type: 'Farming' }],
  )
  assert.ok(plan.upload.includes(farming), 'a farming candidate uploads untouched')
  assert.deepEqual(plan.replace, [], 'only live tournament runs in the touched tournament are replaced')
})

test('a run time is read as UTC', () => {
  assert.equal(storedRunTimestampMs({ runDate: '2026-09-16', runTime: '00:00:00' }), Date.parse('2026-09-16T00:00:00Z'))
  assert.equal(storedRunTimestampMs({ reportTimestamp: '1789000000000' }), 1789000000000)
})
