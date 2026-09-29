/** Path browsers fetch to trigger Chrome Private Network Access permission. */
export const PRIVATE_NETWORK_PING_PATH = '/private-network-ping'

/**
 * CORS + Private Network Access headers for requests from the published tracker site.
 * @see https://developer.chrome.com/blog/private-network-access-preflight
 */
export function privateNetworkCorsHeaders(req) {
  const headers = {
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Access-Control-Request-Private-Network',
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ version: string, protocol?: number, product?: string, game?: string }} meta
 * @returns {boolean} true if handled
 */
export function handlePrivateNetworkHttp(req, res, meta) {
  const cors = privateNetworkCorsHeaders(req)
  const path = (req.url ?? '').split('?')[0]

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return true
  }

  if (req.method === 'GET' && path === PRIVATE_NETWORK_PING_PATH) {
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'application/json',
    })
    res.end(
      JSON.stringify({
        ok: true,
        type: 'PRIVATE_NETWORK_PING',
        version: meta.version,
        protocol: meta.protocol,
        product: meta.product,
        // Which game this port serves and which process serves it, so a second
        // bridge starting up can tell "already running, reuse it" from "an
        // older copy is squatting on the port, replace it" (port-owner.mjs).
        game: meta.game,
        pid: process.pid,
      }),
    )
    return true
  }

  return false
}
