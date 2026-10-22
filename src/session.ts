// One recording: join the meeting, record the tab and who speaks, leave when the
// call is over, and write `<name>.webm` + `<name>.json`.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { launchRecorderBrowser, recorderPage, WINDOW, type Display } from './chrome.js'
import { arrangeMeetView, isMeetUrl, joinMeet, leaveMeet, meetingCode, meetState, setCaptionsLanguage } from './meet.js'
import { baseName, finalizeVideo, recordingFile, type SpeakerTurn } from './recording-file.js'
import { importSession } from './profile-archive.js'
import { startTabRecording, type TabRecording } from './tab-recorder.js'
import { credentialsFromEnv, objectKey, parseS3Url, uploadFile } from './upload.js'

const DETECTOR = fileURLToPath(new URL('../shared/meet-speakers.js', import.meta.url))

export interface RecordOptions {
  url: string
  /** Folder for the files. Default `./recordings`. */
  outDir?: string
  /** Default: the meeting's title in Meet, or its code. */
  title?: string
  /** Name shown when joining without a Google account. */
  guestName?: string
  /** Agent profile (and so Google account) to join with. Default `default`. */
  profile?: string
  /** A session exported with `export-profile`, used instead of a local profile (containers). */
  profileArchive?: string
  /** `s3://bucket/prefix`: upload the files there when done (credentials from the environment). */
  upload?: string
  /** Spoken language of the meeting (`es`, `en`…), for Meet's live captions. */
  language?: string
  /** Leave after this many minutes alone in the call. Default 2. */
  aloneMinutes?: number
  /** Stop recording after this many minutes. Default 240. */
  maxMinutes?: number
  /** Where Chrome draws: off screen (`virtual`, the default on Linux) or in a desktop window. */
  display?: Display
  ffmpeg?: string
  /** Resolves when the recording should stop early (e.g. Ctrl+C). */
  stopSignal?: Promise<void>
  log?(message: string): void
}

