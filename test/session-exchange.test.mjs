import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  exchangeLinkToken,
  extractSessionSecret,
} from '../plugins/uploader-thetower/session-exchange.mjs'

/**
 * The bridge signs in with a one-time token instead of copying the browser's
 * session. Appwrite hands a client session's secret back as a cookie (and in
 * X-Fallback-Cookies off-domain), not in the body, so reading the right one is
 * the whole job. A near-miss cookie name (`_legacy`) must not be taken.
 */
const PROJECT = 'proj1'
const TOKEN = { endpoint: 'https://aw.example/v1', projectId: PROJECT, userId: 'u1', secret: 'tok' }

function response(status, body, headers = {}) {
  const h = new Headers(headers)
  return { ok: status >= 200 && status < 300, status, headers: h, text: async () => JSON.stringify(body) }
}

function fakeFetch(sessionResponse, accountBody = { $id: 'u1', name: 'Tester' }) {
  const calls = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.endsWith('/account/sessions/token')) return sessionResponse
      if (url.endsWith('/account')) return response(200, accountBody)
      throw new Error(`unexpected ${url}`)
    },
  }
}

test('reads the session from the exact cookie, not the legacy one', () => {
  const headers = new Headers()
  headers.append('set-cookie', `a_session_${PROJECT}_legacy=WRONG; path=/`)
  headers.append('set-cookie', `a_session_${PROJECT}=RIGHT; path=/; httponly`)
  assert.equal(extractSessionSecret({ body: { secret: '' }, headers, projectId: PROJECT }), 'RIGHT')
})

test('reads X-Fallback-Cookies when no cookie is set', () => {
  const headers = new Headers({ 'x-fallback-cookies': JSON.stringify({ [`a_session_${PROJECT}`]: 'FB' }) })
  assert.equal(extractSessionSecret({ body: {}, headers, projectId: PROJECT }), 'FB')
})

test('exchanges the token and verifies whose session it is', async () => {
  const { fetch, calls } = fakeFetch(
    response(201, { $id: 's1', secret: '' }, { 'set-cookie': `a_session_${PROJECT}=SESS; path=/` }),
  )
  const result = await exchangeLinkToken(TOKEN, { fetch })
  assert.equal(result.sessionSecret, 'SESS')
  assert.equal(result.username, 'Tester')
  assert.equal(calls[1].init.headers['X-Appwrite-Session'], 'SESS')
})

test('refuses a session that belongs to someone else', async () => {
  const { fetch } = fakeFetch(
    response(201, { $id: 's1' }, { 'set-cookie': `a_session_${PROJECT}=SESS` }),
    { $id: 'someone-else' },
  )
  await assert.rejects(exchangeLinkToken(TOKEN, { fetch }), /could not be verified/)
})

test('reports an expired token plainly', async () => {
  const { fetch } = fakeFetch(response(401, { message: 'Invalid token' }))
  await assert.rejects(exchangeLinkToken(TOKEN, { fetch }), /Invalid token.*link again/)
})
