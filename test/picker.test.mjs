import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { parseGameSelection } from '../src/games/picker.mjs'

const IDS = ['cifi', 'thetower']

test('selection accepts numbers, ids, commas and "all"', () => {
  assert.deepEqual(parseGameSelection('1', IDS), ['cifi'])
  assert.deepEqual(parseGameSelection('2 1', IDS), ['thetower', 'cifi'])
  assert.deepEqual(parseGameSelection('1,2,1', IDS), ['cifi', 'thetower'])
  assert.deepEqual(parseGameSelection(' all ', IDS), IDS)
  assert.deepEqual(parseGameSelection('TheTower', IDS), ['thetower'])
})

test('anything not fully understood re-asks instead of guessing', () => {
  assert.equal(parseGameSelection('', IDS), null)
  assert.equal(parseGameSelection('3', IDS), null)
  assert.equal(parseGameSelection('1 x', IDS), null)
  assert.equal(parseGameSelection('0', IDS), null)
})

test('the picker makes the enabled set exactly what was chosen', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-picker-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  try {
    const tag = `?t=${encodeURIComponent(home)}`
    const { pickGames } = await import(`../src/games/picker.mjs${tag}`)
    const state = await import('../src/bridge-state.mjs')
    state.enableGame('thetower')

    const input = new PassThrough()
    const output = new PassThrough()
    const lines = []
    const done = pickGames({ input, output, log: line => lines.push(line) })
    // Both typed at once, the way a paste arrives. A typo first -- it must
    // re-ask, not enable something -- and the second line must not be dropped.
    input.write('9\n1\n')
    assert.deepEqual(await done, ['cifi'])
    assert.deepEqual(state.readEnabledGameIds(), ['cifi'])
    assert.ok(lines.some(line => /Didn't catch that/.test(line)))
  } finally {
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
