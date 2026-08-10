import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/**
 * Allowing an origin grants a website the ability to read save files off this
 * machine, so the validation here is a security boundary, not input tidying.
 */
async function withTempHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-origins-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  try {
    const mod = await import(`../src/origins.mjs?t=${encodeURIComponent(home)}`)
    await run(mod, home)
  } finally {
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('refuses anything that would widen access beyond one site', async () => {
  await withTempHome(({ normalizeOrigin }) => {
    const rejected = [
      ['*', /any website/],
      ['', /required/],
      ['not a url', /not a valid origin/],
      ['file:///etc/passwd', /http:\/\/ or https:\/\//],
      ['ftp://example.com', /http:\/\/ or https:\/\//],
      ['https://example.com/app', /bare origin/],
      ['https://example.com/?x=1', /bare origin/],
    ]
    for (const [input, expected] of rejected) {
      assert.throws(() => normalizeOrigin(input), expected, `should reject ${JSON.stringify(input)}`)
    }
  })
})

test('normalizes to a bare origin', async () => {
  await withTempHome(({ normalizeOrigin }) => {
    assert.equal(normalizeOrigin('https://example.com'), 'https://example.com')
    assert.equal(normalizeOrigin('  https://example.com  '), 'https://example.com')
    assert.equal(normalizeOrigin('http://localhost:5174'), 'http://localhost:5174')
    // A port is part of the origin: a different port is a different site.
    assert.notEqual(normalizeOrigin('http://localhost:5174'), 'http://localhost:5175')
  })
})

test('added origins are additive to the profile, never replacing it', async () => {
  await withTempHome(({ addExtraOrigin, effectiveOrigins }) => {
    const profile = {
      id: 'thetower',
      allowedOrigins: ['https://the-tower-run-tracker.com'],
    }
    addExtraOrigin('thetower', 'https://my-mirror.example')
    const effective = effectiveOrigins(profile)
    assert.ok(effective.includes('https://the-tower-run-tracker.com'), 'built-in must survive')
    assert.ok(effective.includes('https://my-mirror.example'))
  })
})

test('adding twice does not duplicate', async () => {
  await withTempHome(({ addExtraOrigin }) => {
    addExtraOrigin('cifi', 'https://mirror.example')
    assert.deepEqual(addExtraOrigin('cifi', 'https://mirror.example'), ['https://mirror.example'])
  })
})

test('origins are per game', async () => {
  await withTempHome(({ addExtraOrigin, readExtraOrigins }) => {
    // Allowing a site to read one game's save must not silently allow it to
    // read another's.
    addExtraOrigin('thetower', 'https://tower-mirror.example')
    assert.deepEqual(readExtraOrigins('cifi'), [])
  })
})

test('removing withdraws access', async () => {
  await withTempHome(({ addExtraOrigin, removeExtraOrigin, effectiveOrigins }) => {
    addExtraOrigin('cifi', 'https://mirror.example')
    removeExtraOrigin('cifi', 'https://mirror.example')
    assert.deepEqual(effectiveOrigins({ id: 'cifi', allowedOrigins: [] }), [])
  })
})

test('a corrupt origins file denies rather than throwing', async () => {
  await withTempHome(({ readExtraOrigins }, home) => {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'origins.json'), '{ not json')
    // Failing closed matters more than failing loudly: an unreadable allowlist
    // must not become an empty check that lets everything through.
    assert.deepEqual(readExtraOrigins('cifi'), [])
  })
})
