const sourceLanguage = document.querySelector('#sourceLanguage');
const targetLanguage = document.querySelector('#targetLanguage');
const outputStyle = document.querySelector('#outputStyle');
const voiceOutput = document.querySelector('#voiceOutput');
const micButton = document.querySelector('#micButton');
const clearButton = document.querySelector('#clearButton');
const copyButton = document.querySelector('#copyButton');
const originalText = document.querySelector('#originalText');
const translatedText = document.querySelector('#translatedText');
const interimText = document.querySelector('#interimText');
const listeningBadge = document.querySelector('#listeningBadge');
const notice = document.querySelector('#notice');
const latencyLine = document.querySelector('#latencyLine');

const inputStatus = document.querySelector('#inputStatus');
const translatorStatus = document.querySelector('#translatorStatus');
const editorStatus = document.querySelector('#editorStatus');
const inputDot = document.querySelector('#inputDot');
const translatorDot = document.querySelector('#translatorDot');
const editorDot = document.querySelector('#editorDot');

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const speechSynthesisApi = window.speechSynthesis;
let recognition = null;
let recognitionActive = false;
let listening = false;
let userSpeaking = false;
let ttsPlaying = false;
let ttsWaitingForMicStop = false;
let stateCache = null;
let lastSpokenFragmentId = 0;
const uiRenderedAt = new Map();
const voiceStartedAt = new Map();

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

function formatLatency(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : '—';
}

function updateLatencyLine(fragments) {
  const translated = fragments.filter((f) => f.rawTranslation && f.clientFinalAt);
  const latest = translated[translated.length - 1];
  if (!latest) {
    latencyLine.textContent = 'Latency: waiting for speech…';
    return;
  }

  const translatorMs = latest.translatedAt ? latest.translatedAt - latest.clientFinalAt : null;
  const uiMs = uiRenderedAt.has(latest.id) ? uiRenderedAt.get(latest.id) - latest.clientFinalAt : null;
  const voiceMs = voiceStartedAt.has(latest.id) ? voiceStartedAt.get(latest.id) - latest.clientFinalAt : null;
  latencyLine.textContent = `Latency #${latest.id} — Translator: ${formatLatency(translatorMs)} | UI: ${formatLatency(uiMs)} | Voice: ${formatLatency(voiceMs)}`;
}

