import assert from 'node:assert/strict'
import { test } from 'node:test'
import { serializeUploads } from '../src/upload/uploader-plugin.mjs'
import { createSaveWatcher } from '../src/save/save-watcher.mjs'

/**
 * Two upload passes must never overlap.
 *
 * The watcher's scan and "Upload now" ran together when an emulator came back:
 * each read the account's runs before the other wrote, and 19 runs were
 * uploaded twice. The plugin is wrapped so a second pass waits for the first.
 */
test('uploads through the wrapper never overlap', async () => {
  let active = 0
  let maxActive = 0
  const order = []
  const plugin = {
    label: 'fixture',
    async upload(bytes) {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(`start ${bytes}`)
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push(`end ${bytes}`)
      active -= 1
      return { messages: [] }
    },
  }
  const wrapped = serializeUploads(plugin)
  await Promise.all([wrapped.upload('a'), wrapped.upload('b')])
  assert.equal(maxActive, 1)
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b'])
  assert.equal(wrapped.label, 'fixture', 'other plugin members stay reachable')
})

test('a failed upload does not block the next one', async () => {
  let calls = 0
  const wrapped = serializeUploads({
    async upload() {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return { messages: ['ok'] }
    },
  })
  await assert.rejects(wrapped.upload('x'), /boom/)
  assert.deepEqual((await wrapped.upload('y')).messages, ['ok'])
})

test('the watcher hands the bridge domain list to the plugin', async () => {
  let received
  const watcher = createSaveWatcher({
    log: () => {},
    probeRemoteSaveStamp: async () => null,
    uploader: {
      isLinked: () => true,
      isAutoUploadEnabled: () => true,
      acquireSaveBytes: async () => ({ bytes: Buffer.from('save') }),
      upload: async (_bytes, options) => {
        received = options
        return { messages: [] }
      },
    },
  })
  await watcher.scanNow()
  assert.ok(Array.isArray(received?.domains), 'domains must be passed, or the plugin falls back to runs only')
  assert.ok(received.domains.includes('runs'))
})
