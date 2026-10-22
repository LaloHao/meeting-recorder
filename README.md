# meeting-recorder

**Send an agent to a video meeting and get back what was shared on screen, the audio, and
who spoke when.**

The agent joins a Google Meet call in its own Chrome, records it, and leaves when the call is
over. The result is a video plus a small `.json` file that
[video-context](https://github.com/LaloHao/video-context) reads to turn the meeting into a
searchable transcript with speaker names and key frames.

- **What is shared comes first.** The agent switches Meet to the *Spotlight* layout: a
  presentation fills the frame; with no presentation, whoever is speaking does. Call controls,
  side panels and captions are kept off the picture.
- **Every voice.** The participants' audio is recorded from the call itself, including the
  sound of a presented tab.
- **Who spoke when.** Meet's live captions name each speaker (they stay on, off screen); the
  speaking indicator of each tile is a fallback.
- **Invisible on Linux.** Chrome draws on a virtual display of 1920×1080, so nothing opens on
  your desktop and the frame size does not depend on your monitors.

Also in this repository: a [browser extension](#browser-extension) that records a meeting tab
you are in yourself, with the same output.

> Recording people usually needs their consent. The agent joins under its account's name and
> is visible in the participant list; tell the people in the meeting that it is recording.

## Quick start

```bash
pnpm install && pnpm build

# 1. Once: sign the agent's Chrome profile in to Google (a normal Chrome window opens)
node dist/cli.js login

# 2. Send it to a meeting; it asks to join, so let it in from the meeting
node dist/cli.js join https://meet.google.com/abc-defg-hij --language es

# 3. Analyse the recording
npx -p @lalohao/video-context video-context recordings/2026-10-22_16-05-09_Daily.webm --language es
```

```
[4:05:01 PM] Profile "default" is signed in to Google.
[4:05:10 PM] Asked to join; waiting for the host to let the agent in…
[4:05:31 PM] In the call.
[4:05:34 PM] Layout: Spotlight.
[4:05:34 PM] Recording.
[4:05:44 PM] Audio: 3 participant stream(s) being recorded.
[4:41:02 PM] Stopping: alone in the call for 2 min.
Video:     recordings/2026-10-22_16-05-34_Daily.webm
Recording: recordings/2026-10-22_16-05-34_Daily.json
```

## Requirements

| Tool | Needed for | Install |
| --- | --- | --- |
| Node.js 22.5+ | everything | [nodejs.org](https://nodejs.org) |
| Google Chrome or Chromium | the agent | found on `PATH`, or set `CHROME_PATH` |
| `ffmpeg` | finishing the video (duration and seek index) | `apt install ffmpeg` · `brew install ffmpeg` |
| `Xvfb` | the invisible virtual display (Linux, optional) | `apt install xvfb` |

Without Xvfb (or with `--show`) the agent's Chrome opens as a regular window.

## Command line

```
meeting-recorder login [-p <profile>]  Open an agent profile in Chrome to sign in, or to switch account
meeting-recorder join <url> [options]  Join a Google Meet call and record it
meeting-recorder profiles              List the agent profiles and whether they are signed in
meeting-recorder logout <profile>      Delete a profile and its session

Options for join:
  -p, --profile <name>     Agent profile to join with (default: default)
  -o, --out <dir>          Folder for the recording (default: ./recordings)
  -t, --title <title>      Recording title (default: the meeting's title or code)
  -l, --language <code>    Spoken language (es, en, pt, fr, de, it), for Meet's captions
      --guest-name <name>  Name to join with when the profile is not signed in
      --alone <minutes>    Leave after this long alone in the call (default: 2)
      --max <minutes>      Stop after this long (default: 240)
      --show               Show the agent's Chrome in a window
```

**Ctrl+C** stops the recording and saves it. If anything goes wrong mid-meeting (the call
ends, the page closes), what was recorded until then is saved too.

### Profiles

Each profile is a separate Chrome profile with its own Google session, in
`~/.config/meeting-recorder/profiles/<name>` (`MEETING_RECORDER_PROFILES`). Sign one in with
`login -p <name>`, use it with `join -p <name>`; running `login` again on a profile is how to
switch its account. Use a dedicated Google account for the agent if you don't want it to
appear under your name.

The sign-in happens in plain Chrome, not in the automated one: Google refuses sign-ins from
automated browsers, and Meet turns away guests without an account that come from them (so
`--guest-name` rarely gets in). Cookies are stored with Chrome's basic password store, which
needs no system keyring; the profile folder is readable only by you.

## The recording

`<date>_<title>.webm` (VP9 + Opus) and `<date>_<title>.json`:

```json
{
  "schema": "video-context-recording/1",
  "source": "meeting-recorder",
  "platform": "meet",
  "title": "Daily",
  "url": "https://meet.google.com/abc-defg-hij",
  "recordingStartedAt": "2026-10-22T16:05:34.012Z",
  "recordingEndedAt": "2026-10-22T16:41:02.530Z",
  "durationSeconds": 2128.52,
  "speakers": [
    { "name": "Ana", "start": 12.4, "end": 18.9, "source": "captions" },
    { "name": "Carlos", "start": 19.1, "end": 31.0, "source": "captions" }
  ]
}
```

Speaker times are seconds from the start of the video. `source` is `captions` (Meet's live
captions) or `indicator` (a tile's speaking animation: coarser, and only for people on
screen); readers should prefer caption turns when there are any. This is the format
video-context reads next to a video.

## How it works

1. Chrome starts in its own process group (so Ctrl+C reaches only the agent, which saves
   before closing it) on the agent's profile, and is driven over the DevTools protocol with
   [Playwright](https://playwright.dev). On Linux it draws on an Xvfb display.
2. The agent opens the meeting in English (`hl=en`, so the labels it looks for match), turns
   microphone and camera off, and asks to join. It counts as in the call once participant
   tiles show and the waiting message is gone.
3. It switches to Spotlight, closes the side panel and hides the call controls.
4. The tab is captured with `getDisplayMedia` (accepted without a prompt by
   `--auto-accept-this-tab-capture`). Chrome's capture of a tab's own audio misses the remote
   WebRTC audio, so the audio is instead the mix of the streams Meet plays in its `<audio>`
   elements, plus a silent source so recording starts before anyone speaks. A MediaRecorder
   writes a chunk to disk every second.
5. The speaker detector ([shared/meet-speakers.js](shared/meet-speakers.js), also used by the
   extension) turns captions on, moves them off screen, and reports turns.
6. It leaves when the call ends, after being alone for `--alone` minutes, at `--max`, or on
   Ctrl+C; then ffmpeg rewrites the WebM without re-encoding to add its duration and seek
   index and drop Chrome's `alpha_mode` tag, which some players fail on.

## Browser extension

`pnpm build:extension` assembles it in `dist/extension`; load it in `chrome://extensions` →
*Load unpacked*. It records the tab you are in (video, the tab's audio and your microphone)
and, on Meet, who speaks, into `Downloads/meeting-recorder/` with the same `.json` file.

## Limitations

- Google Meet only for now; Teams (web) and Zoom are next.
- The agent relies on Meet's labels and page structure, which Google changes from time to
  time: when a step fails, the log says what the agent saw (and the page is saved as a
  screenshot) to adjust it.
- With the speaking indicator only (no captions), names come from the tiles on screen.
- The sound of a presentation is recorded only when the presenter shares it (a tab with
  audio).

## Development

```bash
pnpm typecheck && pnpm test   # unit tests of the parts that need no browser
pnpm build && node dist/cli.js join <url>
```

Run the compiled code: tsx rewrites functions (adding a `__name` helper) and breaks the code
the agent evaluates inside the meeting page.

## License

MIT
