const toggle = document.getElementById('toggle');
const includeMic = document.getElementById('includeMic');
const autoCaptions = document.getElementById('autoCaptions');
const selfName = document.getElementById('selfName');
const grant = document.getElementById('grant');
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');

let timer = null;

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage({ target: 'service-worker', type, ...payload });
  if (!res?.ok) throw new Error(res?.error || 'Error desconocido');
  return res.result;
}

function formatElapsed(startedAt) {
  const s = Math.floor((Date.now() - new Date(startedAt)) / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function render(state) {
  clearInterval(timer);
  errorEl.textContent = state.lastError || '';
  if (state.recording) {
    toggle.textContent = 'Detener y guardar';
    toggle.classList.add('recording');
    includeMic.disabled = true;
    autoCaptions.disabled = true;
    selfName.disabled = true;
    const tick = () => (statusEl.textContent = `Grabando "${state.tabTitle}" · ${formatElapsed(state.startedAt)}`);
    tick();
    timer = setInterval(tick, 1000);
  } else {
    toggle.textContent = 'Grabar esta pestaña';
    toggle.classList.remove('recording');
    includeMic.disabled = false;
    autoCaptions.disabled = false;
    selfName.disabled = false;
    statusEl.textContent = 'Los archivos se guardan en Descargas/meeting-recorder/';
  }
}

// The offscreen document can't show a permission prompt, so the mic permission
// has to be granted once from a visible extension page.
async function refreshMicPermission() {
  const { state } = await navigator.permissions.query({ name: 'microphone' });
  grant.hidden = state === 'granted' || !includeMic.checked;
  return state;
}

grant.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
});

autoCaptions.addEventListener('change', () => chrome.storage.local.set({ autoCaptions: autoCaptions.checked }));
selfName.addEventListener('change', () => chrome.storage.local.set({ selfName: selfName.value.trim() }));

includeMic.addEventListener('change', async () => {
  await chrome.storage.local.set({ includeMic: includeMic.checked });
  refreshMicPermission();
});

toggle.addEventListener('click', async () => {
  errorEl.textContent = '';
  toggle.disabled = true;
  try {
    const state = await send('status');
    if (state.recording) {
      render(await send('stop'));
      statusEl.textContent = 'Guardando…';
    } else {
      if (includeMic.checked && (await refreshMicPermission()) !== 'granted') {
        throw new Error('Primero concede acceso al micrófono, o desmarca la casilla.');
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      render(
        await send('start', {
          tabId: tab.id,
          includeMic: includeMic.checked,
          autoCaptions: autoCaptions.checked,
          selfName: selfName.value.trim(),
        }),
      );
    }
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    toggle.disabled = false;
  }
});

(async () => {
  const prefs = await chrome.storage.local.get(['includeMic', 'autoCaptions', 'selfName']);
  if (prefs.includeMic !== undefined) includeMic.checked = prefs.includeMic;
  if (prefs.autoCaptions !== undefined) autoCaptions.checked = prefs.autoCaptions;
  if (prefs.selfName !== undefined) selfName.value = prefs.selfName;
  await refreshMicPermission();
  render(await send('status'));
})();
