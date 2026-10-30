const sourceLanguage = document.querySelector('#sourceLanguage');
const targetLanguage = document.querySelector('#targetLanguage');
const voiceOutput = document.querySelector('#voiceOutput');
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
const speechSynthesisApi = window.speechSynthesis;
let recognition = null;
let listening = false;
let userSpeaking = false;
let ttsPlaying = false;
let stateCache = null;
let lastSpeechAt = 0;
let lastSpokenFragmentId = 0;
let ttsTimer = null;

const recognitionLang = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  sr: 'sr-RS',
  en: 'en-US',
};

const speechLang = {
  ru: 'ru-RU',
  uk: 'uk-UA',
  sr: 'sr-RS',
  en: 'en-US',
};

function setStatus(el, dot, value) {
  el.textContent = value;
  dot.className = `dot ${value === 'running' || value === 'listening' ? 'running' : value === 'queued' ? 'queued' : 'idle'}`;
}

function cancelTts() {
  if (ttsTimer) {
    clearTimeout(ttsTimer);
    ttsTimer = null;
  }
  if (speechSynthesisApi?.speaking || speechSynthesisApi?.pending) {
    speechSynthesisApi.cancel();
  }
  ttsPlaying = false;
}

function pickVoice(lang) {
  const voices = speechSynthesisApi?.getVoices?.() || [];
  const exact = voices.find((voice) => voice.lang?.toLowerCase() === lang.toLowerCase());
  if (exact) return exact;
  const prefix = lang.split('-')[0].toLowerCase();
  return voices.find((voice) => voice.lang?.toLowerCase().startsWith(prefix)) || null;
}

function pendingSpeakableBatch() {
  const fragments = (stateCache?.fragments || [])
    .filter((fragment) => fragment.id > lastSpokenFragmentId && fragment.finalText)
    .sort((a, b) => a.id - b.id);

  if (!fragments.length) return null;

  return {
    text: fragments.map((fragment) => fragment.finalText).join(' '),
    lastId: fragments[fragments.length - 1].id,
  };
}

function restartRecognitionAfterTts() {
  if (!listening || !recognition) return;
  setTimeout(() => {
    if (!listening || ttsPlaying) return;
    try { recognition.start(); } catch {}
  }, 120);
}

function speakPendingIfReady() {
  if (!speechSynthesisApi || voiceOutput.value !== 'auto') return;
  if (userSpeaking || ttsPlaying) return;

  const silenceFor = Date.now() - lastSpeechAt;
  if (silenceFor < 850) {
    scheduleTts(850 - silenceFor + 50);
    return;
  }

  const batch = pendingSpeakableBatch();
  if (!batch) return;

  ttsPlaying = true;
  userSpeaking = false;

  // Half-duplex: stop recognition while the browser is speaking so it does not hear itself.
  if (recognition && listening) {
    try { recognition.stop(); } catch {}
  }

  speechSynthesisApi.cancel();

  const utterance = new SpeechSynthesisUtterance(batch.text);
  utterance.lang = speechLang[targetLanguage.value] || 'en-US';
  const voice = pickVoice(utterance.lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  utterance.pitch = 1;

  utterance.onstart = () => {
    lastSpokenFragmentId = batch.lastId;
    listeningBadge.textContent = 'Speaking';
    notice.textContent = 'Speaking translation. Microphone is paused until playback finishes.';
  };

  utterance.onend = () => {
    ttsPlaying = false;
    listeningBadge.textContent = listening ? 'Listening' : 'Ready';
    notice.textContent = listening
      ? 'Listening. Voice output waits for the next completed translation.'
      : 'Voice output finished.';
    restartRecognitionAfterTts();
    scheduleTts(150);
  };

  utterance.onerror = () => {
    ttsPlaying = false;
    restartRecognitionAfterTts();
  };

  speechSynthesisApi.speak(utterance);
}

function scheduleTts(delay = 900) {
  if (voiceOutput.value !== 'auto' || ttsPlaying) return;
  if (ttsTimer) clearTimeout(ttsTimer);
  ttsTimer = setTimeout(() => {
    ttsTimer = null;
    speakPendingIfReady();
  }, delay);
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

  if (pendingSpeakableBatch()) scheduleTts();
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
  lastSpeechAt = Date.now();
  await api('/api/fragment', { method: 'POST', body: JSON.stringify({ text: clean }) });
  interimText.textContent = '';
  await refresh();
}

function stopRecognition() {
  listening = false;
  userSpeaking = false;
  if (recognition) {
    try { recognition.stop(); } catch {}
  }
  cancelTts();
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

  recognition.onspeechstart = () => {
    if (ttsPlaying) {
      speechSynthesisApi?.cancel();
      ttsPlaying = false;
    }
    userSpeaking = true;
    lastSpeechAt = Date.now();
    listeningBadge.textContent = 'Listening';
  };

  recognition.onspeechend = () => {
    userSpeaking = false;
    lastSpeechAt = Date.now();
    scheduleTts();
  };

  recognition.onresult = async (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        userSpeaking = false;
        lastSpeechAt = Date.now();
        await sendFragment(text);
      } else {
        userSpeaking = true;
        lastSpeechAt = Date.now();
        interim += text;
      }
    }
    interimText.textContent = interim;
  };

  recognition.onerror = (event) => {
    if (ttsPlaying && (event.error === 'aborted' || event.error === 'no-speech')) return;
    notice.textContent = `Microphone error: ${event.error}`;
    if (event.error !== 'aborted' && event.error !== 'no-speech') stopRecognition();
  };

  recognition.onend = () => {
    userSpeaking = false;
    if (listening && !ttsPlaying) {
      try { recognition.start(); } catch {}
    }
  };

  listening = true;
  micButton.textContent = '■ Stop microphone';
  listeningBadge.textContent = 'Listening';
  notice.textContent = 'Speak naturally. Voice output pauses the microphone while speaking.';
  render(stateCache || { fragments: [] });
  recognition.start();
}

micButton.addEventListener('click', () => {
  if (listening) stopRecognition();
  else startRecognition();
});

voiceOutput.addEventListener('change', () => {
  if (voiceOutput.value === 'off') {
    cancelTts();
    notice.textContent = 'Voice output is off.';
  } else {
    notice.textContent = 'Voice output is automatic after a short pause.';
    scheduleTts(150);
  }
});

async function updateLanguages() {
  if (listening) stopRecognition();
  cancelTts();
  try {
    const state = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value }),
    });
    lastSpokenFragmentId = Math.max(0, ...(state.fragments || []).map((f) => f.id || 0));
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
  cancelTts();
  try {
    const state = await api('/api/clear', {
      method: 'POST',
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value }),
    });
    lastSpokenFragmentId = 0;
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
