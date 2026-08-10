/** Reject adb shell stderr/stdout that was mistaken for a pulled save file. */
export function bytesLookLikeShellFailure(bytes) {
  if (!bytes?.byteLength) return true
  const sample = bytes.toString('utf8', 0, Math.min(bytes.byteLength, 512))
  return (
    /^cat:\s/m.test(sample)
    || /^adb:\s/m.test(sample)
    || /no such file|not found|permission denied|cannot open|is a directory/i.test(sample)
  )
}

/**
 * True when bytes are plausibly a real save rather than an adb error string.
 *
 * Deliberately weak. The bridge is not a save parser -- it hands bytes to a
 * site that knows the format -- so this only has to reject the specific junk
 * adb hands back when a pull half-fails. Anything stricter would mean encoding
 * one game's format here, which is exactly what this package avoids.
 *
 * @param {Buffer} bytes
 * @param {{ minBytes?: number }} [options]
 */
export function bytesLookLikeSaveFile(bytes, options = {}) {
  const minBytes = options.minBytes ?? 64
  if (!bytes?.byteLength || bytes.byteLength < 32) return false
  if (bytesLookLikeShellFailure(bytes)) return false
  // gzip magic -- a compressed save is definitely not an error string.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return true
  return bytes.byteLength >= minBytes
}
