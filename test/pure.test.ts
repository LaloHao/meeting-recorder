import { readFileSync } from 'node:fs'
import { runInThisContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { englishUrl, isMeetUrl, meetingCode } from '../src/meet.js'
import { baseName, recordingFile, RECORDING_SCHEMA } from '../src/recording-file.js'

describe('meet urls', () => {
  it('recognises Meet links and their code', () => {
    expect(isMeetUrl('https://meet.google.com/abc-defg-hij')).toBe(true)
    expect(isMeetUrl('https://zoom.us/j/123')).toBe(false)
    expect(isMeetUrl('not a url')).toBe(false)
    expect(meetingCode('https://meet.google.com/abc-defg-hij?authuser=1')).toBe('abc-defg-hij')
    expect(meetingCode('https://meet.google.com/landing')).toBeNull()
    expect(englishUrl('https://meet.google.com/abc-defg-hij?authuser=1')).toBe('https://meet.google.com/abc-defg-hij?authuser=1&hl=en')
  })
})

describe('recording file', () => {
  it('names files by time and title, safely', () => {
    const at = new Date(2026, 9, 22, 16, 5, 9)
    expect(baseName('Daily: equipo / pagos', at)).toBe('2026-10-22_16-05-09_Daily equipo pagos')
    expect(baseName('   ', at)).toBe('2026-10-22_16-05-09')
  })

  it('writes the schema video-context reads, turns in order', () => {
    const file = recordingFile({
      title: 'Daily',
      url: 'https://meet.google.com/abc-defg-hij?authuser=1&hl=en',
      startedAtMs: Date.UTC(2026, 9, 22, 16, 0, 0),
      endedAtMs: Date.UTC(2026, 9, 22, 16, 30, 0, 123),
      speakers: [
        { name: 'Carlos', start: 20, end: 30, source: 'captions' },
        { name: 'Ana', start: 1, end: 10, source: 'captions' }
      ]
    })
    expect(file.schema).toBe(RECORDING_SCHEMA)
    expect(file.url).toBe('https://meet.google.com/abc-defg-hij')
    expect(file.recordingStartedAt).toBe('2026-10-22T16:00:00.000Z')
    expect(file.durationSeconds).toBe(1800.12)
    expect(file.speakers.map((s) => s.name)).toEqual(['Ana', 'Carlos'])
  })
})

describe('speaker names from a tile', () => {
  // The detector is a plain script for the page: run here, it defines its functions all the same.
  runInThisContext(readFileSync(new URL('../shared/meet-speakers.js', import.meta.url), 'utf8'))
  const { nameFromLines } = (globalThis as unknown as { __vcSpeakers: { nameFromLines(lines: string[], controls: Set<string>): string } }).__vcSpeakers

  it('takes the name, not an icon or a control', () => {
    expect(nameFromLines(['mic_off', 'Daniela Carrizales', 'Mute'], new Set())).toBe('Daniela Carrizales')
    expect(nameFromLines(['Ana López', 'more_vert', 'Pin'], new Set())).toBe('Ana López')
    expect(nameFromLines(['Luis', 'Más opciones'], new Set())).toBe('Luis')
    expect(nameFromLines(['Carlos', 'Pin Carlos to your main screen'], new Set(['Pin Carlos to your main screen']))).toBe('Carlos')
    // A name that only starts like a control word is still a name.
    expect(nameFromLines(['Pinto Ramírez'], new Set())).toBe('Pinto Ramírez')
    expect(nameFromLines(['Mute'], new Set())).toBe('')
  })
})
