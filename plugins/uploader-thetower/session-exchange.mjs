/**
 * Turns a one-time link token into a session that belongs to this bridge.
 *
 * The website mints the token (Appwrite function `bridge-link-token`) for the
 * signed-in user and hands it over loopback. Exchanging it here, rather than
 * copying the browser's session, means:
 *   - it works when the browser's session is an httpOnly cookie the site cannot read;
 *   - the bridge's session is its own, so signing out of the site does not stop
 *     background uploads, and unlinking revokes only the bridge.
 *
 * Appwrite does not put a client session's secret in the response body. It
 * arrives as the `a_session_<project>` cookie, and also in X-Fallback-Cookies
 * when the caller is not on a verified domain. Both are read; the body is
 * checked first in case a server version does include it.
 */

function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const joined = headers.get('set-cookie')
  return joined ? joined.split(/,(?=\s*[^;=\s]+=)/) : []
}

/** @returns {string | null} */
export function extractSessionSecret({ body, headers, projectId }) {
  if (typeof body?.secret === 'string' && body.secret.trim()) return body.secret.trim()

  const cookieName = `a_session_${projectId}`
  const fallback = headers.get('x-fallback-cookies')
  if (fallback) {
    try {
      const parsed = JSON.parse(fallback)
      const value = parsed?.[cookieName]
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch {
      // Malformed header; try the cookie.
    }
  }

  for (const cookie of readSetCookies(headers)) {
    const [pair] = cookie.split(';')
    const index = pair.indexOf('=')
    if (index < 0) continue
    // Exact name: Appwrite also sets `a_session_<project>_legacy`.
    if (pair.slice(0, index).trim() !== cookieName) continue
    const value = decodeURIComponent(pair.slice(index + 1).trim())
    if (value) return value
  }
  return null
}

async function readJson(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/**
 * @param {{ endpoint: string, projectId: string, userId: string, secret: string }} token
 * @param {{ fetch?: typeof fetch }} [deps]
 * @returns {Promise<{ sessionSecret: string, sessionId: string | null, userId: string, username: string | null }>}
 */
export async function exchangeLinkToken(token, deps = {}) {
  const doFetch = deps.fetch ?? fetch
  const endpoint = String(token?.endpoint || '').replace(/\/$/, '')
  const projectId = String(token?.projectId || '').trim()
  const userId = String(token?.userId || '').trim()
  const secret = String(token?.secret || '').trim()
  if (!endpoint || !projectId || !userId || !secret) {
    throw new Error('The link request was incomplete. Link this computer again from the import page.')
  }

  const response = await doFetch(`${endpoint}/account/sessions/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Appwrite-Project': projectId },
    body: JSON.stringify({ userId, secret }),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(
      `The link token was refused (${body?.message || response.status}). It may have expired; link again.`,
    )
  }

  const sessionSecret = extractSessionSecret({ body, headers: response.headers, projectId })
  if (!sessionSecret) {
    throw new Error('Signed in, but the server returned no session to keep. Link this computer again.')
  }

  // Confirm the session works and learn whose it is, rather than trusting the page.
  const accountResponse = await doFetch(`${endpoint}/account`, {
    headers: { 'X-Appwrite-Project': projectId, 'X-Appwrite-Session': sessionSecret },
  })
  const account = await readJson(accountResponse)
  if (!accountResponse.ok || account?.$id !== userId) {
    throw new Error('The new session could not be verified. Link this computer again.')
  }

  return {
    sessionSecret,
    sessionId: typeof body?.$id === 'string' ? body.$id : null,
    userId,
    username: typeof account?.name === 'string' && account.name.trim() ? account.name.trim() : null,
  }
}

/** Revoke the bridge's own session. Best effort: the local copy is deleted either way. */
export async function revokeBridgeSession(link, deps = {}) {
  const doFetch = deps.fetch ?? fetch
  if (!link?.endpoint || !link?.projectId || !link?.sessionSecret) return false
  try {
    const response = await doFetch(`${String(link.endpoint).replace(/\/$/, '')}/account/sessions/current`, {
      method: 'DELETE',
      headers: { 'X-Appwrite-Project': link.projectId, 'X-Appwrite-Session': link.sessionSecret },
    })
    return response.ok
  } catch {
    return false
  }
}
