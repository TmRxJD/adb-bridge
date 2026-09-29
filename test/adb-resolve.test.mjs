import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

/**
 * Points every place adb is looked for at an empty temp tree, so the real
 * machine's adb cannot satisfy the lookup and nothing is downloaded.
 */
async function withIsolatedAdbLookup(env, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-resolve-test-'))
  const keys = ['ADB_PATH', 'LOCAL_ADB_BRIDGE_ADB', 'LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL', 'PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: home, PATH: home, Path: home }, env)
  try {
    const resolve = await import(`../src/adb/adb-resolve.mjs?t=${encodeURIComponent(home)}`)
    await run(resolve)
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

test('a file that exists but is not a working adb is skipped, not returned', async () => {
  // The old lookup returned the first path that existed. Node is a real,
  // runnable binary that is not adb -- exactly the stale-link / wrong-binary case.
  await withIsolatedAdbLookup(
    { ADB_PATH: process.execPath, LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL: '1' },
    async resolve => {
      assert.equal(await resolve.resolveAdbExecutable(), null)
      await assert.rejects(resolve.requireAdbExecutable(() => {}), error => error.code === 'adb-not-found')
    },
  )
})

test('a missing adb tries to install instead of failing on the lookup', async () => {
  // Auto-install is the default: with it disabled the error must say so, which
  // proves the install branch -- not a lookup-only failure -- is what ran.
  await withIsolatedAdbLookup({ LOCAL_ADB_BRIDGE_SKIP_AUTO_INSTALL: '1' }, async resolve => {
    await assert.rejects(resolve.requireAdbExecutable(() => {}), /automatic install is disabled/)
  })
})

test('the not-found message names no retired package and no manual install', async () => {
  await withIsolatedAdbLookup({}, async resolve => {
    const message = resolve.adbNotFoundMessage('offline')
    assert.doesNotMatch(message, /tracker-bridge|cifi-bridge|winget install|PATH before/)
    assert.match(message, /offline/)
  })
})
