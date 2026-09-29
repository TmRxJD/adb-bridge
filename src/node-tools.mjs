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
 * @param {'npm' | 'npx'} tool
 * @param {string[]} args
 * @returns {{ command: string, args: string[] }}
 */
export function nodeToolCommand(tool, args) {
  const cli = bundledCliCandidates(tool).find(candidate => fs.existsSync(candidate))
  if (!cli) {
    throw new Error(
      `Could not find ${tool} beside Node (${process.execPath}). Reinstall Node.js from https://nodejs.org -- it includes ${tool}.`,
    )
  }
  return { command: process.execPath, args: [cli, ...args] }
}
