// Google Meet: joining a call, arranging the view for the recording, and telling
// when the call is over. The UI is forced to English (hl=en) so the labels below
// match; they are ARIA labels and button texts, which change less than Meet's
// generated class names.

import type { Page } from 'playwright-core'

const LEAVE_BUTTON = 'button[aria-label="Leave call"]'
// The waiting room also has a Leave button and a tile with the agent's own name,
// so being in the call is: tiles, and no waiting message.
const IN_CALL = '[data-participant-id]'
const WAITING = /please wait until a meeting host brings you into the call|asking to be let in|waiting for the host/i


export function isMeetUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'meet.google.com'
  } catch {
    return false
  }
}

/** The meeting URL with Meet's UI in English. */
export function englishUrl(url: string): string {
  const u = new URL(url)
  u.searchParams.set('hl', 'en')
  return u.toString()
}

/** The meeting code (`abc-defg-hij`) of a Meet URL, used as a fallback title. */
export function meetingCode(url: string): string | null {
  try {
    return new URL(url).pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] ?? null
  } catch {
    return null
  }
}

/** Clicks the button if it shows up within `timeout` ms (0: only if already visible). */
async function clickIfVisible(page: Page, name: RegExp, timeout = 0): Promise<boolean> {
  const button = page.getByRole('button', { name }).first()
  try {
    // In Playwright a timeout of 0 means "wait forever".
    if (timeout === 0) {
      if (!(await button.isVisible())) return false
    } else {
      await button.waitFor({ state: 'visible', timeout })
    }
    await button.click({ timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export interface JoinOptions {
  /** Name to show when joining without a Google account. */
  guestName?: string
  /** The profile is meant to be signed in: being asked for a name then means Google ended the session. */
  expectSignedIn?: boolean
  /** How long to wait to be let in, in ms. */
  admitTimeoutMs?: number
  log?(message: string): void
}

/** Opens the meeting and joins it with microphone and camera off; resolves once in the call. */
export async function joinMeet(page: Page, url: string, opts: JoinOptions = {}): Promise<void> {
  const log = opts.log ?? (() => {})
  await page.goto(englishUrl(url), { waitUntil: 'domcontentloaded' })

  // Without camera/microphone permission Meet asks how to continue.
  await clickIfVisible(page, /continue without (microphone and camera|camera|microphone)/i, 8000)

  // Meet asks for a name only when nobody is signed in.
  const nameInput = page.getByRole('textbox', { name: /your name/i })
  if (await nameInput.isVisible().catch(() => false)) {
    if (opts.expectSignedIn) {
      throw new Error(
        'The profile holds Google cookies, but Google no longer accepts them (the session was ended, e.g. after the ' +
          'same session was used from several copies of the profile). Sign in again with `meeting-recorder login`.'
      )
    }
    await nameInput.fill(opts.guestName ?? 'Meeting Recorder')
  }

  await clickIfVisible(page, /^turn off microphone/i)
  await clickIfVisible(page, /^turn off camera/i)

  const join = page.getByRole('button', { name: /^\s*(join now|ask to join|switch here|join here too)\b/i }).first()
  const blocked = page.getByText(/you can't join this video call/i).first()
  // Meet sometimes skips the join screen and puts the agent straight in the waiting room.
  const waiting = page.getByText(WAITING).first()
  const screen = await Promise.race([
    join.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'join' as const),
    waiting.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'waiting' as const),
    blocked.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'blocked' as const)
  ]).catch(() => null)
  if (screen === 'blocked') {
    throw new Error(
      'Meet refused the agent before asking the host ("You can\'t join this video call"). Meet turns away ' +
        'guests without a Google account from automated browsers: sign the agent in with `meeting-recorder login`.'
    )
  }
  if (screen === null) throw new Error('Could not find the "Join" button: is the link a Meet meeting, and is the agent allowed in?')
  if (screen === 'join') {
    const label = (await join.innerText()).trim()
    // Clicked from the page: Playwright's pointer click refuses buttons it considers outside the viewport.
    await join.evaluate((b) => (b as HTMLElement).click())
    log(label.toLowerCase().startsWith('ask') ? 'Asked to join; waiting for the host to let the agent in…' : 'Joining…')
  } else {
    log('In the waiting room; waiting for the host to let the agent in…')
  }

  const admitted = (async () => {
    const deadline = Date.now() + (opts.admitTimeoutMs ?? 10 * 60_000)
    while (!(await meetState(page)).inCall) {
      if (Date.now() > deadline) throw new Error('Nobody let the agent in.')
      await page.waitForTimeout(1000)
    }
  })()
  const denied = page
    .getByText(/you can't join this (call|video call)|someone in the call denied|your request to join was denied/i)
    .first()
    .waitFor({ state: 'visible', timeout: opts.admitTimeoutMs ?? 10 * 60_000 })
    .then(() => {
      throw new Error('The request to join was denied.')
    })
  await Promise.race([admitted, denied])
  log('In the call.')
}

/**
 * Prepares the view for the recording: Spotlight layout (what is presented fills
 * the window; with no presentation, whoever is speaking), and no call controls.
 */
export async function arrangeMeetView(page: Page, log: (m: string) => void = () => {}): Promise<void> {
  // Tips and notices that would cover the view.
  for (const name of [/^got it$/i, /^dismiss$/i]) await clickIfVisible(page, name)
  // Meet may open the People panel (e.g. after the host admits the agent); it takes a quarter of the view.
  await page.locator('aside[aria-label="Side panel"] button[aria-label="Close"]').first().click({ timeout: 2000 }).catch(() => {})

  const layout = await setSpotlight(page)
  log(layout === true ? 'Layout: Spotlight.' : `Could not switch the layout to Spotlight (${layout}); recording the default layout.`)

  await page.addStyleTag({
    content: '[role="region"][aria-label="Call controls"], [role="toolbar"][aria-label="Call controls"] { opacity: 0 !important; }'
  })
}

/** True, or what went wrong with the names Meet showed (to fix the labels when Meet changes them). */
async function setSpotlight(page: Page): Promise<true | string> {
  const names = (role: string): Promise<string[]> =>
    page.getByRole(role as 'menuitem').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText).trim().slice(0, 40)))
  let step = 'More options button'
  try {
    await page.getByRole('button', { name: /^more options$/i }).first().click({ timeout: 5000 })
    step = `"Change layout" item; menu: ${(await names('menuitem')).join(' | ')}`
    await page.getByRole('menuitem', { name: /change layout|adjust view/i }).first().click({ timeout: 5000 })
    step = `"Spotlight" option; radios: ${(await names('radio')).join(' | ')}`
    await page.getByRole('radio', { name: /spotlight/i }).first().check({ timeout: 5000 })
    await page.keyboard.press('Escape')
    return true
  } catch {
    await page.keyboard.press('Escape').catch(() => {})
    return `no ${step}`
  }
}

