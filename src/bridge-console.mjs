/** Terminal progress for PULL_SAVE — visible in the bridge window only (not the website). */

export function formatProgressBar(ratio, width = 28) {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return `[${'='.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}] ${Math.round(clamped * 100)}%`
}

export class BridgePullConsole {
  /** @param {{ physical?: boolean }} options */
  constructor(options = {}) {
    this.physical = Boolean(options.physical)
    this.totalSteps = this.physical ? 6 : 4
    this.step = 0
  }

  /** @param {string} label @param {number | undefined} ratioOverride */
  log(label, ratioOverride) {
    this.step = Math.min(this.step + 1, this.totalSteps)
    const ratio =
      ratioOverride ?? (this.totalSteps > 0 ? this.step / this.totalSteps : 1)
    const prefix = this.physical ? 'USB pull' : 'ADB pull'
    console.log(`${formatProgressBar(ratio)} ${prefix}: ${label}`)
  }

  logError(label) {
    console.error(`[!!] ${label}`)
  }
}
