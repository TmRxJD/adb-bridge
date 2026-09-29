import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { identifyPortOwner, parseNetstatListener, portIsFree, stopBridgeOnPort } from '../src/port-owner.mjs'
import { nodeToolCommand } from '../src/node-tools.mjs'

function freePort() {
  return new Promise(resolve => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** A real process listening on `port`, run from a file called `scriptName`. */
async function listenerProcess(scriptName, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'port-owner-'))
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
  const other = await listenerProcess('some-other-server.js', port)
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

test('npm runs through the node binary with no PATH and no shell', () => {
  const { command, args } = nodeToolCommand('npm', ['--version'])
  assert.equal(command, process.execPath)
  const out = execFileSync(command, args, { env: { ...process.env, PATH: '', Path: '' }, encoding: 'utf8' })
  assert.match(out.trim(), /^\d+\.\d+\.\d+/)
})
