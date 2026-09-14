const WebSocket = require('ws')

/**
 * One request to a game's bridge port: send a message, resolve on the first
 * reply of an expected type. The tray uses the same websocket protocol as the
 * games' websites, so it controls a bridge running inside it or one started
 * elsewhere in exactly the same way.
 */
function requestBridge(port, message, expectedTypes, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const finish = fn => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // already closing
      }
      fn()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('The bridge did not answer.'))), timeoutMs)
    socket.on('open', () => socket.send(JSON.stringify(message)))
    socket.on('error', () => finish(() => reject(new Error('The bridge is not running.'))))
    socket.on('message', data => {
      let payload
      try {
        payload = JSON.parse(String(data))
      } catch {
        return
      }
      if (payload.type === 'ERROR') {
        finish(() => reject(new Error(String(payload.message || 'The bridge refused the request.'))))
        return
      }
      if (expectedTypes.includes(payload.type)) finish(() => resolve(payload))
    })
  })
}

function isPortInUse(port) {
  return new Promise(resolve => {
    const socket = require('net').connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

module.exports = { isPortInUse, requestBridge }
