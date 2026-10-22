import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { exportSession, importSession } from '../src/profile-archive.js'
import { credentialsFromEnv, objectKey, parseS3Url, uploadFile } from '../src/upload.js'

describe('profile session archive', () => {
  const profile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'mr-test-profile-'))
    mkdirSync(join(dir, 'Default', 'Cache'), { recursive: true })
    writeFileSync(join(dir, 'Local State'), '{}')
    writeFileSync(join(dir, 'Default', 'Preferences'), '{"profile":{}}')
    writeFileSync(join(dir, 'Default', 'Cookies'), 'cookie-db')
    writeFileSync(join(dir, 'Default', 'Cache', 'big'), 'x'.repeat(100_000))
    return dir
  }

  it('exports only the session files and imports them into a fresh folder', () => {
    const archive = join(mkdtempSync(join(tmpdir(), 'mr-test-')), 'session.tgz')
    writeFileSync(archive, exportSession(profile()))
    const listed = spawnSync('tar', ['-tzf', archive]).stdout.toString()
    expect(listed).toContain('Default/Cookies')
    expect(listed).not.toContain('Cache')

    const imported = importSession(archive)
    expect(readFileSync(join(imported.dir, 'Default', 'Cookies'), 'utf8')).toBe('cookie-db')
    imported.cleanup()
  })

  it('refuses a profile without cookies, and ignores unexpected files in an archive', () => {
    const empty = mkdtempSync(join(tmpdir(), 'mr-test-empty-'))
    expect(() => exportSession(empty)).toThrow(/sign the profile in/)

    const src = mkdtempSync(join(tmpdir(), 'mr-test-src-'))
    mkdirSync(join(src, 'Default'))
    writeFileSync(join(src, 'Default', 'Cookies'), 'c')
    writeFileSync(join(src, 'evil.sh'), 'x')
    const archive = join(src, 'a.tgz')
    spawnSync('tar', ['-czf', archive, '-C', src, 'Default/Cookies', 'evil.sh'])
    const imported = importSession(archive)
    expect(() => readFileSync(join(imported.dir, 'evil.sh'))).toThrow()
    imported.cleanup()
  })
})

describe('upload', () => {
  it('parses s3:// URLs and builds dated keys', () => {
    expect(parseS3Url('s3://meeting-recordings')).toEqual({ bucket: 'meeting-recordings', prefix: '' })
    expect(parseS3Url('s3://bucket/meet/rec/')).toEqual({ bucket: 'bucket', prefix: 'meet/rec' })
    expect(() => parseS3Url('https://x/y')).toThrow(/s3:\/\//)
    const at = new Date(Date.UTC(2026, 9, 22, 16))
    expect(objectKey({ bucket: 'b', prefix: '' }, '/tmp/x/Daily.webm', at)).toBe('2026/10/Daily.webm')
    expect(objectKey({ bucket: 'b', prefix: 'meet' }, 'Daily.json', at)).toBe('meet/2026/10/Daily.json')
  })

  it('needs the endpoint and keys', () => {
    expect(() => credentialsFromEnv({})).toThrow(/S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY/)
    expect(credentialsFromEnv({ S3_ENDPOINT: 'https://acc.r2.cloudflarestorage.com/', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' })).toMatchObject({
      endpoint: 'https://acc.r2.cloudflarestorage.com',
      region: 'auto'
    })
  })

  it('streams a signed PUT to the bucket path', async () => {
    const received: { method?: string; url?: string; auth?: string; sha?: string; body: string } = { body: '' }
    const server = createServer((req, res) => {
      received.method = req.method
      received.url = req.url
      received.auth = req.headers.authorization
      received.sha = req.headers['x-amz-content-sha256'] as string
      req.on('data', (d: Buffer) => (received.body += d.toString()))
      req.on('end', () => res.end())
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    const file = join(mkdtempSync(join(tmpdir(), 'mr-test-up-')), 'Daily standup.json')
    writeFileSync(file, '{"ok":true}')

    const url = await uploadFile(file, { bucket: 'b', prefix: 'p' }, 'p/2026/10/Daily standup.json', {
      endpoint: `http://127.0.0.1:${port}`,
      accessKeyId: 'k',
      secretAccessKey: 's',
      region: 'auto'
    })
    server.close()
    expect(url).toBe('s3://b/p/2026/10/Daily standup.json')
    expect(received).toMatchObject({ method: 'PUT', url: '/b/p/2026/10/Daily%20standup.json', sha: 'UNSIGNED-PAYLOAD', body: '{"ok":true}' })
    expect(received.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=k\//)
  })
})
