// Captures the tab (video + audio), mixes in the microphone, and records a single
// WebM file. Audio and video share one MediaRecorder, so they share one clock:
// any timestamp in the transcript maps directly to the same time in the video.

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

let session = null;
let previousUrls = [];

function pickMimeType() {
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function start({ streamId, includeMic, meta }) {
  if (session) throw new Error('Ya hay una grabación en curso');

  // Blob URLs from the previous recording are no longer needed once a new one starts.
  previousUrls.forEach((u) => URL.revokeObjectURL(u));
  previousUrls = [];

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 15, // meetings and slides don't need 30fps
      },
    },
  });

  let micStream = null;
  if (includeMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      tabStream.getTracks().forEach((t) => t.stop());
      throw new Error(
        `No hay acceso al micrófono (${err.name}). Concede el permiso desde el popup de la extensión.`,
      );
    }
  }

  const audioContext = new AudioContext();
  const mixDestination = audioContext.createMediaStreamDestination();

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  tabSource.connect(mixDestination);
  // Capturing a tab mutes it for the user; route it back to the speakers.
  tabSource.connect(audioContext.destination);

  if (micStream) {
    audioContext.createMediaStreamSource(micStream).connect(mixDestination);
  }

  const recordStream = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...mixDestination.stream.getAudioTracks(),
  ]);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(recordStream, {
    mimeType,
    videoBitsPerSecond: 1_500_000,
    audioBitsPerSecond: 128_000,
  });

  const chunks = [];
  const startedAt = new Date();

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => finish();
  recorder.onerror = (e) => fail(e.error?.message || 'Error de MediaRecorder');

  // If the tab is closed or navigates away, the capture ends: finish what we have.
  tabStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder.state !== 'inactive') recorder.stop();
  });

  session = { recorder, chunks, tabStream, micStream, audioContext, startedAt, mimeType, meta };
  recorder.start(1000); // emit a chunk every second so a crash loses little

  return { startedAt: startedAt.toISOString() };
}

function cleanup() {
  if (!session) return;
  session.tabStream.getTracks().forEach((t) => t.stop());
  session.micStream?.getTracks().forEach((t) => t.stop());
  session.audioContext.close();
  session = null;
}

function finish() {
  if (!session) return;
  const { chunks, startedAt, mimeType, meta } = session;
  const endedAt = new Date();
  cleanup();

  const videoBlob = new Blob(chunks, { type: mimeType || 'video/webm' });
  const metadata = {
    ...meta,
    // All media timestamps are relative to recordingStartedAt (t=0 of the file).
    recordingStartedAt: startedAt.toISOString(),
    recordingEndedAt: endedAt.toISOString(),
    durationSeconds: (endedAt - startedAt) / 1000,
    mimeType: videoBlob.type,
    sizeBytes: videoBlob.size,
  };
  const videoUrl = URL.createObjectURL(videoBlob);
  previousUrls = [videoUrl];

  // The service worker adds the speaker turns and saves the metadata file.
  chrome.runtime.sendMessage({
    target: 'service-worker',
    type: 'recording-ready',
    videoUrl,
    metadata,
    extension: 'webm',
  });
}

function fail(error) {
  cleanup();
  chrome.runtime.sendMessage({ target: 'service-worker', type: 'recording-error', error });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'start') {
    start(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'stop') {
    if (session && session.recorder.state !== 'inactive') session.recorder.stop();
    sendResponse({ ok: true });
  }
});