function cancelTts() {
  ttsWaitingForMicStop = false;
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

function visibleTranslation(fragment) {
  return fragment.finalText || fragment.rawTranslation || '';
}

function pendingSpeakableBatch() {
  const fragments = (stateCache?.fragments || [])
    .filter((fragment) => fragment.id > lastSpokenFragmentId && visibleTranslation(fragment))
    .sort((a, b) => a.id - b.id);

  if (!fragments.length) return null;

  return {
    text: fragments.map((fragment) => visibleTranslation(fragment)).join(' '),
    lastId: fragments[fragments.length - 1].id,
    fragmentIds: fragments.map((fragment) => fragment.id),
  };
}

function restartRecognition() {
  if (!listening || !recognition || ttsPlaying || ttsWaitingForMicStop || recognitionActive) return;
  setTimeout(() => {
    if (!listening || ttsPlaying || ttsWaitingForMicStop || recognitionActive) return;
    try { recognition.start(); } catch {}
  }, 100);
}

function startTtsNow() {
  if (!speechSynthesisApi || voiceOutput.value !== 'auto' || ttsPlaying || userSpeaking) return;
  const batch = pendingSpeakableBatch();
  if (!batch) return;

  ttsPlaying = true;
  ttsWaitingForMicStop = false;

  const utterance = new SpeechSynthesisUtterance(batch.text);
  utterance.lang = speechLang[targetLanguage.value] || 'en-US';
  const voice = pickVoice(utterance.lang);
  if (voice) utterance.voice = voice;
  utterance.rate = 1;
  utterance.pitch = 1;

  utterance.onstart = () => {
    const startedAt = Date.now();
    console.log(`[TIMING] TTS START ${startedAt}`);
    for (const id of batch.fragmentIds) {
      if (!voiceStartedAt.has(id)) voiceStartedAt.set(id, startedAt);
    }
    lastSpokenFragmentId = batch.lastId;
    listeningBadge.textContent = 'Speaking';
    notice.textContent = 'Speaking translation. Editor continues polishing in the background.';
    updateLatencyLine(stateCache?.fragments || []);
  };

  utterance.onend = () => {
    ttsPlaying = false;
    listeningBadge.textContent = listening ? 'Listening' : 'Ready';
    notice.textContent = listening ? 'Listening.' : 'Voice output finished.';
    restartRecognition();
    requestTts();
  };

  utterance.onerror = () => {
    ttsPlaying = false;
    restartRecognition();
  };

  speechSynthesisApi.cancel();
  setTimeout(() => {
    if (!ttsPlaying) return;
    speechSynthesisApi.speak(utterance);
  }, 60);
}

function requestTts() {
  if (!speechSynthesisApi || voiceOutput.value !== 'auto' || ttsPlaying || ttsWaitingForMicStop || userSpeaking) return;
  if (!pendingSpeakableBatch()) return;

  if (recognitionActive && recognition) {
    ttsWaitingForMicStop = true;
    listeningBadge.textContent = 'Preparing voice';
    try {
      recognition.abort();
      return;
    } catch {
      recognitionActive = false;
      ttsWaitingForMicStop = false;
    }
  }

  startTtsNow();
}

function render(state) {
  stateCache = state;
  const fragments = state.fragments || [];

  const source = fragments.map((f) => f.sourceText).filter(Boolean).join(' ');
  const translated = fragments.map((f) => visibleTranslation(f)).filter(Boolean).join(' ');

  for (const fragment of fragments) {
    if (fragment.rawTranslation && !uiRenderedAt.has(fragment.id)) {
      uiRenderedAt.set(fragment.id, Date.now());
      console.log(`[TIMING] UI RENDER #${fragment.id} ${uiRenderedAt.get(fragment.id)}`);
    }
  }

  originalText.textContent = source || 'Your speech will appear here.';
  translatedText.textContent = translated || 'The translation will appear here.';
  originalText.classList.toggle('empty', !source);
  translatedText.classList.toggle('empty', !translated);

  setStatus(
    inputStatus,
    inputDot,
    state.sourceBusy ? 'running' : state.sourceQueueLength ? 'queued' : listening ? 'listening' : 'idle',
  );
  setStatus(translatorStatus, translatorDot, state.translationBusy ? 'running' : state.translationQueueLength ? 'queued' : 'idle');
  setStatus(editorStatus, editorDot, state.editBusy ? 'running' : state.editQueueLength ? 'queued' : 'idle');

  sourceLanguage.value = state.sourceLanguage || sourceLanguage.value;
  targetLanguage.value = state.targetLanguage || targetLanguage.value;
  outputStyle.value = state.outputStyle || outputStyle.value;

  updateLatencyLine(fragments);
  requestTts();
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

async function sendFragment(text, clientFinalAt) {
  const clean = text.trim();
  if (!clean) return;
  await api('/api/fragment', {
    method: 'POST',
    body: JSON.stringify({ text: clean, clientFinalAt }),
  });
  interimText.textContent = '';
  await refresh();
}

function stopRecognition() {
  listening = false;
  userSpeaking = false;
  ttsWaitingForMicStop = false;
  if (recognition) {
    try { recognition.abort(); } catch {}
  }
  recognitionActive = false;
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

  recognition.onstart = () => {
    recognitionActive = true;
  };

  recognition.onspeechstart = () => {
    userSpeaking = true;
    listeningBadge.textContent = 'Listening';
  };

  recognition.onspeechend = () => {
    userSpeaking = false;
  };

  recognition.onresult = async (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        userSpeaking = false;
        const clientFinalAt = Date.now();
        console.log(`[TIMING] SPEECH FINAL ${clientFinalAt}`);
        await sendFragment(text, clientFinalAt);
      } else {
        userSpeaking = true;
        interim += text;
      }
    }
    interimText.textContent = interim;
  };

  recognition.onerror = (event) => {
    if (ttsWaitingForMicStop && event.error === 'aborted') return;
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    notice.textContent = `Microphone error: ${event.error}`;
    stopRecognition();
  };

  recognition.onend = () => {
    recognitionActive = false;
    userSpeaking = false;

    if (ttsWaitingForMicStop) {
      ttsWaitingForMicStop = false;
      setTimeout(startTtsNow, 50);
      return;
    }

    restartRecognition();
  };

  listening = true;
  micButton.textContent = '■ Stop microphone';
  listeningBadge.textContent = 'Listening';
  notice.textContent = `Speak naturally. Output style: ${outputStyle.options[outputStyle.selectedIndex].text}.`;
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
    restartRecognition();
  } else {
    notice.textContent = 'Voice output starts as soon as the Translator Agent finishes.';
    requestTts();
  }
});

async function updateConfig() {
  if (listening) stopRecognition();
  cancelTts();
  try {
    const state = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        outputStyle: outputStyle.value,
      }),
    });
    lastSpokenFragmentId = Math.max(0, ...(state.fragments || []).map((f) => f.id || 0));
    render(state);
    notice.textContent = `Settings updated. Output style: ${outputStyle.options[outputStyle.selectedIndex].text}.`;
  } catch (error) {
    notice.textContent = error.message;
    await refresh();
  }
}

sourceLanguage.addEventListener('change', updateConfig);
targetLanguage.addEventListener('change', updateConfig);
outputStyle.addEventListener('change', updateConfig);

clearButton.addEventListener('click', async () => {
  if (listening) stopRecognition();
  cancelTts();
  try {
    const state = await api('/api/clear', {
      method: 'POST',
      body: JSON.stringify({
        sourceLanguage: sourceLanguage.value,
        targetLanguage: targetLanguage.value,
        outputStyle: outputStyle.value,
      }),
    });
    lastSpokenFragmentId = 0;
    uiRenderedAt.clear();
    voiceStartedAt.clear();
    render(state);
    notice.textContent = 'Session cleared.';
  } catch (error) {
    notice.textContent = error.message;
  }
});

copyButton.addEventListener('click', async () => {
  const text = (stateCache?.fragments || []).map((f) => visibleTranslation(f)).filter(Boolean).join(' ');
  if (!text) return;
  await navigator.clipboard.writeText(text);
  notice.textContent = 'Translation copied.';
});

await refresh();
setInterval(refresh, 250);
