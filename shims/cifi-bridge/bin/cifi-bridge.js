#!/usr/bin/env node
import { runShim } from '../shim.mjs'

await runShim({
  gameId: 'cifi',
  gameName: 'CIFI',
  oldPackage: 'cifi-bridge',
})
