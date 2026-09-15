/**
 * What the bridge last did, per game, for status displays (the tray's status
 * line, the website's settings dialog).
 *
 * In memory only: it describes this run of the bridge, and a restart starting
 * blank is accurate -- nothing has been read or uploaded yet this session.
 */
const byGame = new Map()

function entry(gameId) {
  if (!byGame.has(gameId)) {
    byGame.set(gameId, { lastReadAt: null, lastUploadAt: null, lastUpload: null, lastError: null })
  }
  return byGame.get(gameId)
}

/** A save was read (from disk or a device), whether or not anything uploaded. */
export function recordSaveRead(gameId) {
  if (!gameId) return
  entry(gameId).lastReadAt = new Date().toISOString()
}

/** An upload pass finished. `result` is the plugin's result object. */
export function recordUpload(gameId, result) {
  if (!gameId) return
  const current = entry(gameId)
  current.lastUploadAt = new Date().toISOString()
  current.lastError = null
  current.lastUpload = {
    uploaded: Number(result?.uploaded ?? 0),
    skipped: Number(result?.skipped ?? 0),
    replaced: Number(result?.replaced ?? 0),
    total: Number(result?.total ?? 0),
    filtered: Object.values(result?.filtered ?? {}).reduce((sum, n) => sum + Number(n || 0), 0),
    domainsWritten: Array.isArray(result?.domains?.written) ? result.domains.written.length : 0,
  }
}

export function recordUploadError(gameId, error) {
  if (!gameId) return
  entry(gameId).lastError = String(error?.message || error || 'Upload failed')
}

/** Snapshot for one game; a copy, so callers cannot mutate the record. */
export function getActivity(gameId) {
  const current = entry(gameId)
  return { ...current, lastUpload: current.lastUpload ? { ...current.lastUpload } : null }
}
