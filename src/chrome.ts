// Finding and launching Chrome with the agent's own profile.

import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { chromium, type BrowserContext, type Page } from 'playwright-core'

const CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']

/**
 * Sign-in (plain Chrome) and recording (automated Chrome) must encrypt cookies the
 * same way, or the recording browser can't read the session and Chrome discards it.
 * The basic store needs no system keyring, which a server or container doesn't have;
 * the profile folder is kept private instead.
 */
const PASSWORD_STORE = '--password-store=basic'
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * Extra switches for the environment, e.g. --no-sandbox where a container can't give
 * Chrome the user namespaces its sandbox needs.
 */
function environmentFlags(): string[] {
  return (process.env.MEETING_RECORDER_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean)
}

/** Chrome's executable: `CHROME_PATH`, or the first Chrome/Chromium on PATH. */
export function findChrome(): string {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  if (process.platform === 'darwin' && existsSync(MAC_CHROME)) return MAC_CHROME
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const name of CANDIDATES) {
      const path = join(dir, name)
      // Wrapper scripts (e.g. Nix's) are fine to launch; resolve symlinks for a stable path.
      if (existsSync(path)) return realpathSync(path)
    }
  }
  throw new Error('Chrome not found: install Google Chrome or Chromium, or set CHROME_PATH.')
}

export const DEFAULT_PROFILE = 'default'

/** Where the agent's Chrome profiles live: one folder per profile name. */
export function profilesRoot(): string {
  return process.env.MEETING_RECORDER_PROFILES ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'meeting-recorder', 'profiles')
}

export function validProfileName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)
}

/** A Chrome profile of the agent, where its Google sign-in (if any) is kept. */
export function profileDir(name = DEFAULT_PROFILE): string {
  if (!validProfileName(name)) throw new Error(`Invalid profile name "${name}": use letters, digits, ".", "_" and "-".`)
  const dir = join(profilesRoot(), name)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

export interface ProfileInfo {
  name: string
  /** Whether the profile has a Google session (null: could not tell). */
  signedIn: boolean | null
  /** Accounts signed in to Chrome itself, when Chrome records them. */
  accounts: string[]
}

export async function listProfiles(): Promise<ProfileInfo[]> {
  const root = profilesRoot()
  if (!existsSync(root)) return []
  const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && validProfileName(d.name))
  return Promise.all(
    dirs.map(async (d) => ({ name: d.name, signedIn: await hasGoogleSession(join(root, d.name)), accounts: signedInAccounts(join(root, d.name)) }))
  )
}

/**
 * Whether the profile holds Google's session cookie. Only the cookie's name and
 * domain are read (its value is encrypted); a copy is read, as Chrome may hold
 * the database open.
 */
export async function hasGoogleSession(dir: string): Promise<boolean | null> {
  const db = [join(dir, 'Default', 'Network', 'Cookies'), join(dir, 'Default', 'Cookies')].find(existsSync)
  if (!db) return false
  const tmp = mkdtempSync(join(tmpdir(), 'meeting-recorder-'))
  try {
    copyFileSync(db, join(tmp, 'Cookies'))
    const { DatabaseSync } = await import('node:sqlite')
    const conn = new DatabaseSync(join(tmp, 'Cookies'), { readOnly: true })
    const row = conn.prepare("SELECT 1 FROM cookies WHERE host_key = '.google.com' AND name = 'SID' LIMIT 1").get()
    conn.close()
    return Boolean(row)
  } catch {
    return null
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

function signedInAccounts(dir: string): string[] {
  try {
    const prefs = JSON.parse(readFileSync(join(dir, 'Default', 'Preferences'), 'utf8')) as { account_info?: { email?: string }[] }
    return (prefs.account_info ?? []).map((a) => a.email ?? '').filter(Boolean)
  } catch {
    return []
  }
}

export function removeProfile(name: string): boolean {
  if (!validProfileName(name)) return false
  const dir = join(profilesRoot(), name)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

export const WINDOW = { width: 1920, height: 1080 }

export interface RecorderBrowser {
  context: BrowserContext
  /** Closes Chrome (and makes sure its process is gone). */
  close(): Promise<void>
}

/**
 * Where the agent's Chrome draws: `virtual` is an off-screen X display (Xvfb) of the
 * recording size, invisible to the person and the same as in a container; `window`
 * is a regular window on the desktop, to watch the agent.
 */
export type Display = 'virtual' | 'window'

/** `virtual` when Xvfb is available (Linux), otherwise `window`. */
export function defaultDisplay(): Display {
  return process.platform === 'linux' && onPath('Xvfb') ? 'virtual' : 'window'
}

function onPath(name: string): boolean {
  return (process.env.PATH ?? '').split(delimiter).some((dir) => existsSync(join(dir, name)))
}

/** Starts Xvfb on a free display number (it reports the number it picked). */
async function startVirtualDisplay(): Promise<{ display: string; stop(): void }> {
  // Xvfb's socket directory; only root may create it at startup, and in a container
  // /tmp starts empty.
  try {
    mkdirSync('/tmp/.X11-unix', { recursive: true, mode: 0o1777 })
  } catch {
    /* exists, or Xvfb will report the problem */
  }
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', `${WINDOW.width}x${WINDOW.height}x24`, '-nolisten', 'tcp'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe']
  })
  const stop = (): void => {
    try {
      if (xvfb.pid) process.kill(-xvfb.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const display = await new Promise<string>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('Xvfb did not start in time.')), 10_000)
    xvfb.stdio[3]!.on('data', (d: Buffer) => {
      out += d.toString()
      if (out.includes('\n')) {
        clearTimeout(timer)
        resolve(`:${out.trim()}`)
      }
    })
    xvfb.once('exit', (code) => reject(new Error(`Xvfb exited (code ${code}).`)))
  }).catch((error: Error) => {
    stop()
    throw error
  })
  return { display, stop }
}

