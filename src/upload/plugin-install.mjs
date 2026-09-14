import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { configDir } from '../games/registry.mjs'

/**
 * Where uploader plugins live, and how they get there.
 *
 * A bare `import('<plugin>')` only finds packages installed inside adb-bridge's
 * own tree. A plugin installed globally beside it is invisible to that under
 * Volta (every tool gets its own isolated image), and unreliable under plain npm.
 * So background uploads never loaded for most installs, and nothing said so.
 *
 * Plugins are therefore also looked up in the bridge's own plugins folder
 * (~/.adb-bridge/plugins) and the global npm root, and can be installed into
 * that folder, which every install method can reach.
 */
const execFileAsync = promisify(execFile)
const IS_WINDOWS = process.platform === 'win32'
const NPM = IS_WINDOWS ? 'npm.cmd' : 'npm'
const INSTALL_TIMEOUT_MS = 180_000

/**
 * npm package names only. The name comes from a game profile, which a user can
 * write, and reaches npm through a shell on Windows, so anything else is refused.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export function isValidPluginName(name) {
  return typeof name === 'string' && name.length <= 214 && PACKAGE_NAME.test(name)
}

export function pluginsDir() {
  return path.join(configDir(), 'plugins')
}

function entryFromPackageDir(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const root = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']
  const target = typeof root === 'string' ? root : root?.import ?? root?.default ?? pkg.main ?? 'index.js'
  return path.join(dir, target)
}

let globalRoot = null
function npmGlobalRoot() {
  globalRoot ??= execFileAsync(NPM, ['root', '-g'], { windowsHide: true, timeout: 15_000, shell: IS_WINDOWS })
    .then(({ stdout }) => String(stdout).trim() || null)
    .catch(() => null)
  return globalRoot
}

/** Path to an installed plugin's entry module, or null. */
export async function findInstalledPlugin(name) {
  if (!isValidPluginName(name)) return null
  const roots = [path.join(pluginsDir(), 'node_modules')]
  const global = await npmGlobalRoot()
  if (global) roots.push(global)
  for (const root of roots) {
    const dir = path.join(root, ...name.split('/'))
    if (fs.existsSync(path.join(dir, 'package.json'))) return entryFromPackageDir(dir)
  }
  return null
}

export async function importInstalledPlugin(name) {
  const entry = await findInstalledPlugin(name)
  return entry ? import(pathToFileURL(entry).href) : null
}

/** Version of the copy in the bridge's plugins folder, or null when there is none. */
export function installedPluginVersion(name) {
  if (!isValidPluginName(name)) return null
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pluginsDir(), 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Make sure the plugin is installed and, when automatic updates are on, current.
 *
 * Without this a plugin, once installed, was never updated: users kept a copy
 * with known bugs for as long as the bridge ran. Only the copy in the bridge's
 * own plugins folder is managed; one the user installed elsewhere is theirs.
 * Offline or a registry error keeps what is installed.
 *
 * @returns {Promise<'installed' | 'updated' | 'current' | 'kept' | 'unmanaged'>}
 */
export async function ensurePluginCurrent(name, log = console.log, deps = {}) {
  const fetchLatest = deps.fetchLatest ?? (async pkg => (await import('../update-check.mjs')).fetchLatestPublishedVersion(3500, pkg))
  const compare = deps.compareVersions ?? (await import('../update-check.mjs')).compareVersions
  const autoUpdate = deps.isAutoUpdateEnabled ?? (await import('../bridge-config.mjs')).isAutoUpdateEnabled
  const install = deps.install ?? installPlugin

  const installed = installedPluginVersion(name)
  if (!installed) {
    if (await findInstalledPlugin(name)) return 'unmanaged'
    await install(name, log)
    return 'installed'
  }
  if (!autoUpdate()) return 'kept'
  const latest = await fetchLatest(name)
  if (!latest || compare(latest, installed) <= 0) return 'current'
  log(`Updating upload support ${installed} -> ${latest}...`)
  await install(name, log)
  return 'updated'
}

/** Install (or update) a plugin into the bridge's plugins folder. */
export async function installPlugin(name, log = console.log) {
  if (!isValidPluginName(name)) throw new Error(`"${name}" is not a valid package name.`)
  fs.mkdirSync(pluginsDir(), { recursive: true })
  log(`Installing upload support (${name})...`)
  await execFileAsync(
    NPM,
    ['install', '--prefix', pluginsDir(), `${name}@latest`, '--no-audit', '--no-fund', '--loglevel=error'],
    { windowsHide: true, timeout: INSTALL_TIMEOUT_MS, shell: IS_WINDOWS },
  )
}
