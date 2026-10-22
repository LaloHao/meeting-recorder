// Records the page's own tab with MediaRecorder, writing each one-second chunk to
// disk as it arrives, so a long meeting never sits in memory and a crash loses at
// most a second.
//
// Video is the tab capture. Audio is the participants' voices taken from the page's
// <audio>/<video> elements (where meeting apps play each remote WebRTC stream) and
// mixed: a capture of the tab's own audio misses remote WebRTC audio in Chrome,
// keeping only sounds the page itself plays (join chimes).

import { appendFileSync, writeFileSync } from 'node:fs'

import type { Page } from 'playwright-core'

export interface TabRecording {
  /** When the first frame was recorded (ms since the epoch): t = 0 of the file. */
  startedAtMs: number
  /** Stops and waits until every chunk is on disk. */
  stop(): Promise<void>
  /** Remote audio streams mixed into the recording so far. */
  audioStreams(): Promise<number>
}

export async function startTabRecording(page: Page, file: string, size: { width: number; height: number }): Promise<TabRecording> {
  writeFileSync(file, '')
  await page.exposeFunction('__vcChunk', (base64: string) => appendFileSync(file, Buffer.from(base64, 'base64')))

  const startedAtMs = await page.evaluate(async ({ width, height }) => {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 15, max: 15 } },
      audio: false,
      // With Chrome's --auto-accept-this-tab-capture, this tab is captured without a picker.
      preferCurrentTab: true,
      selfBrowserSurface: 'include'
    } as DisplayMediaStreamOptions)

    // The mix of every remote stream the page plays, picked up as elements appear.
    const audio = new AudioContext({ sampleRate: 48_000 })
    await audio.resume()
    const mix = audio.createMediaStreamDestination()
    // A constant silent source keeps audio flowing before anyone speaks: with no audio
    // at all, MediaRecorder never starts writing (video included).
    const silence = audio.createConstantSource()
    silence.offset.value = 0
    silence.connect(mix)
    silence.start()
    const connected = new WeakSet<MediaStream>()
    const collect = (): void => {
      for (const el of document.querySelectorAll('audio, video')) {
        const src = (el as HTMLMediaElement).srcObject
        if (!(src instanceof MediaStream) || connected.has(src) || src.getAudioTracks().length === 0) continue
        connected.add(src)
        audio.createMediaStreamSource(src).connect(mix)
        ;(window as unknown as { __vcAudioStreams: number }).__vcAudioStreams += 1
      }
    }
    ;(window as unknown as { __vcAudioStreams: number }).__vcAudioStreams = 0
    collect()
    const collector = setInterval(collect, 1000)

    const stream = new MediaStream([...display.getVideoTracks(), ...mix.stream.getAudioTracks()])
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 128_000 })

    // Chunks are sent in order, one at a time.
    let pending = Promise.resolve()
    const send = async (blob: Blob): Promise<void> => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      await (window as unknown as { __vcChunk(b: string): Promise<void> }).__vcChunk(btoa(binary))
    }
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) pending = pending.then(() => send(e.data))
    }
    const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve(pending)))
    ;(window as unknown as { __vcStopRecording(): Promise<void> }).__vcStopRecording = async () => {
      clearInterval(collector)
      if (recorder.state !== 'inactive') recorder.stop()
      display.getTracks().forEach((t) => t.stop())
      await stopped
      await audio.close()
    }

    const started = new Promise<number>((resolve) => (recorder.onstart = () => resolve(Date.now())))
    recorder.start(1000)
    return started
  }, size)

  return {
    startedAtMs,
    stop: () => page.evaluate(() => (window as unknown as { __vcStopRecording(): Promise<void> }).__vcStopRecording()),
    audioStreams: () => page.evaluate(() => (window as unknown as { __vcAudioStreams: number }).__vcAudioStreams)
  }
}
