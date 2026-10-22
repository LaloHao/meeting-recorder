#!/usr/bin/env node
// meeting-recorder login | join <url> | profiles | logout <profile> | export-profile

import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_PROFILE, listProfiles, openProfileForSignIn, profilesRoot, removeProfile, validProfileName } from './chrome.js'
import { exportSession } from './profile-archive.js'
import { recordMeeting } from './session.js'

const HELP = `meeting-recorder — join a meeting and record what is shared, the audio, and who spoke when

Usage:
  meeting-recorder login [-p <profile>]  Open an agent profile in Chrome to sign in, or to switch account
  meeting-recorder join <url> [options]  Join a Google Meet call and record it
  meeting-recorder profiles              List the agent profiles and whether they are signed in
  meeting-recorder logout <profile>      Delete a profile and its session
  meeting-recorder export-profile [-p <profile>] [-o <file>]
                                         Write the profile's Google session as a small archive
                                         (for a container or a Kubernetes Secret); stdout by default

Each profile is a separate Chrome profile with its own Google session (default: "${DEFAULT_PROFILE}").

Options for join:
  -p, --profile <name>     Agent profile to join with (default: ${DEFAULT_PROFILE})
  -o, --out <dir>          Folder for the recording (default: ./recordings)
  -t, --title <title>      Recording title (default: the meeting's title or code)
  -l, --language <code>    Spoken language (es, en, pt, fr, de, it): Meet's captions, which name the speakers, listen for it
      --guest-name <name>  Name to join with when the profile is not signed in
      --alone <minutes>    Leave after this long alone in the call (default: 2)
      --max <minutes>      Stop after this long (default: 240)
      --show               Show the agent's Chrome in a window
      --profile-archive <file>  Use a session from export-profile instead of a local profile
      --upload <s3://bucket/prefix>  Upload the files when done (S3_ENDPOINT, AWS_ACCESS_KEY_ID,
                           AWS_SECRET_ACCESS_KEY; Cloudflare R2 works) (default on Linux: an invisible virtual display)

Options for logout:
  -y, --yes                Do not ask for confirmation

Ctrl+C (or SIGTERM) stops the recording and keeps what was recorded.
Profiles live in ${profilesRoot()} (MEETING_RECORDER_PROFILES).`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    profile: { type: 'string', short: 'p' },
    yes: { type: 'boolean', short: 'y' },
    title: { type: 'string', short: 't' },
    language: { type: 'string', short: 'l' },
    'guest-name': { type: 'string' },
    alone: { type: 'string' },
    max: { type: 'string' },
    show: { type: 'boolean' },
    'profile-archive': { type: 'string' },
    upload: { type: 'string' },
    help: { type: 'boolean', short: 'h' }
  }
})

const [command, url] = positionals
const profile = values.profile ?? DEFAULT_PROFILE
if (!validProfileName(profile)) throw new Error(`Invalid profile name "${profile}".`)
const log = (message: string): void => console.error(`[${new Date().toLocaleTimeString()}] ${message}`)
const minutes = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a number of minutes.`)
  return n
}

try {
  if (values.help || !command) {
    console.log(HELP)
  } else if (command === 'login') {
    console.error(`Profile "${profile}": sign in to Google (or switch account) in the window that opens, then close it.`)
    await openProfileForSignIn('https://accounts.google.com/', profile)
    const info = (await listProfiles()).find((p) => p.name === profile)
    console.error(info?.signedIn ? `Profile "${profile}" is signed in.` : `Profile "${profile}" saved, but no Google session was found in it.`)
  } else if (command === 'profiles') {
    const profiles = await listProfiles()
    if (profiles.length === 0) console.log('No profiles yet: create one with `meeting-recorder login`.')
    for (const p of profiles) {
      const state = p.signedIn === null ? 'unknown' : p.signedIn ? 'signed in' : 'not signed in'
      console.log(`${p.name}\t${state}${p.accounts.length ? `\t${p.accounts.join(', ')}` : ''}`)
    }
  } else if (command === 'logout' && url) {
    // `url` is the second positional: here, the profile name.
    const name = url
    if (!values.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await rl.question(`Delete profile "${name}" and its Google session? [y/N] `)
      rl.close()
      if (!/^y(es)?$/i.test(answer.trim())) process.exit(1)
    }
    console.error(removeProfile(name) ? `Profile "${name}" deleted.` : `There is no profile "${name}".`)
  } else if (command === 'export-profile') {
    const archive = exportSession(join(profilesRoot(), profile))
    if (values.out) {
      writeFileSync(values.out, archive, { mode: 0o600 })
      console.error(`Session of profile "${profile}" written to ${values.out} (${Math.ceil(archive.length / 1024)} KiB). It holds a Google sign-in: keep it private.`)
    } else if (process.stdout.isTTY) {
      throw new Error('The archive is binary: redirect it to a file (> profile.tgz) or use -o <file>.')
    } else {
      process.stdout.write(archive)
    }
  } else if (command === 'join' && url) {
    let requestStop: () => void = () => {}
    const stopSignal = new Promise<void>((r) => (requestStop = r))
    // Ctrl+C in a terminal, SIGTERM from Kubernetes when the Job or Pod is deleted.
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        log(`Stopping on ${signal}… (again to abort without saving)`)
        requestStop()
        process.once(signal, () => process.exit(130))
      })
    }
    const result = await recordMeeting({
      url,
      outDir: values.out,
      title: values.title,
      guestName: values['guest-name'],
      profile,
      profileArchive: values['profile-archive'],
      upload: values.upload,
      language: values.language,
      aloneMinutes: minutes(values.alone, 'alone'),
      maxMinutes: minutes(values.max, 'max'),
      display: values.show ? 'window' : undefined,
      stopSignal,
      log
    })
    console.log(`Video:     ${result.video}`)
    console.log(`Recording: ${result.recording}`)
    console.log(`Duration:  ${Math.round(result.durationSeconds)} s; speakers: ${result.speakers.join(', ') || 'none detected'}`)
    for (const u of result.uploaded) console.log(`Uploaded:  ${u}`)
  } else {
    console.log(HELP)
    process.exitCode = 2
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
