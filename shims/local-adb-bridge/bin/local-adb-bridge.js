#!/usr/bin/env node
import { runShim } from '../shim.mjs'

await runShim({
  gameId: 'thetower',
  gameName: 'The Tower',
  oldPackage: 'local-adb-bridge',
})
