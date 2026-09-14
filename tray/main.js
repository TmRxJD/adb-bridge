const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } = require('electron')
const { isPortInUse, requestBridge } = require('./bridge-client')

/**
 * ADB Bridge in the system tray.
 *
 * Game-agnostic on purpose: the bridge serves every enabled game, so the tray
 * shows one section per game and knows nothing about any of them. What a game
 * can do -- link an account, upload, which settings it has -- comes from its
 * uploader plugin through the bridge, and a game without one is a plain save
 * bridge.
 *
 * It runs the bridge itself when nothing else holds the games' ports, and
 * controls the running bridge otherwise (a CLI install, or a game's own
 * desktop app with a built-in fallback), so there is never a second bridge
 * fighting for a port.
 */
if (require('electron-squirrel-startup')) app.quit()

const HELP_URL = 'https://github.com/TmRxJD/adb-bridge#readme'
const POLL_MS = 30_000
const UPLOAD_TIMEOUT_MS = 240_000
const SCAN_PRESETS = [30, 60, 120, 300, 900]
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png')
const ICON_ICO = path.join(__dirname, 'assets', 'icon.ico')

const logBuffer = []
const originalLog = console.log.bind(console)
const originalError = console.error.bind(console)

function appendLog(line) {
  if (!line) return
  logBuffer.push(line)
  if (logBuffer.length > 1000) logBuffer.splice(0, logBuffer.length - 1000)
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('bridge-log', line)
}

function formatArgs(args) {
  return args.map(value => (value instanceof Error ? value.message : String(value ?? ''))).join(' ').trim()
}

// The bridge logs with console.*; mirror it so "Show console" shows what it does.
console.log = (...args) => {
  originalLog(...args)
  appendLog(formatArgs(args))
}
console.error = (...args) => {
  originalError(...args)
  appendLog(formatArgs(args))
}

let tray = null
let hostedBridge = null
let bridgeMode = 'starting' // 'hosted' | 'external' | 'failed' | 'starting'
let games = []
let busy = false
const settingsWindows = new Map()
let consoleWindow = null

async function loadEnabledGames() {
  const { loadAllGameProfiles, readEnabledGameIds } = await import('adb-bridge')
  const { profiles } = loadAllGameProfiles()
  return readEnabledGameIds()
    .map(id => profiles.get(id))
    .filter(Boolean)
    .map(profile => ({ id: profile.id, name: profile.name, port: profile.port, siteUrl: profile.siteUrl, status: null }))
}

async function startBridge() {
  games = await loadEnabledGames()
  if (games.length === 0) {
    bridgeMode = 'failed'
    console.log('[tray] no games are enabled; run `adb-bridge games add <game>`')
    return
  }
  const held = await Promise.all(games.map(game => isPortInUse(game.port)))
  if (held.some(Boolean)) {
    bridgeMode = 'external'
    console.log('[tray] a bridge is already running; the tray will control it')
    return
  }
  try {
    const bridge = await import('adb-bridge')
    hostedBridge = await bridge.startBridge({ log: line => console.log(line), installPlugins: true })
    bridgeMode = 'hosted'
    console.log(`[tray] bridge ${bridge.BRIDGE_VERSION} running inside the tray`)
  } catch (error) {
    bridgeMode = 'failed'
    console.error(`[tray] bridge failed to start: ${error?.message || error}`)
  }
}

async function stopBridge() {
  const running = hostedBridge
  hostedBridge = null
  if (!running) return
  await Promise.all((running.bridges ?? []).map(bridge => bridge.close?.().catch(() => {})))
}

async function refresh() {
  try {
    const latest = await loadEnabledGames()
    const previous = new Map(games.map(game => [game.id, game.status]))
    games = latest.map(game => ({ ...game, status: previous.get(game.id) ?? null }))
  } catch {
    // Keep the last known list.
  }
  await Promise.all(games.map(async game => {
    try {
      game.status = await requestBridge(game.port, { type: 'PING' }, ['PONG'])
    } catch {
      game.status = null
    }
  }))
  render()
}

async function run(label, action) {
  if (busy) return
  busy = true
  render()
  try {
    await action()
  } catch (error) {
    console.error(`[tray] ${label} failed: ${error?.message || error}`)
    new Notification({ title: 'ADB Bridge', body: `${label} failed: ${error?.message || error}` }).show()
  } finally {
    busy = false
    await refresh()
  }
}

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'
}

function hasUploader(status) {
  return Boolean(status && (status.account || status.settings))
}

function describeGame(game) {
  const status = game.status
  if (!status) return 'not running'
  if (!hasUploader(status)) return 'save bridge'
  const who = status.account?.linked ? (status.account.username || 'linked') : 'not linked'
  const activity = status.activity ?? {}
  return `${who} · read ${formatTime(activity.lastReadAt)} · upload ${formatTime(activity.lastUploadAt)}`
}

function describeBridge() {
  if (bridgeMode === 'hosted') return 'Bridge running'
  if (bridgeMode === 'external') return 'Controlling a running bridge'
  if (bridgeMode === 'failed') return 'Bridge not running'
  return 'Starting…'
}

async function uploadNow(game) {
  const result = await requestBridge(game.port, { type: 'UPLOAD_NOW' }, ['UPLOAD_RESULT'], UPLOAD_TIMEOUT_MS)
  new Notification({
    title: `${game.name}: upload finished`,
    body: (result.messages?.length ? result.messages.join(' ') : 'Nothing new to upload.'),
  }).show()
}

/** Squirrel installs run through Update.exe; a login item must point there. */
function loginItemOptions(enabled) {
  if (process.platform === 'win32') {
    const updateExe = path.resolve(path.dirname(process.execPath), '..', 'Update.exe')
    if (fs.existsSync(updateExe)) {
      return { openAtLogin: enabled, path: updateExe, args: ['--processStart', `"${path.basename(process.execPath)}"`] }
    }
  }
  return { openAtLogin: enabled, openAsHidden: true }
}

