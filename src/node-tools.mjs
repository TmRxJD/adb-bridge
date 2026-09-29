import fs from 'node:fs'
import path from 'node:path'

/**
 * How to run npm and npx from inside the bridge.
 *
 * Spawning `npm.cmd` / `npx.cmd` failed on real machines with "'npm.cmd' is not
 * recognized": the Windows launcher and the sign-in entry run node.exe by
 * absolute path, so the process PATH often has no npm on it at all (Volta and
 * fnm shims live elsewhere; a hidden sign-in process never ran the shell
 * profile that adds them). It also needed `shell: true`, which Node 22+ warns
 * about (DEP0190) because the arguments are not escaped.
 *
 * Every Node install ships npm next to the node binary, so run that script
 * with the node that is already running us: no PATH, no shell, no .cmd.
 */

/** @param {'npm' | 'npx'} tool */
function bundledCliCandidates(tool) {
  const file = `${tool}-cli.js`
  const nodeDir = path.dirname(process.execPath)
  const candidates = []
  // Set when we were started by npm / npx themselves: the exact npm in use.
  const execPath = process.env.npm_execpath
  if (execPath && /\.c?js$/.test(execPath)) {
    candidates.push(path.join(path.dirname(execPath), file))
  }
  // Windows layout, then the Unix layout (bin/node beside lib/node_modules).
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', file))
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', file))
  return candidates
}

/**
 * The environment for an npm/npx child: ours, with this node's folder first
 * on PATH.
 *
 * Running npm-cli.js by absolute path is not enough on its own. npx starts the
 * package it fetched through a `.cmd` shim that calls plain `node`, and npm
 * runs install scripts the same way, so with node absent from PATH the child
 * fails with "'node' is not recognized" -- found by the clean-room test of
 * 0.6.0, where it broke the auto-update handoff on exactly the machines this
 * file exists for.
 */
export function nodeToolEnv(base = process.env) {
  const key = Object.keys(base).find(name => name.toUpperCase() === 'PATH') ?? 'PATH'
  const nodeDir = path.dirname(process.execPath)
  const env = { ...base }
  env[key] = [nodeDir, base[key]].filter(Boolean).join(path.delimiter)
  return env
}

/**
 * @param {'npm' | 'npx'} tool
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env] Extra variables for the child.
 * @returns {{ command: string, args: string[], env: NodeJS.ProcessEnv }}
 */
export function nodeToolCommand(tool, args, env = {}) {
  const cli = bundledCliCandidates(tool).find(candidate => fs.existsSync(candidate))
  if (!cli) {
    throw new Error(
      `Could not find ${tool} beside Node (${process.execPath}). Reinstall Node.js from https://nodejs.org -- it includes ${tool}.`,
    )
  }
  return { command: process.execPath, args: [cli, ...args], env: nodeToolEnv({ ...process.env, ...env }) }
}
