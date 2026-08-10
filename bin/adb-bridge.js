#!/usr/bin/env node
import { runCliMain } from '../src/cli-main.mjs'

try {
  const code = await runCliMain()
  // Only set the code: the daemon keeps the event loop alive on purpose, and
  // calling process.exit() here would kill a bridge that just started serving.
  if (code) process.exitCode = code
} catch (error) {
  console.error(`adb-bridge failed to start: ${error?.message || error}`)
  process.exitCode = 1
}
