const sourceLanguage = document.querySelector('#sourceLanguage');
const targetLanguage = document.querySelector('#targetLanguage');
const outputStyle = document.querySelector('#outputStyle');
const voiceOutput = document.querySelector('#voiceOutput');
const micButton = document.querySelector('#micButton');
const saveVoiceButton = document.querySelector('#saveVoiceButton');
const clearButton = document.querySelector('#clearButton');
const copyButton = document.querySelector('#copyButton');
const originalText = document.querySelector('#originalText');
const translatedText = document.querySelector('#translatedText');
const voiceScriptText = document.querySelector('#voiceScriptText');
const interimText = document.querySelector('#interimText');
const listeningBadge = document.querySelector('#listeningBadge');
const notice = document.querySelector('#notice');
const latencyLine = document.querySelector('#latencyLine');

const inputStatus = document.querySelector('#inputStatus');
const translatorStatus = document.querySelector('#translatorStatus');
const editorStatus = document.querySelector('#editorStatus');
const voiceWriterStatus = document.querySelector('#voiceWriterStatus');
const inputDot = document.querySelector('#inputDot');
const translatorDot = document.querySelector('#translatorDot');
const editorDot = document.querySelector('#editorDot');
const voiceWriterDot = document.querySelector('#voiceWriterDot');

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

const recognitionLang = { ru: 'ru-RU', uk: 'uk-UA', sr: 'sr-RS', en: 'en-US' };
const speechLang = { ru: 'ru-RU', uk: 'uk-UA', sr: 'sr-RS', en: 'en-US' };

function setStatus(el, dot, value) {
  el.textContent = value;
  dot.className = `dot ${value === 'running' || value === 'listening' ? 'running' : value === 'queued' ? 'queued' : 'idle'}`;
}

function formatLatency(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : '—';
}

function isSmartStyle() {
  return outputStyle.value !== 'faithful';
}

function visibleTranslation(fragment) {
  if (isSmartStyle()) return fragment.finalText || '';
  return fragment.finalText || fragment.rawTranslation || '';
}

function currentOutputText() {
  return (stateCache?.fragments || []).map((f) => visibleTranslation(f)).filter(Boolean).join(' ');
}

function currentVoiceScriptText() {
  return (stateCache?.fragments || []).map((f) => f.spokenText || '').filter(Boolean).join(' ');
}

function updateLatencyLine(fragments) {
  const candidates = fragments.filter((f) => f.rawTranslation && f.clientFinalAt);
  const latest = candidates[candidates.length - 1];
  if (!latest) {
    latencyLine.textContent = 'Latency: waiting for speech…';
    return;
  }

  const translatorMs = latest.translatedAt ? latest.translatedAt - latest.clientFinalAt : null;
  const editorMs = latest.completedAt ? latest.completedAt - latest.clientFinalAt : null;
  const writerMs = latest.voiceCompletedAt ? latest.voiceCompletedAt - latest.clientFinalAt : null;
  const uiMs = uiRenderedAt.has(latest.id) ? uiRenderedAt.get(latest.id) - latest.clientFinalAt : null;
  const voiceMs = voiceStartedAt.has(latest.id) ? voiceStartedAt.get(latest.id) - latest.clientFinalAt : null;
  const verified = isSmartStyle() ? ` | Editor: ${formatLatency(editorMs)}` : '';
  latencyLine.textContent = `Latency #${latest.id} — Translator: ${formatLatency(translatorMs)}${verified} | Voice Writer: ${formatLatency(writerMs)} | UI: ${formatLatency(uiMs)} | Voice: ${formatLatency(voiceMs)}`;
}

