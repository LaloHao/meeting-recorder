// Detects who is speaking in a Google Meet call and reports speaker turns.
// Shared by the browser extension (content script) and the recording agent
// (evaluated in the page): it defines `globalThis.__vcSpeakers` and reports each
// finished turn through the `emit` callback it is started with.
//
// Two sources, recorded side by side (consumers prefer captions when present):
//  - captions:  Meet's live captions region. Each caption block carries the
//               speaker's name; a block appears when someone starts talking and its
//               text grows while they talk. Uses ARIA roles/labels, which are stable.
//  - indicator: the per-tile audio-level animation. Only covers visible tiles and
//               relies on Meet's internal `jsname` attributes, so it is a fallback.
//
// Times are seconds relative to `startedAtMs`, the start of the recording.

(() => {
  if (globalThis.__vcSpeakers) return; // already loaded in this page

  const CAPTION_LABELS = ['Captions', 'Subtítulos', 'Legendas', 'Sous-titres', 'Untertitel', 'Sottotitoli'];
  const CAPTIONS_BUTTON_LABEL = /^(turn on captions|activar subtítulos)/i;
  const SELF_ALIASES = new Set(['you', 'tú', 'tu', 'você', 'vous', 'du']);
  // Elements whose class flickers with the participant's audio level (fragile).
  const INDICATOR_JSNAMES = ['Jaieyd', 'QgSmzd'];
  // Gaps shorter than this keep a turn open (audio level flickers per syllable).
  const INDICATOR_HANGOVER_S = 1.5;
  const CAPTION_IDLE_S = 2.5;
  const HIDE_STYLE_ID = '__vc-hide-captions';

  const captionSelector = CAPTION_LABELS.map((l) => `[role="region"][aria-label="${l}"]`).join(',');

  let session = null;

  const now = () => (Date.now() - session.startedAtMs) / 1000;
  const round = (t) => Math.round(t * 100) / 100;

  function normalizeName(name) {
    const clean = (name || '').replace(/\s+/g, ' ').trim();
    if (session.selfName && SELF_ALIASES.has(clean.toLowerCase())) return session.selfName;
    return clean;
  }

  function emitTurn(turn) {
    if (turn.end - turn.start < 0.2 || !turn.name) return;
    session.emit({ name: turn.name, start: round(turn.start), end: round(turn.end), source: turn.source });
  }

  // ---------------------------------------------------------------- captions

  const findCaptionRegion = () => document.querySelector(captionSelector);

  // A caption block is an element with an avatar <img> followed by the speaker name,
  // plus a sibling holding the spoken text.
  function captionBlocks(region) {
    const blocks = [];
    for (const img of region.querySelectorAll('img')) {
      const header = img.parentElement;
      const block = header?.parentElement;
      if (!block || block === region) continue;
      const name = header.innerText.trim();
      const text = [...block.children].filter((c) => c !== header).map((c) => c.innerText).join(' ').trim();
      if (name) blocks.push({ block, name, text });
    }
    return blocks;
  }

  function scanCaptions() {
    const region = findCaptionRegion();
    if (!region) return;
    const t = now();
    for (const { block, name, text } of captionBlocks(region)) {
      let open = session.captionTurns.get(block);
      if (!open) {
        open = { name: normalizeName(name), start: t, end: t, text, source: 'captions' };
        session.captionTurns.set(block, open);
      } else if (open.text !== text) {
        open.text = text;
        open.end = t;
      }
    }
  }

  function closeIdleCaptionTurns(force) {
    const t = now();
    for (const [block, turn] of session.captionTurns) {
      if (force || !block.isConnected || t - turn.end > CAPTION_IDLE_S) {
        emitTurn(turn);
        session.captionTurns.delete(block);
      }
    }
  }

  function enableCaptions() {
    if (findCaptionRegion()) return;
    const button = [...document.querySelectorAll('button[aria-label]')].find((b) =>
      CAPTIONS_BUTTON_LABEL.test(b.getAttribute('aria-label')),
    );
    button?.click();
  }

  // Captions stay on (they name the speakers) but off screen, so they don't cover
  // what is being shared in the recording.
  function hideCaptions() {
    if (document.getElementById(HIDE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HIDE_STYLE_ID;
    style.textContent = `${captionSelector} { position: fixed !important; left: -10000px !important; top: 0 !important; }`;
    document.head.appendChild(style);
  }

  // --------------------------------------------------------------- indicator

  // Best-effort participant name from a tile: the last short line that isn't a
  // Material icon ligature (e.g. "mic_off") or the label of a control in the tile
  // (e.g. "More actions").
  function tileName(tile) {
    const controls = new Set(
      [...tile.querySelectorAll('[aria-label], [data-tooltip], button')].flatMap((el) => [
        el.getAttribute('aria-label')?.trim(),
        el.getAttribute('data-tooltip')?.trim(),
        el.tagName === 'BUTTON' ? el.innerText.trim() : undefined,
      ]),
    );
    const lines = tile.innerText
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.length <= 40 && !/^[a-z0-9_]+$/.test(l) && !controls.has(l));
    return lines.at(-1) || '';
  }

  // The agent's own tile ("Name (You)") never speaks.
  const isSelfTile = (tile) => /\((you|tú)\)/i.test(tile.innerText);

  function onTileActivity(tile) {
    if (isSelfTile(tile)) return;
    // A participant can have several tiles (stage and filmstrip): one turn per participant.
    const id = tile.getAttribute('data-participant-id');
    const t = now();
    const state = session.indicatorTurns.get(id);
    if (state && t - state.end <= INDICATOR_HANGOVER_S) {
      state.end = t;
      return;
    }
    if (state) emitTurn(state);
    if (!session.tileNames.has(id)) {
      const name = normalizeName(tileName(tile));
      if (!name) return; // try again on the next activity, from another of its tiles
      session.tileNames.set(id, name);
    }
    session.indicatorTurns.set(id, { name: session.tileNames.get(id), start: t, end: t, source: 'indicator' });
  }

  function closeIdleIndicatorTurns(force) {
    const t = now();
    for (const [id, turn] of session.indicatorTurns) {
      if (force || t - turn.end > INDICATOR_HANGOVER_S) {
        emitTurn(turn);
        session.indicatorTurns.delete(id);
      }
    }
  }

  // --------------------------------------------------------------- lifecycle

  /**
   * @param {{ startedAtMs: number, selfName?: string, autoCaptions?: boolean, hideCaptions?: boolean }} opts
   * @param {(turn: { name: string, start: number, end: number, source: string }) => void} emit
   */
  function start(opts, emit) {
    stop();
    session = {
      emit,
      startedAtMs: opts.startedAtMs,
      selfName: (opts.selfName || '').trim(),
      captionTurns: new Map(),
      indicatorTurns: new Map(),
      tileNames: new Map(),
    };

    session.observer = new MutationObserver((mutations) => {
      let captionsChanged = false;
      for (const m of mutations) {
        const el = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        if (!el) continue;
        if (m.type === 'attributes') {
          if (m.attributeName === 'class' && INDICATOR_JSNAMES.some((j) => el.closest(`[jsname="${j}"]`))) {
            const tile = el.closest('[data-participant-id]');
            if (tile) onTileActivity(tile);
          }
        } else if (el.closest(captionSelector)) {
          captionsChanged = true;
        }
      }
      if (captionsChanged) scanCaptions();
    });
    session.observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    });

    session.timer = setInterval(() => {
      closeIdleCaptionTurns(false);
      closeIdleIndicatorTurns(false);
    }, 1000);

    if (opts.hideCaptions) hideCaptions();
    if (opts.autoCaptions) {
      enableCaptions();
      // The captions button may not exist yet if the call UI is still loading.
      session.captionsRetry = setTimeout(enableCaptions, 3000);
    }
  }

  function stop() {
    if (!session) return;
    session.observer.disconnect();
    clearInterval(session.timer);
    clearTimeout(session.captionsRetry);
    scanCaptions();
    closeIdleCaptionTurns(true);
    closeIdleIndicatorTurns(true);
    session = null;
  }

  globalThis.__vcSpeakers = { start, stop, captionsOn: () => Boolean(findCaptionRegion()) };
})();
