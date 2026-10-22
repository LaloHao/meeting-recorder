// Coordinates recording state between the popup and the offscreen document.
// MediaRecorder can't run in a service worker, so capture lives in offscreen.html.

const OFFSCREEN_URL = 'offscreen.html';

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state ?? { recording: false };
}

async function setState(state) {
  await chrome.storage.session.set({ state });
  await chrome.action.setBadgeText({ text: state.recording ? 'REC' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Grabar video y audio de la pestaña con MediaRecorder',
  });
}

function sanitize(name) {
  return (name || 'reunion')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function timestampForFile(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function isMeetUrl(url) {
  try {
    return new URL(url).hostname === 'meet.google.com';
  } catch {
    return false;
  }
}

// Speaker turns arrive one message at a time; appends are serialized so none are lost.
let speakerQueue = Promise.resolve();

function appendSpeakerTurn(turn) {
  speakerQueue = speakerQueue.then(async () => {
    const { speakers = [] } = await chrome.storage.session.get('speakers');
    speakers.push(turn);
    await chrome.storage.session.set({ speakers });
  });
  return speakerQueue;
}

// Injects the speaker detector into a Meet tab. Failures are non-fatal: the
// recording still works, it just has no speaker names.
async function startSpeakerDetection(tabId, startedAt, { selfName, autoCaptions }) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['shared/meet-speakers.js', 'content/speakers-adapter.js'],
    });
    await chrome.tabs.sendMessage(tabId, {
      target: 'meet-speakers',
      type: 'start',
      startedAtMs: Date.parse(startedAt),
      selfName,
      autoCaptions,
      // Captions name the speakers, but off screen they don't cover what is shared.
      hideCaptions: true,
    });
    return true;
  } catch (err) {
    console.warn('[meeting-recorder] speaker detection unavailable:', err);
    return false;
  }
}

async function startRecording({ tabId, includeMic, selfName = '', autoCaptions = true }) {
  const state = await getState();
  if (state.recording) throw new Error('Ya hay una grabación en curso');

  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();

  const startedAt = new Date();
  const baseName = `${timestampForFile(startedAt)}_${sanitize(tab.title)}`;
  const meta = {
    schema: 'video-context-recording/1',
    source: 'chrome-extension',
    platform: isMeetUrl(tab.url) ? 'meet' : undefined,
    title: tab.title,
    url: tab.url,
    includeMic,
  };

  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    includeMic,
    meta,
  });
  if (!response?.ok) throw new Error(response?.error || 'No se pudo iniciar la grabación');

  await chrome.storage.session.set({ speakers: [] });
  const speakerDetection = isMeetUrl(tab.url)
    ? await startSpeakerDetection(tabId, response.startedAt, { selfName, autoCaptions })
    : false;

  await setState({
    recording: true,
    tabId,
    tabTitle: tab.title,
    startedAt: response.startedAt,
    baseName,
    speakerDetection,
  });
}

async function stopRecording() {
  const state = await getState();
  if (!state.recording) return;
  if (state.speakerDetection) {
    // Flushes the turns still open; the tab may already be gone.
    await chrome.tabs.sendMessage(state.tabId, { target: 'meet-speakers', type: 'stop' }).catch(() => {});
  }
  // The offscreen document answers with 'recording-ready' once the file is assembled.
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
}

async function handleRecordingReady({ videoUrl, metadata, extension }) {
  const state = await getState();
  const baseName = state.baseName || timestampForFile(new Date());
  await setState({ recording: false });

  await speakerQueue;
  const { speakers = [] } = await chrome.storage.session.get('speakers');
  const fullMetadata = {
    ...metadata,
    speakers: speakers.sort((a, b) => a.start - b.start),
  };
  const metaUrl =
    'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(fullMetadata, null, 2));

  await chrome.downloads.download({ url: videoUrl, filename: `meeting-recorder/${baseName}.${extension}` });
  await chrome.downloads.download({ url: metaUrl, filename: `meeting-recorder/${baseName}.json` });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'service-worker') return;

  const run = async () => {
    switch (message.type) {
      case 'status':
        return getState();
      case 'start':
        await startRecording(message);
        return getState();
      case 'stop':
        await stopRecording();
        return getState();
      case 'speaker-turn':
        await appendSpeakerTurn(message.turn);
        return { ok: true };
      case 'recording-ready':
        await handleRecordingReady(message);
        return { ok: true };
      case 'recording-error':
        console.error('[meeting-recorder] recording error:', message.error);
        await setState({ recording: false, lastError: message.error });
        return { ok: true };
      default:
        throw new Error(`Mensaje desconocido: ${message.type}`);
    }
  };

  run()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // keep the channel open for the async response
});

// Recording state is lost if the browser restarts mid-recording; reset the badge.
chrome.runtime.onStartup.addListener(() => setState({ recording: false }));
