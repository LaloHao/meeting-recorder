# meeting-recorder — notes for development

An agent that joins a Google Meet call in its own Chrome, records what is presented, the
participants' audio and who spoke when, and writes `<name>.webm` + `<name>.json`
(`video-context-recording/1`, read by [video-context](https://github.com/LaloHao/video-context)).
Runs locally, in a container, or as one Kubernetes Job per meeting. User-facing docs:
[README.md](README.md), [docs/kubernetes.md](docs/kubernetes.md).

## Commands

```bash
pnpm install
pnpm typecheck && pnpm test          # unit tests: everything that needs no browser
pnpm build                           # dist/ — always run the compiled code (see pitfalls)
node dist/cli.js join <meet-url> -p <profile> [--show]
pnpm build:extension                 # dist/extension (Load unpacked)
docker build -t meeting-recorder:local .
helm lint deploy/helm/meeting-recorder --set storage.s3.url=s3://b --set storage.s3.endpoint=https://e
```

## Layout

| Path | What |
| --- | --- |
| `src/cli.ts` | Commands: login, profiles, logout, export-profile, join, k8s … |
| `src/session.ts` | One recording: join, record, detect the end, finalize, upload. Saves what reached the disk on any failure. |
| `src/chrome.ts` | Finding/launching Chrome (own process group, CDP, Xvfb), named profiles, clean start. |
| `src/meet.ts` | Meet specifics: join, waiting room, Spotlight, call state, captions language. |
| `src/tab-recorder.ts` | getDisplayMedia (video) + Meet's `<audio>` streams mixed in WebAudio → MediaRecorder → disk every second. |
| `shared/meet-speakers.js` | Speaker detector (captions + tile indicator), shared with the extension. Plain JS evaluated in the page. |
| `src/profile-archive.ts`, `src/upload.ts` | Session export/import; S3/R2 upload (aws4fetch). |
| `src/k8s.ts`, `src/k8s-job.ts` | The `k8s` commands; the Job built from the chart's ConfigMap `meeting-recorder-settings`. |
| `deploy/helm/meeting-recorder` | Chart: settings ConfigMap, ResourceQuota, optional recordings PVC. |
| `extension/` | Browser extension (record a tab you are in). |

## Testing against Meet

There is no automated end-to-end test: Meet needs a real call and a signed-in account. To
test a change, create a meeting with another account, run `join` (add `--show` to watch),
let the agent in, speak and present, then leave; check the log, the `.json` turns and frames
of the video (`ffmpeg -ss <t> -frames:v 1`), and the audio level (`astats`).

When a step fails before recording, the agent saves a screenshot next to the recordings; the
log says what it saw (e.g. menu items), to adjust labels when Meet changes.

## Pitfalls (learned the hard way)

- **Never use copies of a Google session in two places.** Google rotates session cookies and
  ends a session it sees used from two copies. Don't export a real profile "to try"; mount
  the profile itself in containers; one recording per account at a time.
- **Run compiled code.** tsx injects a `__name` helper into functions, which breaks the ones
  passed to `page.evaluate`.
- **Playwright `timeout: 0` means wait forever**, not "don't wait".
- **`pkill -f <pattern>` kills your own shell** when the pattern appears in the command you
  run. Match on something only the target has (e.g. its `--user-data-dir`), from a script.
- Meet's waiting room also has a Leave button and the agent's own tile: "in the call" means
  participant tiles **and** no waiting message.
- `context.pages()` lists Chrome UI (the omnibox popup) as pages: pick the tab by URL.
- Tab capture misses remote WebRTC audio, and MediaRecorder never starts with silent audio
  (nobody speaking yet): that's why audio is mixed from `<audio>` elements with a constant
  silent source.
- In containers Chrome needs `--no-sandbox` (`MEETING_RECORDER_CHROME_FLAGS`) and a 1 GiB
  `/dev/shm`.

## Conventions

- English for code, comments and docs. Match the surrounding style (no semicolons, single
  quotes, concise comments that say why).
- Public repository: commit messages carry no AI attribution trailers. Nothing about any
  particular deployment (hosts, buckets, accounts) goes in here.
