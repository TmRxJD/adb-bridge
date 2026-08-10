import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generateGamesInclude } from '../installer/windows/generate-games.mjs'

/**
 * The installer's game checkboxes and its "which site did this come from?"
 * lookup are generated from the same profiles the bridge uses. Hand-maintaining
 * either would let them drift, and a drifted origin shows up as the wrong game
 * being pre-ticked — which nobody thinks to report as a bug.
 */
function withProfiles(profiles, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gen-'))
  try {
    for (const profile of profiles) {
      fs.writeFileSync(path.join(dir, `${profile.id}.json`), JSON.stringify(profile))
    }
    const out = path.join(dir, 'games.generated.iss')
    const meta = generateGamesInclude(dir, out)
    run(fs.readFileSync(out, 'utf8'), meta)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const TOWER = {
  id: 'thetower',
  name: 'The Tower',
  allowedOrigins: ['https://the-tower-run-tracker.com', 'http://localhost:5174'],
}
const CIFI = { id: 'cifi', name: 'CIFI', allowedOrigins: ['https://tmrxjd.github.io'] }

test('every game gets a checkbox, and none is ticked by default', () => {
  withProfiles([TOWER, CIFI], source => {
    assert.match(source, /Name: "game_thetower".*Flags: unchecked/)
    assert.match(source, /Name: "game_cifi".*Flags: unchecked/)
    // Downloading from the repo should pre-select nothing at all, so the
    // default state has to be "none" rather than "the first one".
    const ticked = [...source.matchAll(/Name: "game_\w+"[^\r\n]*/g)]
      .filter(match => !match[0].includes('unchecked'))
    assert.deepEqual(ticked, [], 'no game may start ticked')
  })
})

test('each game gets its own enable step', () => {
  withProfiles([TOWER, CIFI], source => {
    // Inno wraps a long entry with a trailing backslash, so the command and
    // its Tasks condition land on separate lines.
    assert.match(source, /games add thetower[\s\S]{0,200}?Tasks: game_thetower/)
    assert.match(source, /games add cifi[\s\S]{0,200}?Tasks: game_cifi/)
  })
})

test('a download host maps to the game whose site it is', () => {
  withProfiles([TOWER, CIFI], (source, meta) => {
    assert.match(source, /Host = 'the-tower-run-tracker\.com' then Result := 'game_thetower'/)
    assert.match(source, /Host = 'tmrxjd\.github\.io' then Result := 'game_cifi'/)
    // Ports matter: a dev origin is a different host from the production one.
    assert.ok(meta.hosts.includes('localhost:5174'))
  })
})

test('a host claimed by two games is refused rather than guessed', () => {
  // Whichever branch came first would win, and the wrong game being pre-ticked
  // is a silent failure. Better to break the build.
  assert.throws(
    () =>
      withProfiles(
        [TOWER, { ...CIFI, allowedOrigins: ['https://the-tower-run-tracker.com'] }],
        () => {},
      ),
    /claimed by both/,
  )
})

test('hosts not belonging to any game map to nothing', () => {
  withProfiles([TOWER, CIFI], source => {
    // github.com is where the repo lives; downloading from there is exactly the
    // case that should leave the choice to the user.
    assert.ok(!source.includes("'github.com'"), 'the repo host must not select a game')
  })
})

test('the real built-in profiles generate without conflicts', () => {
  const builtinDir = path.join(import.meta.dirname, '..', 'src', 'games', 'builtin')
  const out = path.join(os.tmpdir(), `adb-real-${process.pid}.iss`)
  try {
    const meta = generateGamesInclude(builtinDir, out)
    assert.ok(meta.games.includes('thetower'))
    assert.ok(meta.games.includes('cifi'))
    assert.ok(meta.hosts.includes('the-tower-run-tracker.com'))
    assert.ok(meta.hosts.includes('tmrxjd.github.io'))
  } finally {
    fs.rmSync(out, { force: true })
  }
})
