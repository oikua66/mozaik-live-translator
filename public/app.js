const sourceLanguage = document.querySelector('#sourceLanguage');
const targetLanguage = document.querySelector('#targetLanguage');
const micButton = document.querySelector('#micButton');
const clearButton = document.querySelector('#clearButton');
const copyButton = document.querySelector('#copyButton');
const originalText = document.querySelector('#originalText');
const translatedText = document.querySelector('#translatedText');
const interimText = document.querySelector('#interimText');
const listeningBadge = document.querySelector('#listeningBadge');
const notice = document.querySelector('#notice');

const inputStatus = document.querySelector('#inputStatus');
const translatorStatus = document.querySelector('#translatorStatus');
const editorStatus = document.querySelector('#editorStatus');
const inputDot = document.querySelector('#inputDot');
const translatorDot = document.querySelector('#translatorDot');
const editorDot = document.querySelector('#editorDot');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let listening = false;
let stateCache = null;

const recognitionLang = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  sr: 'sr-RS',
  en: 'en-US',
};

function setStatus(el, dot, value) {
  el.textContent = value;
  dot.className = `dot ${value === 'running' || value === 'listening' ? 'running' : value === 'queued' ? 'queued' : 'idle'}`;
}

function render(state) {
  stateCache = state;
  const fragments = state.fragments || [];

  const source = fragments.map((f) => f.sourceText).filter(Boolean).join(' ');
  const final = fragments.map((f) => f.finalText || '').filter(Boolean).join(' ');

  originalText.textContent = source || 'Your speech will appear here.';
  translatedText.textContent = final || 'The polished translation will appear here.';
  originalText.classList.toggle('empty', !source);
  translatedText.classList.toggle('empty', !final);

  setStatus(
    inputStatus,
    inputDot,
    state.sourceBusy ? 'running' : state.sourceQueueLength ? 'queued' : listening ? 'listening' : 'idle',
  );
  setStatus(translatorStatus, translatorDot, state.translationBusy ? 'running' : state.translationQueueLength ? 'queued' : 'idle');
  setStatus(editorStatus, editorDot, state.editBusy ? 'running' : state.editQueueLength ? 'queued' : 'idle');

  sourceLanguage.value = state.sourceLanguage || sourceLanguage.value;
  targetLanguage.value = state.targetLanguage || targetLanguage.value;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh() {
  try {
    render(await api('/api/state'));
  } catch (error) {
    notice.textContent = `Connection error: ${error.message}`;
  }
}

async function sendFragment(text) {
  const clean = text.trim();
  if (!clean) return;
  await api('/api/fragment', { method: 'POST', body: JSON.stringify({ text: clean }) });
  interimText.textContent = '';
  await refresh();
}

function stopRecognition() {
  listening = false;
  if (recognition) recognition.stop();
  micButton.textContent = '🎙 Start microphone';
  listeningBadge.textContent = 'Ready';
  interimText.textContent = '';
  render(stateCache || { fragments: [] });
}

function startRecognition() {
  if (!SpeechRecognition) {
    notice.textContent = 'This browser does not support Speech Recognition. Use Chrome for the microphone demo.';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = recognitionLang[sourceLanguage.value];
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = async (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        await sendFragment(text);
      } else {
        interim += text;
      }
    }
    interimText.textContent = interim;
  };

  recognition.onerror = (event) => {
    notice.textContent = `Microphone error: ${event.error}`;
    stopRecognition();
  };

  recognition.onend = () => {
    if (listening) {
      try { recognition.start(); } catch {}
    }
  };

  listening = true;
  micButton.textContent = '■ Stop microphone';
  listeningBadge.textContent = 'Listening';
  notice.textContent = 'Speak naturally. The Source Agent restores punctuation before translation.';
  render(stateCache || { fragments: [] });
  recognition.start();
}

micButton.addEventListener('click', () => {
  if (listening) stopRecognition();
  else startRecognition();
});

async function updateLanguages() {
  if (listening) stopRecognition();
  try {
    const state = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value }),
    });
    render(state);
    notice.textContent = 'Languages updated.';
  } catch (error) {
    notice.textContent = error.message;
    await refresh();
  }
}

sourceLanguage.addEventListener('change', updateLanguages);
targetLanguage.addEventListener('change', updateLanguages);

clearButton.addEventListener('click', async () => {
  if (listening) stopRecognition();
  try {
    const state = await api('/api/clear', {
      method: 'POST',
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value }),
    });
    render(state);
    notice.textContent = 'Session cleared.';
  } catch (error) {
    notice.textContent = error.message;
  }
});

copyButton.addEventListener('click', async () => {
  const text = (stateCache?.fragments || []).map((f) => f.finalText || '').filter(Boolean).join(' ');
  if (!text) return;
  await navigator.clipboard.writeText(text);
  notice.textContent = 'Translation copied.';
});

await refresh();
setInterval(refresh, 350);
