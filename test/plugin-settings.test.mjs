import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  SETTINGS_SCHEMA,
  UPLOAD_DOMAINS,
  readSettings,
  writeSettings,
} from '../plugins/uploader-thetower/config.mjs'
import { normalizeSettingsSchema } from '../src/upload/settings-schema.mjs'

/**
 * The Tower's settings moved from the bridge core into its plugin, so one game's
 * options can no longer leak into another's. What must hold: defaults upload
 * everything, choices persist, a user's choices made before the move survive
 * it, and the schema the tray draws is valid.
 */
function withHome(legacyConfig, run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-bridge-settings-'))
  const legacyPath = path.join(home, 'legacy-config.json')
  if (legacyConfig) fs.writeFileSync(legacyPath, JSON.stringify(legacyConfig))
  const saved = { home: process.env.ADB_BRIDGE_HOME, legacy: process.env.ADB_BRIDGE_LEGACY_CONFIG_PATH }
  process.env.ADB_BRIDGE_HOME = home
  process.env.ADB_BRIDGE_LEGACY_CONFIG_PATH = legacyPath
  try {
    return run()
  } finally {
    for (const [key, value] of [['ADB_BRIDGE_HOME', saved.home], ['ADB_BRIDGE_LEGACY_CONFIG_PATH', saved.legacy]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

const ALL = UPLOAD_DOMAINS.map(domain => domain.value)

test('a fresh install uploads every domain with no filters', () =>
  withHome(null, () => {
    const settings = readSettings()
    assert.deepEqual(settings.domains, ALL)
    assert.deepEqual(settings.runTypes, ['farming', 'tournament'])
    assert.equal(settings.minWave, 0)
  }))

test('choices persist, and are what the next read returns', () =>
  withHome(null, () => {
    writeSettings({ domains: ['runs', 'labs'], minWave: 100 })
    const settings = readSettings()
    assert.deepEqual(settings.domains, ['runs', 'labs'])
    assert.equal(settings.minWave, 100)
  }))

test('choices made in the bridge core before the move are kept', () =>
  withHome({ disabledDomains: ['vault', 'bots'], uploadFilters: { minWave: 250, runTypes: ['farming'] } }, () => {
    const settings = readSettings()
    assert.ok(!settings.domains.includes('vault') && !settings.domains.includes('bots'))
    assert.ok(settings.domains.includes('relics'), 'a domain nobody turned off stays on')
    assert.equal(settings.minWave, 250)
    assert.deepEqual(settings.runTypes, ['farming'])
  }))

test('the oldest core format (an enabled list) keeps newer domains on', () =>
  withHome({ uploadDomains: ['runs', 'workshop'] }, () => {
    const settings = readSettings()
    assert.ok(!settings.domains.includes('labs'), 'listed-era domain left out means turned off')
    assert.ok(settings.domains.includes('lifetime'), 'a domain added after that format is on')
  }))

test('the declared schema survives validation intact', () => {
  const dropped = []
  const fields = normalizeSettingsSchema(SETTINGS_SCHEMA, message => dropped.push(message))
  assert.deepEqual(dropped, [])
  assert.equal(fields.length, SETTINGS_SCHEMA.length)
})

test('a malformed schema field is dropped and reported, not drawn', () => {
  const dropped = []
  const fields = normalizeSettingsSchema([
    { key: 'ok', type: 'boolean', label: 'Fine' },
    { key: 'ok', type: 'boolean' },
    { key: 'weird', type: 'slider' },
    { key: 'empty', type: 'multiselect', options: [] },
    { type: 'number' },
  ], message => dropped.push(message))
  assert.deepEqual(fields.map(field => field.key), ['ok'])
  assert.equal(dropped.length, 4)
})
