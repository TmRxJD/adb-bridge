import readline from 'node:readline/promises'
import { loadAllGameProfiles } from './registry.mjs'
import { disableGame, enableGame, readEnabledGameIds } from '../bridge-state.mjs'

/**
 * Interactive "which games do you want" prompt.
 *
 * The first-run path used to print the game list, tell the user to type
 * `adb-bridge games add <id>`, and exit -- which in the Windows launcher meant
 * "ADB Bridge has stopped. Press any key", with the user expected to find a
 * terminal and run a second command. Choosing belongs in the one command they
 * already ran.
 */

/**
 * Parses an answer like "1 2", "1,2", "all" or "cifi thetower" into game ids.
 * Returns null for anything it cannot fully understand, so a typo re-asks
 * instead of silently enabling the wrong set.
 *
 * @param {string} answer
 * @param {string[]} ids Games in the order they were listed.
 * @returns {string[] | null}
 */
export function parseGameSelection(answer, ids) {
  const text = answer.trim().toLowerCase()
  if (text === 'all' || text === 'a') return [...ids]
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return null
  const picked = []
  for (const token of tokens) {
    const index = Number(token)
    const id = Number.isInteger(index) && index >= 1 && index <= ids.length ? ids[index - 1] : ids.find(each => each === token)
    if (!id) return null
    if (!picked.includes(id)) picked.push(id)
  }
  return picked
}

/** Whether this process can ask the user anything. */
export function canPrompt(input = process.stdin, output = process.stdout) {
  return Boolean(input.isTTY && output.isTTY)
}

/**
 * Asks which games to serve and makes the enabled set exactly that.
 *
 * @returns {Promise<string[]>} The ids now enabled.
 */
export async function pickGames({ input = process.stdin, output = process.stdout, log = console.log } = {}) {
  const { profiles } = loadAllGameProfiles()
  const list = [...profiles.values()]
  const ids = list.map(profile => profile.id)
  const current = new Set(readEnabledGameIds())

  log('Which games do you want the bridge to serve?\n')
  list.forEach((profile, index) => {
    const mark = current.has(profile.id) ? ' (on)' : ''
    log(`  ${index + 1}) ${profile.name}${mark}`)
  })
  const keepHint = current.size > 0 ? ', Enter to keep the current set' : ''
  log(`\nType numbers separated by spaces (e.g. "1 2"), or "all"${keepHint}.`)

  // The line iterator, not rl.question: question() drops a line that arrives
  // while no question is pending (a fast typist, a paste), leaving the prompt
  // waiting forever on input it already received.
  const rl = readline.createInterface({ input, output })
  let chosen = null
  try {
    output.write('> ')
    for await (const answer of rl) {
      chosen = answer.trim() === '' && current.size > 0 ? [...current] : parseGameSelection(answer, ids)
      if (chosen) break
      log(`Didn't catch that. Pick from 1-${ids.length}, or type "all".`)
      output.write('> ')
    }
  } finally {
    rl.close()
  }
  if (!chosen) {
    throw new Error('Input closed before a game was chosen.')
  }

  for (const id of current) {
    if (!chosen.includes(id)) disableGame(id)
  }
  for (const id of chosen) {
    if (!current.has(id)) enableGame(id)
  }
  const names = chosen.map(id => profiles.get(id).name)
  log(`\nServing: ${names.join(', ')}.`)
  return chosen
}
