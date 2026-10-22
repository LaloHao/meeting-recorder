// Content-script side of the speaker detector (shared/meet-speakers.js, injected
// just before this file): starts and stops it on the service worker's request and
// forwards each turn to it.

(() => {
  if (globalThis.__vcSpeakersAdapter) return;
  globalThis.__vcSpeakersAdapter = true;

  const emit = (turn) => chrome.runtime.sendMessage({ target: 'service-worker', type: 'speaker-turn', turn });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.target !== 'meet-speakers') return;
    if (message.type === 'start') globalThis.__vcSpeakers.start(message, emit);
    if (message.type === 'stop') globalThis.__vcSpeakers.stop();
    sendResponse({ ok: true });
  });
})();
