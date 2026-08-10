import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/**
 * Stores the Appwrite session handed over by the tracker website so the bridge can
 * upload runs while the site is closed.
 *
 * SECURITY: an Appwrite session secret grants full account access, so the file is
 * created 0600 (owner-only) and, on Windows, its ACL is reset to the current user.
 * The site lists the session under Linked devices and can revoke it at any time,
 * which immediately invalidates whatever is stored here.
 */
import { uploaderDir } from './config.mjs'

function linkPath() {
  return path.join(uploaderDir(), 'account.json')
}

export function getAccountLinkPath() {
  return linkPath()
}

function hardenFilePermissions(target) {
  try {
    fs.chmodSync(target, 0o600)
  } catch {
    // chmod is a no-op on some Windows filesystems; the ACL step below covers it.
  }
  if (process.platform !== 'win32') return
  // Remove inherited ACEs and grant only the current user.
  const user = process.env.USERNAME
  if (!user) return
  execFile('icacls', [target, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, () => {})
}

/** @returns {{ endpoint, projectId, sessionSecret, userId, username, linkedAt } | null} */
export function readAccountLink() {
  try {
    const parsed = JSON.parse(fs.readFileSync(linkPath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!parsed.sessionSecret || !parsed.endpoint || !parsed.projectId) return null
    return parsed
  } catch {
    return null
  }
}

export function isAccountLinked() {
  return readAccountLink() !== null
}

/**
 * Persist the session handed over by the website.
 * @param {{ endpoint: string, projectId: string, sessionSecret: string,
 *   userId?: string, username?: string }} link
 */
export function writeAccountLink(link) {
  const endpoint = String(link?.endpoint || '').trim()
  const projectId = String(link?.projectId || '').trim()
  const sessionSecret = String(link?.sessionSecret || '').trim()
  if (!endpoint || !projectId || !sessionSecret) {
    throw new Error('endpoint, projectId and sessionSecret are all required to link an account.')
  }

  const payload = {
    endpoint,
    projectId,
    sessionSecret,
    userId: String(link?.userId || '').trim() || null,
    username: String(link?.username || '').trim() || null,
    linkedAt: new Date().toISOString(),
  }

  fs.mkdirSync(uploaderDir(), { recursive: true })
  // Create with 0600 from the start so the secret is never briefly world-readable.
  const target = linkPath()
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  hardenFilePermissions(target)
  return payload
}

/** Forget the stored session. Does not revoke it server-side — the site does that. */
export function clearAccountLink() {
  try {
    fs.rmSync(linkPath(), { force: true })
    return true
  } catch {
    return false
  }
}

/** Safe summary for logs and the website — never includes the secret. */
export function describeAccountLink() {
  const link = readAccountLink()
  if (!link) return { linked: false }
  return {
    linked: true,
    endpoint: link.endpoint,
    projectId: link.projectId,
    userId: link.userId ?? null,
    username: link.username ?? null,
    linkedAt: link.linkedAt ?? null,
  }
}
