import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function until(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return false
}

test('a running bridge starts and stops games as the enabled list changes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-reload-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  const port = await freePort()
  fs.mkdirSync(path.join(home, 'games'), { recursive: true })
  fs.writeFileSync(path.join(home, 'games', 'reloadgame.json'), JSON.stringify({
    id: 'reloadgame',
    name: 'Reload Game',
    port,
    androidPackages: ['com.example.reloadgame'],
    saveFilename: 'save.dat',
    allowedOrigins: ['https://reload.example'],
  }))
  let bridge
  try {
    const tag = `?t=${encodeURIComponent(home)}`
    const { startBridge } = await import(`../src/bridge.mjs${tag}`)
    const state = await import('../src/bridge-state.mjs')
    bridge = await startBridge({ log: () => {}, watchSave: false, watchConfig: true })
    assert.equal(bridge.running.size, 0)

    // What `adb-bridge games add` does in another terminal -- no restart.
    state.enableGame('reloadgame')
    assert.ok(await until(() => bridge.running.has('reloadgame')), 'the added game never started')
    const reachable = await fetch(`http://127.0.0.1:${port}/private-network-ping`).then(r => r.json())
    assert.equal(reachable.game, 'reloadgame')
    assert.equal(reachable.pid, process.pid)

    state.disableGame('reloadgame')
    assert.ok(await until(() => !bridge.running.has('reloadgame')), 'the removed game kept serving')
  } finally {
    await bridge?.close()
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
