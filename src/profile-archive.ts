// A profile's Google session as a small archive, to run the agent elsewhere (a
// container, a Kubernetes Secret): only what the session needs, not the whole
// Chrome profile (caches, history), so it fits in a Secret's 1 MiB.
//
// It works on another machine because both sign-in and recording use Chrome's
// basic password store: cookies are not tied to this machine's keyring.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Files of a Chrome profile that carry the sign-in, relative to the profile folder. */
export const SESSION_FILES = ['Local State', 'Default/Preferences', 'Default/Cookies', 'Default/Network/Cookies']

/** A gzipped tar of the session files of the profile folder `dir`. */
export function exportSession(dir: string): Buffer {
  const files = SESSION_FILES.filter((f) => existsSync(join(dir, f)))
  if (!files.some((f) => f.endsWith('Cookies'))) throw new Error(`No cookies in ${dir}: sign the profile in first (meeting-recorder login).`)
  const tar = spawnSync('tar', ['-czf', '-', '-C', dir, ...files], { maxBuffer: 64 * 1024 * 1024 })
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString().trim()}`)
  return tar.stdout
}

/**
 * Unpacks an exported session into a new temporary profile folder; `cleanup`
 * removes it. Only the known session files are extracted, whatever else the
 * archive holds.
 */
export function importSession(archive: string): { dir: string; cleanup(): void } {
  if (!existsSync(archive)) throw new Error(`${archive} does not exist.`)
  const list = spawnSync('tar', ['-tzf', archive])
  if (list.status !== 0) throw new Error(`Not a session archive (${archive}): ${list.stderr.toString().trim()}`)
  const members = list.stdout
    .toString()
    .split('\n')
    .map((m) => m.replace(/^\.\//, ''))
  const wanted = SESSION_FILES.filter((f) => members.includes(f))
  if (!wanted.some((f) => f.endsWith('Cookies'))) throw new Error(`${archive} has no cookies: export a signed-in profile.`)

  const dir = mkdtempSync(join(tmpdir(), 'meeting-recorder-profile-'))
  const tar = spawnSync('tar', ['-xzf', archive, '-C', dir, '--no-same-owner', ...wanted])
  if (tar.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`Could not unpack ${archive}: ${tar.stderr.toString().trim()}`)
  }
  // Chrome may still be flushing files into the folder when it is removed.
  const cleanup = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      /* best effort: it is a temporary folder */
    }
  }
  return { dir, cleanup }
}
