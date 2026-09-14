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