function cancelTts() {
  ttsWaitingForMicStop = false;
  if (speechSynthesisApi?.speaking || speechSynthesisApi?.pending) speechSynthesisApi.cancel();
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
    .filter((fragment) => fragment.id > lastSpokenFragmentId && fragment.spokenText)
    .sort((a, b) => a.id - b.id);
  if (!fragments.length) return null;
  return {
    text: fragments.map((fragment) => fragment.spokenText).join(' '),
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
    for (const id of batch.fragmentIds) if (!voiceStartedAt.has(id)) voiceStartedAt.set(id, startedAt);
    lastSpokenFragmentId = batch.lastId;
    listeningBadge.textContent = 'Speaking';
    notice.textContent = 'Speaking the Voice Writer script.';
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
    if (ttsPlaying) speechSynthesisApi.speak(utterance);
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
  const voiceScript = fragments.map((f) => f.spokenText || '').filter(Boolean).join(' ');

  for (const fragment of fragments) {
    if (visibleTranslation(fragment) && !uiRenderedAt.has(fragment.id)) uiRenderedAt.set(fragment.id, Date.now());
  }

  originalText.textContent = source || 'Your speech will appear here.';
  translatedText.textContent = translated || (isSmartStyle() ? 'Waiting for the editor-verified translation…' : 'The translation will appear here.');
  voiceScriptText.textContent = voiceScript || 'The spoken version will appear here after verification.';
  originalText.classList.toggle('empty', !source);
  translatedText.classList.toggle('empty', !translated);
  voiceScriptText.classList.toggle('empty', !voiceScript);
  saveVoiceButton.disabled = !voiceScript;

  setStatus(inputStatus, inputDot, state.sourceBusy ? 'running' : state.sourceQueueLength ? 'queued' : listening ? 'listening' : 'idle');
  setStatus(translatorStatus, translatorDot, state.translationBusy ? 'running' : state.translationQueueLength ? 'queued' : 'idle');
  setStatus(editorStatus, editorDot, state.editBusy ? 'running' : state.editQueueLength ? 'queued' : 'idle');
  setStatus(voiceWriterStatus, voiceWriterDot, state.voiceBusy ? 'running' : state.voiceQueueLength ? 'queued' : 'idle');

  sourceLanguage.value = state.sourceLanguage || sourceLanguage.value;
  targetLanguage.value = state.targetLanguage || targetLanguage.value;
  outputStyle.value = state.outputStyle || outputStyle.value;

  updateLatencyLine(fragments);
  requestTts();
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh() {
  try { render(await api('/api/state')); }
  catch (error) { notice.textContent = `Connection error: ${error.message}`; }
}

async function sendFragment(text, clientFinalAt) {
  const clean = text.trim();
  if (!clean) return;
  await api('/api/fragment', { method: 'POST', body: JSON.stringify({ text: clean, clientFinalAt }) });
  interimText.textContent = '';
  await refresh();
}

function stopRecognition() {
  listening = false;
  userSpeaking = false;
  ttsWaitingForMicStop = false;
  if (recognition) { try { recognition.abort(); } catch {} }
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
  recognition.onstart = () => { recognitionActive = true; };
  recognition.onspeechstart = () => { userSpeaking = true; listeningBadge.textContent = 'Listening'; };
  recognition.onspeechend = () => { userSpeaking = false; };
  recognition.onresult = async (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        userSpeaking = false;
        await sendFragment(text, Date.now());
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
  notice.textContent = 'Speak naturally. Four agents start coordinated work; Voice Writer prepares a separate spoken version.';
  render(stateCache || { fragments: [] });
  recognition.start();
}

micButton.addEventListener('click', () => listening ? stopRecognition() : startRecognition());

voiceOutput.addEventListener('change', () => {
  if (voiceOutput.value === 'off') {
    cancelTts();
    notice.textContent = 'Voice output is off.';
    restartRecognition();
  } else {
    notice.textContent = 'Voice output waits for the Voice Writer script.';
    requestTts();
  }
});

saveVoiceButton.addEventListener('click', async () => {
  const text = currentVoiceScriptText();
  if (!text) return;
  const previousLabel = saveVoiceButton.textContent;
  saveVoiceButton.disabled = true;
  saveVoiceButton.textContent = 'Generating…';
  notice.textContent = 'Generating MP3 from the Voice Writer script…';
  try {
    const response = await fetch('/api/save-voice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename=([^;]+)/i);
    const filename = match?.[1]?.replace(/["']/g, '') || 'translator-voice.mp3';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.textContent = 'Voice Writer output saved as MP3.';
  } catch (error) {
    notice.textContent = `Could not save voice: ${error.message}`;
  } finally {
    saveVoiceButton.textContent = previousLabel;
    saveVoiceButton.disabled = !currentVoiceScriptText();
  }
});

async function updateConfig() {
  if (listening) stopRecognition();
  cancelTts();
  try {
    const state = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value, outputStyle: outputStyle.value }),
    });
    lastSpokenFragmentId = Math.max(0, ...(state.fragments || []).map((f) => f.id || 0));
    uiRenderedAt.clear();
    voiceStartedAt.clear();
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
      body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value, outputStyle: outputStyle.value }),
    });
    lastSpokenFragmentId = 0;
    uiRenderedAt.clear();
    voiceStartedAt.clear();
    render(state);
    notice.textContent = 'Session cleared.';
  } catch (error) { notice.textContent = error.message; }
});

copyButton.addEventListener('click', async () => {
  const text = currentOutputText();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  notice.textContent = 'Translation copied.';
});

await refresh();
setInterval(refresh, 250);