/**
 * Chrome for recording: tab capture is accepted without a prompt, and a hidden or
 * covered window keeps rendering.
 *
 * Chrome is started as its own process group and driven over the DevTools
 * protocol, rather than launched by Playwright: Ctrl+C in the terminal then
 * reaches only the agent, which stops and saves the recording before closing
 * Chrome, and Chrome carries no automation switches. The DevTools port listens on
 * 127.0.0.1 only, on a random port, for as long as the recording lasts.
 */
export async function launchRecorderBrowser(opts: { display?: Display; profile?: string; userDataDir?: string } = {}): Promise<RecorderBrowser> {
  // An imported session (see profile-archive.ts) comes as a folder of its own.
  const dir = opts.userDataDir ?? profileDir(opts.profile)
  startClean(dir)
  const portFile = join(dir, 'DevToolsActivePort')
  rmSync(portFile, { force: true })

  const virtual = (opts.display ?? defaultDisplay()) === 'virtual' ? await startVirtualDisplay() : null
  const env = { ...process.env }
  if (virtual) {
    env.DISPLAY = virtual.display
    delete env.WAYLAND_DISPLAY // draw on the virtual X display, not the desktop's Wayland session
  }

  const args = [
    `--user-data-dir=${dir}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    '--window-position=0,0',
    ...(virtual ? ['--ozone-platform=x11'] : []),
    '--auto-accept-this-tab-capture',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    PASSWORD_STORE,
    ...environmentFlags(),
    'about:blank'
  ]
  const child = spawn(findChrome(), args, { detached: true, stdio: 'ignore', env })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const kill = (): void => {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
    virtual?.stop()
  }
  // If the agent dies, Chrome must not stay behind holding the session.
  process.once('exit', kill)

  try {
    const port = await waitForPort(portFile, child, 30_000)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const context = browser.contexts()[0]
    if (!context) throw new Error('Chrome started without a browser context.')
    return {
      context,
      async close() {
        await browser.close().catch(() => {})
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
        kill()
      }
    }
  } catch (error) {
    kill()
    throw error
  }
}

/**
 * Every recording starts from an empty window: no tabs restored from the last run
 * (e.g. a meeting still in its waiting room after an interrupted run) and no
 * "restore pages?" prompt. Only the session, not the sign-in, is cleared.
 */
function startClean(dir: string): void {
  rmSync(join(dir, 'Default', 'Sessions'), { recursive: true, force: true })
  const prefsPath = join(dir, 'Default', 'Preferences')
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, any>
    prefs.profile = { ...prefs.profile, exit_type: 'Normal', exited_cleanly: true }
    prefs.session = { ...prefs.session, restore_on_startup: 5 }
    writeFileSync(prefsPath, JSON.stringify(prefs))
  } catch {
    /* a new profile has no preferences yet */
  }
}

/** Chrome writes its DevTools port to `DevToolsActivePort` once it is ready. */
async function waitForPort(file: string, child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Chrome exited (code ${child.exitCode}) before starting: is another Chrome using this profile?`)
    if (existsSync(file)) {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0])
      if (port > 0) return port
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('Chrome did not start in time.')
}

/**
 * The tab to record in, in a window of the recording size. `context.pages()` also
 * lists Chrome's own UI (e.g. the omnibox popup, which has no window), so the tab
 * is picked by its URL; and Chrome restores the window size it last had in this
 * profile, so the size is set explicitly.
 */
export async function recorderPage(context: BrowserContext): Promise<Page> {
  const page = context.pages().find((p) => !p.url().startsWith('chrome://')) ?? (await context.newPage())
  for (const other of context.pages()) if (other !== page && !other.url().startsWith('chrome://')) await other.close()
  const cdp = await context.newCDPSession(page)
  const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number }
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: WINDOW.width, height: WINDOW.height } })
  await cdp.detach()
  await page.bringToFront()
  return page
}

/**
 * Opens plain Chrome (not automated) on the agent's profile so the person can sign
 * in: Google refuses sign-ins from automated browsers. Resolves when Chrome closes.
 */
export function openProfileForSignIn(url: string, profile = DEFAULT_PROFILE): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(findChrome(), [`--user-data-dir=${profileDir(profile)}`, PASSWORD_STORE, '--no-first-run', ...environmentFlags(), url], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}
