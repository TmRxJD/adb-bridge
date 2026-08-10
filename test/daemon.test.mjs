import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { WebSocket } from 'ws'
import { startGameBridge } from '../src/game-bridge.mjs'
import { normalizeGameProfile } from '../src/games/profile-schema.mjs'

/** Port 0 lets the OS pick a free one, so tests never collide with a real bridge. */
function testProfile(overrides = {}) {
  return normalizeGameProfile({
    id: 'testgame',
    name: 'Test Game',
    port: 45999,
    androidPackages: ['com.example.testgame'],
    saveFilename: 'save.dat',
    allowedOrigins: ['https://allowed.example'],
    ...overrides,
  })
}

const started = []
function start(profile) {
  // watchSave:false -- the watcher would look for a real save on this machine.
  const bridge = startGameBridge(profile, { port: 0, watchSave: false })
  started.push(bridge)
  return bridge
}

function listeningPort(bridge) {
  return new Promise(resolve => {
    if (bridge.server.listening) return resolve(bridge.server.address().port)
    bridge.server.once('listening', () => resolve(bridge.server.address().port))
  })
}

function connect(port, origin) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : undefined)
    ws.on('open', () => resolve({ ok: true, ws }))
    ws.on('error', error => resolve({ ok: false, error }))
  })
}

after(async () => {
  await Promise.all(started.map(bridge => bridge.close()))
})

test('serves each game on its own port', async () => {
  const bridge = start(testProfile())
  const port = await listeningPort(bridge)
  assert.ok(port > 0)
  assert.equal(bridge.profile.id, 'testgame')
})

test('two games run in one process on separate ports', async () => {
  // This is the whole point of the package: adding a game must not mean a
  // second bridge, a second autostart entry and a second adb server.
  const a = start(testProfile({ id: 'gamea', port: 45997 }))
  const b = start(testProfile({ id: 'gameb', port: 45998 }))
  const [portA, portB] = await Promise.all([listeningPort(a), listeningPort(b)])
  assert.notEqual(portA, portB)

  const connA = await connect(portA, 'https://allowed.example')
  const connB = await connect(portB, 'https://allowed.example')
  assert.ok(connA.ok, 'first game should accept a connection')
  assert.ok(connB.ok, 'second game should accept a connection')
  connA.ws.close()
  connB.ws.close()
})

test('an allowed origin can connect', async () => {
  const bridge = start(testProfile({ id: 'allowok', port: 45996 }))
  const port = await listeningPort(bridge)
  const conn = await connect(port, 'https://allowed.example')
  assert.ok(conn.ok, conn.error?.message)
  conn.ws.close()
})

test('a site that is not this game\'s is refused', async () => {
  // The bridges this replaces reflected any Origin back and accepted it, so
  // any page open in the browser could pull the save off the device.
  const bridge = start(testProfile({ id: 'denyme', port: 45995 }))
  const port = await listeningPort(bridge)
  const conn = await connect(port, 'https://evil.example')
  // Close before asserting: if the guard regresses this socket is open, and an
  // open socket keeps the test process alive forever instead of failing.
  conn.ws?.close()
  assert.equal(conn.ok, false, 'a foreign origin must not be able to connect')
})

test('a client sending no Origin still works (native clients, curl)', async () => {
  const bridge = start(testProfile({ id: 'noorigin', port: 45994 }))
  const port = await listeningPort(bridge)
  const conn = await connect(port, null)
  assert.ok(conn.ok, conn.error?.message)
  conn.ws.close()
})

test('the daemon starts only the games that are enabled', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-daemon-'))
  const previous = process.env.ADB_BRIDGE_HOME
  process.env.ADB_BRIDGE_HOME = home
  try {
    const { startBridge } = await import(`../src/bridge.mjs?t=${encodeURIComponent(home)}`)
    const lines = []
    // No games enabled yet: must say so rather than silently doing nothing.
    const empty = await startBridge({ log: line => lines.push(line), watchSave: false })
    assert.deepEqual(empty.bridges, [])
    assert.ok(lines.some(line => /games add/.test(line)), lines.join('\n'))
  } finally {
    if (previous === undefined) delete process.env.ADB_BRIDGE_HOME
    else process.env.ADB_BRIDGE_HOME = previous
    fs.rmSync(home, { recursive: true, force: true })
  }
})