async function setStartAtLogin(enabled) {
  app.setLoginItemSettings(loginItemOptions(enabled))
  if (!enabled) return
  // The tray now starts the bridge; the CLI's own autostart would start a second.
  const { removeBootEntry } = await import('adb-bridge')
  await removeBootEntry(line => console.log(`[tray] ${line}`))
}

function scanLabel(seconds) {
  return seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`
}

function gameMenu(game) {
  const status = game.status
  const connected = Boolean(status)
  const linked = Boolean(status?.account?.linked)
  const items = [
    {
      label: game.siteUrl ? `Open ${game.name} site` : 'No site set',
      enabled: Boolean(game.siteUrl),
      click: () => void shell.openExternal(game.siteUrl),
    },
  ]
  if (!hasUploader(status)) {
    items.push({ label: connected ? 'Save bridge only — no uploads for this game' : 'Not running', enabled: false })
    return items
  }
  items.push(
    { type: 'separator' },
    {
      label: 'Automatic uploads',
      type: 'checkbox',
      enabled: connected && linked && !busy,
      checked: status?.autoUpload === true,
      click: item => void run('Automatic uploads', () =>
        requestBridge(game.port, { type: 'SET_AUTO_UPLOAD', enabled: item.checked }, ['AUTO_UPLOAD_STATUS'])),
    },
    { label: 'Upload now', enabled: connected && linked && !busy, click: () => void run('Upload now', () => uploadNow(game)) },
    { label: 'Settings…', enabled: connected && Boolean(status?.settings), click: () => openSettingsWindow(game) },
  )
  if (!linked) items.push({ label: 'Link an account from the game\'s site', enabled: false })
  return items
}

function render() {
  if (!tray) return
  const scan = games.find(game => game.status)?.status?.scanIntervalSeconds ?? null
  const anyConnected = games.some(game => game.status)
  const template = [
    { label: `ADB Bridge — ${describeBridge()}`, enabled: false },
    { type: 'separator' },
    ...(games.length === 0
      ? [{ label: 'No games enabled', enabled: false }]
      : games.map(game => ({ label: `${game.name} — ${describeGame(game)}`, submenu: gameMenu(game) }))),
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: app.getLoginItemSettings(loginItemOptions(true)).openAtLogin === true,
      click: item => void run('Start with Windows', () => setStartAtLogin(item.checked)),
    },
    {
      label: 'Scan every',
      enabled: anyConnected && scan !== null && !busy,
      submenu: SCAN_PRESETS.map(seconds => ({
        label: scanLabel(seconds),
        type: 'radio',
        checked: scan === seconds,
        // Shared by every game, so any running game's port sets it.
        click: () => {
          const game = games.find(candidate => candidate.status)
          if (game) void run('Scan interval', () => requestBridge(game.port, { type: 'SET_SCAN_INTERVAL', seconds }, ['SETTINGS']))
        },
      })),
    },
    { label: 'Show console', click: () => openConsoleWindow() },
    { label: 'Help', click: () => void shell.openExternal(HELP_URL) },
    { label: 'Quit', click: () => app.quit() },
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(['ADB Bridge', ...games.map(game => `${game.name}: ${describeGame(game)}`)].join('\n'))
}

function windowOptions(width, height, title) {
  return {
    width,
    height,
    title,
    icon: ICON_PNG,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') },
  }
}

function openSettingsWindow(game) {
  const existing = settingsWindows.get(game.id)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const win = new BrowserWindow(windowOptions(460, 620, `${game.name} — Settings`))
  win.loadFile(path.join(__dirname, 'settings.html'), { query: { game: game.id } })
  settingsWindows.set(game.id, win)
  win.on('closed', () => settingsWindows.delete(game.id))
}

function openConsoleWindow() {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.show()
    consoleWindow.focus()
    return
  }
  consoleWindow = new BrowserWindow(windowOptions(860, 500, 'ADB Bridge — Console'))
  consoleWindow.loadFile(path.join(__dirname, 'console.html'))
}

function findGame(gameId) {
  const game = games.find(candidate => candidate.id === gameId)
  if (!game) throw new Error('That game is not enabled on this bridge.')
  return game
}

ipcMain.handle('settings:load', async (_event, gameId) => {
  const game = findGame(gameId)
  const reply = await requestBridge(game.port, { type: 'GET_GAME_SETTINGS' }, ['GAME_SETTINGS'])
  return { gameName: reply.gameName, schema: reply.schema, values: reply.values }
})
ipcMain.handle('settings:save', async (_event, gameId, values) => {
  const game = findGame(gameId)
  const reply = await requestBridge(game.port, { type: 'SET_GAME_SETTINGS', values }, ['GAME_SETTINGS'])
  void refresh()
  return { gameName: reply.gameName, schema: reply.schema, values: reply.values }
})
ipcMain.handle('console:buffer', () => ({
  lines: [...logBuffer],
  external: bridgeMode === 'external',
}))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => tray?.popUpContextMenu())
  // A tray app: closing a window must never end it.
  app.on('window-all-closed', () => {})
  app.on('before-quit', () => void stopBridge())

  app.whenReady().then(async () => {
    const icon = nativeImage.createFromPath(process.platform === 'win32' ? ICON_ICO : ICON_PNG)
    tray = new Tray(process.platform === 'win32' ? icon : icon.resize({ width: 16, height: 16 }))
    tray.on('click', () => tray.popUpContextMenu())
    render()
    await startBridge()
    await refresh()
    setInterval(() => void refresh(), POLL_MS)
  })
}