export interface CallState {
  inCall: boolean
  /**
   * People in the call (the agent included): from the People panel's list when it
   * is open, else the distinct participants with a tile on screen. With the
   * Spotlight layout that is the agent plus whoever is presenting or last spoke, so
   * it is 1 exactly when the agent is alone.
   */
  participants: number | null
}

export async function meetState(page: Page): Promise<CallState> {
  return page.evaluate(([leave, tiles, waiting]) => {
    const inCall =
      Boolean(document.querySelector(leave) && document.querySelector(tiles)) && !new RegExp(waiting, 'i').test(document.body.innerText)
    const list = document.querySelector('[role="list"][aria-label="Participants"]')
    const ids = new Set([...document.querySelectorAll(tiles)].map((t) => t.getAttribute('data-participant-id')))
    const participants = list ? list.querySelectorAll('[role="listitem"]').length : ids.size
    return { inCall, participants: inCall && participants > 0 ? participants : null }
  }, [LEAVE_BUTTON, IN_CALL, WAITING.source] as const)
}

export async function leaveMeet(page: Page): Promise<void> {
  await page.locator(LEAVE_BUTTON).click({ timeout: 3000 }).catch(() => {})
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian'
}

/**
 * Turns on Meet's live captions, which name the speakers (the detector keeps them off
 * screen): the captions button, else Meet's "c" shortcut, else the item of the More
 * options menu, where the button goes when the window is narrow. True, or what Meet
 * showed (to fix the labels when Meet changes them).
 */
export async function ensureCaptions(page: Page): Promise<true | string> {
  const on = (): Promise<boolean> =>
    page.evaluate(() => Boolean((globalThis as unknown as { __vcSpeakers?: { captionsOn(): boolean } }).__vcSpeakers?.captionsOn()))
  const settled = async (): Promise<boolean> => {
    for (let i = 0; i < 6; i++) {
      if (await on()) return true
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }
  if (await on()) return true
  const button = page.getByRole('button', { name: /^turn on captions/i }).first()
  if (await button.count()) {
    await button.click({ timeout: 3000 }).catch(() => {})
    if (await settled()) return true
  }
  // The shortcut toggles them, so it is pressed only while they are off.
  await page.keyboard.press('c').catch(() => {})
  if (await settled()) return true
  let menu: string[] = []
  try {
    await page.getByRole('button', { name: /^more options$/i }).first().click({ timeout: 3000 })
    menu = await page.getByRole('menuitem').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') ?? (e as HTMLElement).innerText).trim().slice(0, 40)))
    await page.getByRole('menuitem', { name: /turn on captions|^captions$/i }).first().click({ timeout: 3000 })
    if (await settled()) return true
  } catch {
    /* no such item: said below */
  } finally {
    await page.keyboard.press('Escape').catch(() => {})
  }
  const buttons = await page
    .locator('button[aria-label]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? '').filter((l) => /caption|subt/i.test(l)).slice(0, 5))
    .catch(() => [] as string[])
  return `captions buttons: ${buttons.join(' | ') || 'none'}; menu: ${menu.join(' | ') || 'not opened'}`
}

/**
 * Sets the language Meet's live captions listen for (they name the speakers, and
 * recognise little of a language they don't expect). True, or what went wrong.
 */
export async function setCaptionsLanguage(page: Page, code: string): Promise<true | string> {
  const name = LANGUAGE_NAMES[code.toLowerCase()]
  if (!name) return `unknown language "${code}" (known: ${Object.keys(LANGUAGE_NAMES).join(', ')})`
  // The captions bar has a "Meeting language" button that opens the list of languages.
  const picker = page.locator('[aria-label="Meeting language"]').first()
  try {
    await picker.click({ timeout: 5000, force: true })
    // e.g. "Spanish (Mexico)", "Spanish (Spain)": the first variant of the language.
    const option = page.getByRole('option', { name: new RegExp(`^${name}`, 'i') }).first()
    await option.click({ timeout: 5000 })
    return true
  } catch {
    const options = await page.getByRole('option').evaluateAll((els) => els.slice(0, 8).map((e) => (e as HTMLElement).innerText.trim()))
    await page.keyboard.press('Escape').catch(() => {})
    return `no language picker or "${name}" option (options: ${options.join(' | ') || 'none'})`
  }
}
