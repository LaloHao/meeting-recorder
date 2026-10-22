// The files a recording leaves: `<name>.webm` and `<name>.json`, the recording
// file video-context reads (title, start time, who spoke when).

import { spawn } from 'node:child_process'

export const RECORDING_SCHEMA = 'video-context-recording/1'

export interface SpeakerTurn {
  name: string
  /** Seconds from the start of the video. */
  start: number
  end: number
  source: 'captions' | 'indicator'
}

export interface RecordingFile {
  schema: typeof RECORDING_SCHEMA
  source: 'meeting-recorder' | 'chrome-extension'
  platform: 'meet'
  title: string
  url: string
  recordingStartedAt: string
  recordingEndedAt: string
  durationSeconds: number
  speakers: SpeakerTurn[]
}

export function recordingFile(r: {
  title: string
  url: string
  startedAtMs: number
  endedAtMs: number
  speakers: SpeakerTurn[]
}): RecordingFile {
  return {
    schema: RECORDING_SCHEMA,
    source: 'meeting-recorder',
    platform: 'meet',
    title: r.title,
    // The link without query parameters (authuser, hl…).
    url: r.url.split('?')[0],
    recordingStartedAt: new Date(r.startedAtMs).toISOString(),
    recordingEndedAt: new Date(r.endedAtMs).toISOString(),
    durationSeconds: Math.round((r.endedAtMs - r.startedAtMs) / 10) / 100,
    speakers: [...r.speakers].sort((a, b) => a.start - b.start)
  }
}

/** `2026-10-22_16-05-09_Daily standup`: sortable, and safe as a file name. */
export function baseName(title: string, at: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}_` +
    `${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return safe ? `${stamp}_${safe}` : stamp
}

/**
 * Rewrites the recorded WebM without re-encoding: adds the duration and seek
 * index MediaRecorder leaves out, and drops Chrome's `alpha_mode=1` tag (tab
 * captures have no alpha, and GStreamer-based players fail on it).
 */
export function finalizeVideo(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', input, '-map', '0', '-c', 'copy', '-metadata:s:v', 'alpha_mode=', output], {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().slice(-300)}`))))
  })
}
