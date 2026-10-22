// Uploading the finished recording to S3-compatible storage (Cloudflare R2, MinIO,
// S3): one streamed PUT per file, signed with SigV4. A single PUT takes objects up
// to 5 GiB, far above an hour of meeting (100–700 MB).

import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Readable } from 'node:stream'

import { AwsClient } from 'aws4fetch'

export interface S3Target {
  bucket: string
  /** Key prefix without leading or trailing slashes ('' for the bucket root). */
  prefix: string
}

/** `s3://bucket/some/prefix` → { bucket, prefix }. */
export function parseS3Url(url: string): S3Target {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])(?:\/(.*))?$/.exec(url.trim())
  if (!match) throw new Error(`Not an s3:// URL: ${url} (expected s3://bucket/optional/prefix).`)
  return { bucket: match[1], prefix: (match[2] ?? '').replace(/^\/+|\/+$/g, '') }
}

/** The object key: the prefix, then the recording's year and month, then the file name. */
export function objectKey(target: S3Target, file: string, at: Date): string {
  const month = `${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, '0')}`
  return [target.prefix, month, basename(file)].filter(Boolean).join('/')
}

export interface S3Credentials {
  /** e.g. https://<account-id>.r2.cloudflarestorage.com */
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  region: string
}

/** Credentials from the standard variables, plus `S3_ENDPOINT` for non-AWS storage. */
export function credentialsFromEnv(env = process.env): S3Credentials {
  const missing = ['S3_ENDPOINT', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].filter((k) => !env[k])
  if (missing.length) throw new Error(`To upload, set ${missing.join(', ')}.`)
  return {
    endpoint: env.S3_ENDPOINT!.replace(/\/+$/, ''),
    accessKeyId: env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    // R2 takes "auto"; AWS needs the bucket's region.
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? 'auto'
  }
}

const CONTENT_TYPES: Record<string, string> = { webm: 'video/webm', json: 'application/json', png: 'image/png' }

/** Uploads `file` to `key` (path-style URL) and returns the object's s3:// URL. */
export async function uploadFile(file: string, target: S3Target, key: string, creds: S3Credentials): Promise<string> {
  const client = new AwsClient({ accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, service: 's3', region: creds.region })
  const url = `${creds.endpoint}/${target.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`
  const extension = file.split('.').pop() ?? ''
  const response = await client.fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'Content-Length': String(statSync(file).size),
      // The body is streamed, so it is not hashed into the signature.
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD'
    },
    body: Readable.toWeb(createReadStream(file)) as ReadableStream,
    duplex: 'half'
  } as RequestInit)
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 300)
    throw new Error(`Upload of ${basename(file)} failed: HTTP ${response.status} ${detail}`)
  }
  return `s3://${target.bucket}/${key}`
}