export interface RecordResult {
  /** s3:// URLs of the uploaded files, when uploading. */
  uploaded: string[]
  video: string
  recording: string
  durationSeconds: number
  speakers: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function recordMeeting(opts: RecordOptions): Promise<RecordResult> {
  if (!isMeetUrl(opts.url)) throw new Error('Only Google Meet links are supported for now (https://meet.google.com/…).')
  const log = opts.log ?? (() => {})
  const outDir = resolve(opts.outDir ?? process.env.MEETING_RECORDER_OUT ?? 'recordings')
  mkdirSync(outDir, { recursive: true })
  // Check the upload settings before joining, not after an hour of meeting.
  const target = opts.upload ? parseS3Url(opts.upload) : null
  const creds = target ? credentialsFromEnv() : null
  const upload = async (files: string[], at: Date): Promise<string[]> => {
    if (!target || !creds) return []
    const urls: string[] = []
    // The recording file goes last: its presence says the video is complete.
    for (const file of files) urls.push(await uploadFile(file, target, objectKey(target, file, at), creds))
    log(`Uploaded to ${urls.join(', ')}`)
    return urls
  }
  const imported = opts.profileArchive ? importSession(opts.profileArchive) : null

  const browser = await launchRecorderBrowser({ display: opts.display, profile: opts.profile, userDataDir: imported?.dir }).catch((error: unknown) => {
    imported?.cleanup()
    throw error
  })
  const context = browser.context
  const page = await recorderPage(context).catch(async (error: unknown) => {
    await browser.close()
    throw error
  })
  const partial = join(outDir, `.recording-${process.pid}.webm`)
  const turns: SpeakerTurn[] = []
  let recording: TabRecording | null = null
  let title = opts.title ?? meetingCode(opts.url) ?? 'Meeting'
  try {
    const signedIn = (await context.cookies('https://www.google.com')).some((c) => c.name === 'SID')
    log(signedIn ? `Profile "${opts.profile ?? 'default'}" has a Google session.` : `Profile "${opts.profile ?? 'default'}" has no Google session: joining as a guest.`)
    await joinMeet(page, opts.url, { guestName: opts.guestName, expectSignedIn: signedIn, log })
    await arrangeMeetView(page, log)

    recording = await startTabRecording(page, partial, WINDOW)
    log('Recording.')

    await page.exposeFunction('__vcSpeakerTurn', (turn: SpeakerTurn) => void turns.push(turn))
    await page.evaluate(readFileSync(DETECTOR, 'utf8'))
    await page.evaluate((startedAtMs) => {
      const g = globalThis as unknown as {
        __vcSpeakers: { start(o: object, emit: (t: unknown) => void): void }
        __vcSpeakerTurn(t: unknown): void
      }
      g.__vcSpeakers.start({ startedAtMs, autoCaptions: true, hideCaptions: true }, (t) => g.__vcSpeakerTurn(t))
    }, recording.startedAtMs)

    if (opts.language) {
      await sleep(2000) // the captions bar appears a moment after captions are turned on
      const set = await setCaptionsLanguage(page, opts.language)
      log(set === true ? `Captions language: ${opts.language}.` : `Could not set the captions language (${set}).`)
    }
    title = opts.title ?? (await meetTitle(page)) ?? title
    const rec = recording
    setTimeout(() => void rec.audioStreams().then((n) => log(`Audio: ${n} participant stream(s) being recorded.`), () => {}), 10_000)
    const reason = await waitForEnd(page, opts, log)
    log(`Stopping: ${reason}.`)
  } catch (error) {
    if (!recording) {
      // What the agent was looking at helps to tell why (a dialog, a sign-in wall…).
      const shot = join(outDir, `error-${Date.now()}.png`)
      if (await page.screenshot({ path: shot }).then(() => true, () => false)) {
        log(`Screenshot of the page: ${shot}`)
        // In a container the local folder goes away with the Pod.
        await upload([shot], new Date()).catch((e: Error) => log(`Could not upload the screenshot: ${e.message}`))
      }
      imported?.cleanup()
      await browser.close()
      rmSync(partial, { force: true })
      throw error
    }
    // Recording had started: whatever reached the disk is kept.
    log(`Recording interrupted (${error instanceof Error ? error.message : String(error)}); saving what was recorded.`)
  }

  // Each step may fail (the page or browser may be gone) without losing the recording.
  await page.evaluate(() => (globalThis as unknown as { __vcSpeakers?: { stop(): void } }).__vcSpeakers?.stop()).catch(() => {})
  await sleep(500) // the last turns travel through the exposed function
  await recording.stop().catch(() => log('The recorder was already stopped; the last second may be missing.'))
  const endedAtMs = Date.now()
  await leaveMeet(page)
  await browser.close()

  const name = baseName(title, new Date(recording.startedAtMs))
  const video = join(outDir, `${name}.webm`)
  try {
    await finalizeVideo(opts.ffmpeg ?? process.env.FFMPEG_PATH ?? 'ffmpeg', partial, video)
    rmSync(partial, { force: true })
  } catch (error) {
    // Keep the raw file: it is still playable, just without a seek index.
    renameSync(partial, video)
    log(`Could not finalize the video (${error instanceof Error ? error.message : String(error)}); kept it as recorded.`)
  }
  const file = recordingFile({ title, url: opts.url, startedAtMs: recording.startedAtMs, endedAtMs, speakers: turns })
  const json = join(outDir, `${name}.json`)
  writeFileSync(json, JSON.stringify(file, null, 2) + '\n')
  imported?.cleanup()
  const uploaded = await upload([video, json], new Date(recording.startedAtMs))
  return { video, recording: json, uploaded, durationSeconds: file.durationSeconds, speakers: [...new Set(turns.map((t) => t.name))] }
}

/** The meeting's title as Meet shows it (calendar events have one), if any. */
async function meetTitle(page: Page): Promise<string | null> {
  const title = (await page.title()).replace(/^Meet\s*[-–]\s*/i, '').trim()
  return title && !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(title) && title !== 'Meet' ? title : null
}

async function waitForEnd(page: Page, opts: RecordOptions, log: (m: string) => void): Promise<string> {
  const deadline = Date.now() + (opts.maxMinutes ?? 240) * 60_000
  const aloneLimit = (opts.aloneMinutes ?? 2) * 60_000
  let aloneSince: number | null = null
  let stopRequested = false
  opts.stopSignal?.then(() => (stopRequested = true))

  for (;;) {
    if (stopRequested) return 'stop requested'
    if (Date.now() >= deadline) return 'maximum duration reached'
    const state = await meetState(page).catch(() => ({ inCall: false, participants: null }))
    if (!state.inCall) return 'the call ended or the agent was removed'
    if (state.participants !== null && state.participants <= 1) {
      aloneSince ??= Date.now()
      if (Date.now() - aloneSince >= aloneLimit) return `alone in the call for ${opts.aloneMinutes ?? 2} min`
    } else if (aloneSince !== null) {
      aloneSince = null
      log('Someone is back in the call.')
    }
    await sleep(2000)
  }
}

type Page = Awaited<ReturnType<typeof recorderPage>>
