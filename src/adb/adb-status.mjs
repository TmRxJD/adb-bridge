import {
  adbNotFoundMessage,
  normalizeAdbExecError,
  probeAdbPathIssue,
  requireAdbExecutable,
} from './adb-resolve.mjs'

function parseDevicesListing(listing) {
  const devices = []
  for (const line of listing.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('List of devices')) continue
    const [serial, state] = trimmed.split(/\s+/)
    if (!serial || !state) continue
    devices.push({ serial, state })
  }
  return devices
}

export async function getHostAdbStatus(runAdb) {
  try {
    const listing = await runAdb(['devices'], 15_000)
    const devices = parseDevicesListing(listing)
    const deviceCount = devices.filter(entry => entry.state === 'device').length
    const unauthorizedCount = devices.filter(entry => entry.state === 'unauthorized').length
    const offlineCount = devices.filter(entry => entry.state === 'offline').length
    const listedCount = devices.length

    return {
      serverRunning: true,
      deviceCount,
      unauthorizedCount,
      offlineCount,
      listedCount,
      conflictLikely:
        unauthorizedCount > 0
        || offlineCount > 0
        || (deviceCount === 0 && listedCount > 0),
    }
  } catch (error) {
    const normalized = normalizeAdbExecError(error)
    return {
      serverRunning: false,
      deviceCount: 0,
      unauthorizedCount: 0,
      offlineCount: 0,
      listedCount: 0,
      conflictLikely: false,
      error: normalized instanceof Error ? normalized.message : String(normalized),
    }
  }
}

function emptyDeviceFields() {
  return {
    serverRunning: false,
    deviceCount: 0,
    unauthorizedCount: 0,
    offlineCount: 0,
    listedCount: 0,
    conflictLikely: false,
  }
}

export async function probeHostAdbStatus(runAdb) {
  const pathProbe = await probeAdbPathIssue()
  if (pathProbe.issue === 'not-installed') {
    return {
      ...emptyDeviceFields(),
      pathIssue: 'not-installed',
      onPath: false,
      adbPath: null,
      error: adbNotFoundMessage(),
    }
  }

  await requireAdbExecutable()
  const host = await getHostAdbStatus(runAdb)
  return {
    ...host,
    pathIssue: pathProbe.issue,
    onPath: pathProbe.onPath,
    adbPath: pathProbe.adbPath,
  }
}
