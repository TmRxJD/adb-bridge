import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAllGameProfiles } from '../src/games/registry.mjs'
import { discoverAndPullPhysical, pickLargestSaveCandidate, probeRemoteSaveStamp, pullViaRunAsShell, pullViaRunAsStaging } from '../src/save/pull-save.mjs'

const { profiles } = loadAllGameProfiles()
const tower = profiles.get('thetower')
const json = Buffer.from(JSON.stringify({ VersionNumber: 2910, ResearchLevel: [1], padding: 'x'.repeat(80) }))
const dat = Buffer.alloc(4096, 'd')
const pkg = 'com.TechTreeGames.TheTower'
const candidate = (filename, bytes) => ({ remotePath: '/storage/emulated/0/Android/data/' + pkg + '/files/' + filename, bytes })

test('physical Tower selection prefers smaller export over larger legacy bytes', () => {
  const legacy = candidate('playerInfo.dat', dat)
  const exported = candidate('tool_export.json', json)
  assert.equal(pickLargestSaveCandidate([legacy, exported], tower), exported)
  assert.equal(pickLargestSaveCandidate([exported, legacy], tower), exported)
  assert.equal(pickLargestSaveCandidate([legacy, exported]), legacy)
  assert.equal(pickLargestSaveCandidate([legacy, exported], profiles.get('cifi')), legacy)
})

test('physical Tower selection retains legacy fallback filename priority', () => {
  const lowercase = candidate('playerInfo.dat', json)
  const uppercase = candidate('PlayerInfo.dat', dat)
  assert.equal(pickLargestSaveCandidate([uppercase, lowercase], tower), lowercase)
  assert.equal(pickLargestSaveCandidate([uppercase], tower), uppercase)
  assert.equal(pickLargestSaveCandidate([], tower), null)
})

test('real physical discovery wires profile priority into final selection and retains legacy fallback', async () => {
  const legacy = candidate('playerInfo.dat', dat)
  const exported = candidate('tool_export.json', json)
  const deps = {
    discoverInstalledPackages: async () => [pkg],
    pullViaRunAsAll: async () => legacy,
    pullViaSu: async () => exported,
    tryPullPath: async () => null,
    tryAdbRoot: async () => false,
    findSavePaths: async () => [],
  }
  assert.equal(await discoverAndPullPhysical('device', tower, deps), exported)
  assert.equal(await discoverAndPullPhysical('device', tower, { ...deps, pullViaSu: async () => null }), legacy)
  assert.equal(await discoverAndPullPhysical('device', profiles.get('cifi'), deps), legacy)
})

for (const filename of ['tool_export.json', 'playerInfo.dat', 'PlayerInfo.dat']) {
  test('run-as shell labels actual selected ' + filename, async () => {
    const commands = []
    const result = await pullViaRunAsShell('device', [pkg], tower, {
      runAdbBinary: async (_serial, args) => {
        commands.push(args.at(-1))
        if (!args.at(-1).includes('files/' + filename)) throw new Error('missing')
        return filename === 'tool_export.json' ? json : dat
      },
    })
    assert.equal(result.remotePath, 'run-as:' + pkg + '/files/' + filename)
    assert.equal(commands[0], "cat 'files/tool_export.json' 2>/dev/null")
    assert.equal(commands.length, [tower.saveFilename, ...tower.alternateSaveFilenames].indexOf(filename) + 1)
  })

  test('run-as staging labels actual selected ' + filename, async () => {
    let chosen
    const result = await pullViaRunAsStaging('device', [pkg], tower, {
      runAdb: async (_serial, args) => {
        if (args.includes('rm')) return ''
        chosen = args.at(-1)
        if (!chosen.includes('files/' + filename)) throw new Error('missing')
        return ''
      },
      readViaShellCat: async () => filename === 'tool_export.json' ? json : dat,
    })
    assert.ok(chosen.includes('files/' + filename))
    assert.equal(result.remotePath, 'staging-tmp:' + pkg + '/files/' + filename)
  })
}

test('run-as shell checks export across packages before falling back to legacy', async () => {
  const result = await pullViaRunAsShell('device', ['com.old.install', pkg], tower, {
    runAdbBinary: async (_serial, args) => {
      if (args[2] === pkg && args.at(-1).includes('tool_export.json')) return json
      if (args.at(-1).includes('playerInfo.dat')) return dat
      throw new Error('missing')
    },
  })
  assert.equal(result.remotePath, 'run-as:' + pkg + '/files/tool_export.json')
})

test('run-as shell skips invalid export bytes and labels legacy fallback', async () => {
  const result = await pullViaRunAsShell('device', [pkg], tower, {
    runAdbBinary: async (_serial, args) => args.at(-1).includes('tool_export.json') ? Buffer.from('invalid') : dat,
  })
  assert.equal(result.remotePath, 'run-as:' + pkg + '/files/playerInfo.dat')
})

for (const prefix of ['run-as:', 'staging-tmp:']) {
  test(prefix + ' stamp probes the actual legacy file instead of the primary export', async () => {
    let command
    const stamp = await probeRemoteSaveStamp('device', prefix + pkg + '/files/PlayerInfo.dat', tower, {
      runAdb: async (_serial, args) => {
        command = args[1]
        return '2026-10-13 12:00:00:4096'
      },
    })
    assert.equal(stamp, '2026-10-13 12:00:00:4096')
    assert.ok(command.includes('PlayerInfo.dat'))
    assert.ok(!command.includes('tool_export.json'))
  })
}
