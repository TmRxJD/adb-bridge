import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { identifyPortOwner, isBridgeCommandLine, parseNetstatListener, portIsFree, stopBridgeOnPort } from '../src/port-owner.mjs'
import { nodeToolCommand, nodeToolEnv } from '../src/node-tools.mjs'

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A real process listening on `port`, run from a file called `scriptName`. */
async function listenerProcess(scriptName, port, dirPrefix = 'port-owner-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), dirPrefix))
  const script = path.join(dir, scriptName)
  fs.writeFileSync(script, `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('up'))\n`)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise(resolve => child.stdout.once('data', resolve))
  return {
    child,
    cleanup() {
      try { child.kill() } catch { /* already gone */ }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('netstat output yields the listening pid for exactly that port', () => {
  const output = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:437910       0.0.0.0:0              LISTENING       11',
    '  TCP    127.0.0.1:43791        127.0.0.1:50000        ESTABLISHED     22',
    '  TCP    127.0.0.1:43791        0.0.0.0:0              LISTENING       33',
  ].join('\r\n')
  assert.equal(parseNetstatListener(output, 43791), 33)
  assert.equal(parseNetstatListener(output, 1), null)
})

test('only a bridge entry script or executable counts as a bridge', () => {
  // Real command lines: the running Volta daemon, a global Unix bin link, the
  // tray, and each old per-game bridge.
  for (const line of [
    '"node"   "C:\\Users\\u\\AppData\\Local\\Volta\\tools\\image\\packages\\adb-bridge\\node_modules\\adb-bridge\\bin\\adb-bridge.js" --daemon --skip-intro --no-boot',
    'node /usr/local/bin/adb-bridge --daemon',
    '"C:\\Users\\u\\AppData\\Local\\adb_bridge_tray\\app-0.1.0\\adb-bridge-tray.exe"',
    '"C:\\Program Files\\ADB Bridge\\ADB Bridge.exe" --hidden',
    'node C:\\npm\\node_modules\\cifi-bridge\\bin\\cifi-bridge.js',
    'node /home/u/.npm/_npx/1/node_modules/tracker-bridge/bin/tracker-bridge.js',
  ]) assert.equal(isBridgeCommandLine(line), true, line)

  // The known-bad case the clean-room test caught: "adb-bridge" in a folder
  // name, running something that is not a bridge.
  for (const line of [
    'node C:\\Users\\u\\AppData\\Local\\Temp\\adb-bridge-sandbox-sAwBPG\\some-other-server.js',
    'node C:\\Projects\\adb-bridge\\scripts\\dev-server.js',
    'code C:\\Projects\\cifi-bridge-notes\\README.md',
    'node adb-bridge-helper.js',
  ]) assert.equal(isBridgeCommandLine(line), false, line)
})

test('an old per-game bridge holding the port is identified and stopped', async () => {
  const port = await freePort()
  const old = await listenerProcess('cifi-bridge.js', port)
  try {
    const owner = await identifyPortOwner(port)
    assert.equal(owner.kind, 'bridge')
    assert.equal(owner.pid, old.child.pid)
    assert.equal(owner.version, null)
    assert.equal(await stopBridgeOnPort(owner, port, () => {}), true)
    assert.equal(await portIsFree(port), true)
  } finally {
    old.cleanup()
  }
})

test('an unrelated program on the port is reported, never stopped', async () => {
  // The known-bad case the takeover must refuse: killing whatever happens to
  // hold the port would take down someone's other software.
  const port = await freePort()
  // Under a folder whose name contains "adb-bridge", exactly as the sandbox
  // had it -- the substring match stopped this process.
  const other = await listenerProcess('some-other-server.js', port, 'adb-bridge-sandbox-')
  try {
    const owner = await identifyPortOwner(port)
    assert.equal(owner.kind, 'other')
    assert.equal(await stopBridgeOnPort(owner, port, () => {}), false)
    assert.equal(other.child.exitCode, null)
    assert.equal(await portIsFree(port), false)
  } finally {
    other.cleanup()
  }
})

test('an npx-launched bin runs with node absent from PATH', () => {
  // npx starts a package bin through a .cmd shim that calls plain `node`. With
  // only the absolute node path this failed "'node' is not recognized" -- the
  // 0.6.0 auto-update handoff on machines started by the launcher.
  const { command, args } = nodeToolCommand('npx', ['--no-install', 'semver', '1.2.3'])
  const stripped = { ...process.env }
  for (const key of Object.keys(stripped)) if (key.toUpperCase() === 'PATH') stripped[key] = ''
  // The failure being fixed, reproduced -- so this test cannot pass vacuously.
  assert.throws(() => execFileSync(command, args, { env: stripped, encoding: 'utf8', stdio: 'pipe' }))
  const out = execFileSync(command, args, { env: nodeToolEnv(stripped), encoding: 'utf8' })
  assert.equal(out.trim(), '1.2.3')
})

test('npm runs through the node binary with no PATH and no shell', () => {
  const { command, args } = nodeToolCommand('npm', ['--version'])
  assert.equal(command, process.execPath)
  const out = execFileSync(command, args, { env: { ...process.env, PATH: '', Path: '' }, encoding: 'utf8' })
  assert.match(out.trim(), /^\d+\.\d+\.\d+/)
})
