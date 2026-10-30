import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// @ts-expect-error a plain JS module shared with the extension
import { setWebmDuration } from '../shared/webm-duration.js'

// Recorded by Chrome's MediaRecorder as the extension records (vp9/opus, 1 s chunks), 5 s: no duration.
const recording = readFileSync(new URL('./fixtures/mediarecorder.webm', import.meta.url))
const FIRST_CHUNK = 18216
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0

describe('WebM duration', () => {
  it('is added to the header of a MediaRecorder file', () => {
    const fixed = setWebmDuration(new Uint8Array(recording.subarray(0, FIRST_CHUNK)), 5000)
    expect(fixed).not.toBeNull()
    expect(fixed.end).toBeLessThan(FIRST_CHUNK)
    // Duration (0x4489), 8 bytes, 5000 ms at the default 1 ms scale.
    const value = new Uint8Array(8)
    new DataView(value.buffer).setFloat64(0, 5000)
    expect(Buffer.from(fixed.head).includes(Buffer.from([0x44, 0x89, 0x88, ...value]))).toBe(true)
    // Done twice, the duration is replaced, not added again.
    const again = setWebmDuration(fixed.head, 4000)
    expect(again.head.length).toBe(fixed.head.length)
  })

  it.skipIf(!hasFfprobe)('makes the file report its duration', () => {
    const fixed = setWebmDuration(new Uint8Array(recording.subarray(0, FIRST_CHUNK)), 5000)
    const file = join(mkdtempSync(join(tmpdir(), 'mr-webm-')), 'fixed.webm')
    writeFileSync(file, Buffer.concat([fixed.head, recording.subarray(fixed.end)]))
    const probe = (f: string): string => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], { encoding: 'utf8' }).trim()
    expect(Number(probe(file))).toBeCloseTo(5, 0)
    // The media is untouched: every packet still decodes.
    expect(spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']).stderr.toString()).toBe('')
  })

  it('leaves what it does not understand as it is', () => {
    expect(setWebmDuration(new Uint8Array([1, 2, 3, 4]), 1000)).toBeNull()
    // Only the start of the header: the Info is not all there.
    expect(setWebmDuration(new Uint8Array(recording.subarray(0, 60)), 1000)).toBeNull()
  })
})
