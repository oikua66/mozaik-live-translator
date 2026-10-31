const architectureView = document.querySelector('#architectureView');
const voiceView = document.querySelector('#voiceView');
const enterLiveButton = document.querySelector('#enterLiveButton');
const backButton = document.querySelector('#backButton');

function switchView(name) {
  architectureView.classList.toggle('active', name === 'architecture');
  voiceView.classList.toggle('active', name === 'voice');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
enterLiveButton.addEventListener('click', () => switchView('voice'));
backButton.addEventListener('click', () => switchView('architecture'));

async function jsonApi(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

// ---------- Architecture view ----------
const activeAgents = document.querySelector('#activeAgents');
const personalCount = document.querySelector('#personalCount');
const specialistCount = document.querySelector('#specialistCount');
const employeeSelect = document.querySelector('#employeeSelect');
const actionButton = document.querySelector('#actionButton');
const joinButton = document.querySelector('#joinButton');
const leaveButton = document.querySelector('#leaveButton');
const scenarioButton = document.querySelector('#scenarioButton');
const scenarioStatus = document.querySelector('#scenarioStatus');
const employeesEl = document.querySelector('#employees');
const modulesEl = document.querySelector('#modules');
const eventLog = document.querySelector('#eventLog');
const sysadminStatus = document.querySelector('#sysadminStatus');
const lifecycleTrace = document.querySelector('#lifecycleTrace');
const phaseLabel = document.querySelector('#phaseLabel');
const moduleLifecycle = document.querySelector('#moduleLifecycle');
const parallelStatus = document.querySelector('#parallelStatus');
const liveHandoff = document.querySelector('#liveHandoff');

let employeeOptionsSignature = '';
let lifecycleCounts = [];
let scenarioWasRunning = false;

function renderEmployees(state) {
  const active = state.employees.filter((item) => item.active);
  employeesEl.innerHTML = active.length ? active.map((employee) => `
    <div class="agentcard personal-agent">
      <div class="agenttop"><strong>${escapeHtml(employee.name)}</strong><span class="pill active-pill">PERSONAL · ACTIVE</span></div>
      <div>${escapeHtml(employee.office)}</div>
      <small>${escapeHtml(employee.language)} · ${escapeHtml(employee.role)}</small>
      <code>${escapeHtml(employee.agentId || 'no agent')}</code>
    </div>`).join('') : '<div class="empty">No employee agents are active.</div>';

  const signature = active.map((e) => `${e.id}:${e.name}:${e.office}`).join('|');
  if (signature !== employeeOptionsSignature) {
    const selected = employeeSelect.value;
    employeeSelect.innerHTML = active.map((e) => `<option value="${escapeHtml(e.id)}">${escapeHtml(e.name)} — ${escapeHtml(e.office)}</option>`).join('');
    if (active.some((e) => e.id === selected)) employeeSelect.value = selected;
    employeeOptionsSignature = signature;
  }
  actionButton.disabled = !active.length || state.scenario?.running;
}

function renderRequest(request) {
  const order = ['Translator', 'Editor', 'Voice Writer'];
  return `<div class="requestcard">
    <div class="requesthead"><strong>${escapeHtml(request.requestedByName || request.requestedBy || 'employee')}</strong><span>${escapeHtml(request.sourceLanguage || '')} → ${escapeHtml(request.corporateLanguage || 'English')}</span></div>
    <div class="source-message">${escapeHtml(request.text || '')}</div>
    <div class="coordination-strip"><span>Parallel analysis</span><b>→</b><span>shared state</span><b>→</b><span>coordinated outputs</span></div>
    <div class="resultlist">${order.map((role) => `<div class="resultrow"><span>${role}</span><div>${request.results?.[role] ? escapeHtml(request.results[role].text) : '<em>working…</em>'}</div></div>`).join('')}</div>
  </div>`;
}

function renderModules(state) {
  if (!state.modules.length) {
    modulesEl.className = 'cards empty';
    modulesEl.textContent = 'No specialist module is active.';
    parallelStatus.textContent = 'No specialist work';
    return;
  }
  modulesEl.className = 'cards';
  modulesEl.innerHTML = state.modules.map((module) => `
    <div class="modulecard specialist-module">
      <div class="agenttop"><strong>${escapeHtml(module.type)}</strong><span class="pill module-pill">TEMPORARY · ON DEMAND</span></div>
      <div class="modulemeta"><small>${escapeHtml(module.id)} · requests served: ${module.requestCount || 0}</small><span class="pill ${module.mode === 'real-llm' ? 'real-pill' : 'fallback-pill'}">${module.mode === 'real-llm' ? 'REAL LLM' : 'FALLBACK'}</span></div>
      <div class="module-note">⚡ Parallel analysis → shared state → coordinated outputs</div>
      <div class="memberlist">${module.members.map((m) => `<div><span>${escapeHtml(m.role)}<code>${escapeHtml(m.agentId || '')}</code></span><strong class="memberstatus ${escapeHtml(m.status)}">${escapeHtml(m.status)}</strong></div>`).join('')}</div>
      <div class="requestlist">${[...(module.requests || [])].slice(-3).reverse().map(renderRequest).join('')}</div>
    </div>`).join('');
  const n = state.modules.flatMap((m) => m.members).filter((m) => ['running', 'waiting', 'coordinating'].includes(m.status)).length;
  parallelStatus.textContent = n > 1 ? `${n} specialist agents coordinating concurrently` : n === 1 ? '1 specialist agent active' : 'Specialist module active';
}

function renderNetwork(state) {
  activeAgents.textContent = state.activeAgents;
  personalCount.textContent = state.activePersonalAgents;
  specialistCount.textContent = state.activeSpecialistAgents;
  sysadminStatus.textContent = state.sysadmin.status;
  const current = state.scenario || { running: false, step: 'idle' };
  scenarioStatus.textContent = current.step || 'idle';
  phaseLabel.textContent = String(current.step || 'idle').replaceAll('-', ' ').toUpperCase();
  scenarioButton.disabled = Boolean(current.running);
  scenarioButton.textContent = current.running ? '● Demo running…' : '▶ Run elastic workforce demo';
  joinButton.disabled = Boolean(current.running);
  leaveButton.disabled = Boolean(current.running);
  liveHandoff.hidden = current.step !== 'complete';
  if (current.running && !scenarioWasRunning) lifecycleCounts = [];
  scenarioWasRunning = Boolean(current.running);
  if (!lifecycleCounts.length || lifecycleCounts.at(-1) !== state.activeAgents) lifecycleCounts.push(state.activeAgents);
  lifecycleTrace.textContent = lifecycleCounts.join(' → ');
  const relevant = state.eventLog.find((e) => ['module.spawn', 'module.reuse', 'module.release'].includes(e.type));
  moduleLifecycle.textContent = relevant?.type === 'module.spawn' ? 'SPAWNED' : relevant?.type === 'module.reuse' ? 'REUSED' : relevant?.type === 'module.release' ? 'RELEASED' : 'READY';
  renderEmployees(state);
  renderModules(state);
  eventLog.innerHTML = state.eventLog.length ? state.eventLog.map((entry) => `<div class="event"><time>${new Date(entry.at).toLocaleTimeString()}</time><code>${escapeHtml(entry.type)}</code><span>${escapeHtml(entry.message)}</span></div>`).join('') : '<div class="empty">Waiting for events…</div>';
}

async function refreshNetwork() {
  try { renderNetwork(await jsonApi('/network-api/state')); }
  catch (error) { sysadminStatus.textContent = `error: ${error.message}`; }
}

scenarioButton.addEventListener('click', async () => {
  lifecycleCounts = [];
  liveHandoff.hidden = true;
  await jsonApi('/network-api/scenario/run', { method: 'POST', body: '{}' });
  await refreshNetwork();
});
actionButton.addEventListener('click', async () => {
  if (!employeeSelect.value) return;
  await jsonApi('/network-api/action', { method: 'POST', body: JSON.stringify({ employeeId: employeeSelect.value }) });
  await refreshNetwork();
});
joinButton.addEventListener('click', async () => { await jsonApi('/network-api/scenario/join-fourth', { method: 'POST', body: '{}' }); await refreshNetwork(); });
leaveButton.addEventListener('click', async () => { await jsonApi('/network-api/scenario/two-leave', { method: 'POST', body: '{}' }); await refreshNetwork(); });

// ---------- Voice view ----------
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
let voiceState = null;
let lastSpokenFragmentId = 0;
const recognitionLang = { ru: 'ru-RU', uk: 'uk-UA', sr: 'sr-RS', en: 'en-US' };
const speechLang = { ru: 'ru-RU', uk: 'uk-UA', sr: 'sr-RS', en: 'en-US' };

function setStatus(el, dot, value) {
  el.textContent = value;
  dot.className = `dot ${value === 'running' || value === 'listening' ? 'running' : value === 'queued' ? 'queued' : 'idle'}`;
}
function isSmartStyle() { return outputStyle.value !== 'faithful'; }
function visibleTranslation(f) { return isSmartStyle() ? (f.finalText || '') : (f.finalText || f.rawTranslation || ''); }
function currentOutputText() { return (voiceState?.fragments || []).map(visibleTranslation).filter(Boolean).join(' '); }
function currentVoiceScriptText() { return (voiceState?.fragments || []).map((f) => f.spokenText || '').filter(Boolean).join(' '); }

function cancelTts() {
  ttsWaitingForMicStop = false;
  if (speechSynthesisApi?.speaking || speechSynthesisApi?.pending) speechSynthesisApi.cancel();
  ttsPlaying = false;
}
function pickVoice(lang) {
  const voices = speechSynthesisApi?.getVoices?.() || [];
  return voices.find((v) => v.lang?.toLowerCase() === lang.toLowerCase()) || voices.find((v) => v.lang?.toLowerCase().startsWith(lang.split('-')[0].toLowerCase())) || null;
}
function pendingSpeakableBatch() {
  const fragments = (voiceState?.fragments || []).filter((f) => f.id > lastSpokenFragmentId && f.spokenText).sort((a, b) => a.id - b.id);
  if (!fragments.length) return null;
  return { text: fragments.map((f) => f.spokenText).join(' '), lastId: fragments.at(-1).id };
}
function restartRecognition() {
  if (!listening || !recognition || ttsPlaying || ttsWaitingForMicStop || recognitionActive) return;
  setTimeout(() => { if (listening && !ttsPlaying && !ttsWaitingForMicStop && !recognitionActive) { try { recognition.start(); } catch {} } }, 100);
}
function startTtsNow() {
  if (!speechSynthesisApi || voiceOutput.value !== 'auto' || ttsPlaying || userSpeaking) return;
  const batch = pendingSpeakableBatch();
  if (!batch) return;
  ttsPlaying = true;
  const utterance = new SpeechSynthesisUtterance(batch.text);
  utterance.lang = speechLang[targetLanguage.value] || 'en-US';
  const voice = pickVoice(utterance.lang); if (voice) utterance.voice = voice;
  utterance.onstart = () => { lastSpokenFragmentId = batch.lastId; listeningBadge.textContent = 'Speaking'; notice.textContent = 'Speaking the Voice Writer script.'; };
  utterance.onend = () => { ttsPlaying = false; listeningBadge.textContent = listening ? 'Listening' : 'Ready'; restartRecognition(); requestTts(); };
  utterance.onerror = () => { ttsPlaying = false; restartRecognition(); };
  speechSynthesisApi.cancel();
  setTimeout(() => { if (ttsPlaying) speechSynthesisApi.speak(utterance); }, 60);
}
function requestTts() {
  if (!speechSynthesisApi || voiceOutput.value !== 'auto' || ttsPlaying || ttsWaitingForMicStop || userSpeaking || !pendingSpeakableBatch()) return;
  if (recognitionActive && recognition) {
    ttsWaitingForMicStop = true;
    try { recognition.abort(); return; } catch { recognitionActive = false; ttsWaitingForMicStop = false; }
  }
  startTtsNow();
}

function renderVoice(state) {
  voiceState = state;
  const fragments = state.fragments || [];
  const source = fragments.map((f) => f.sourceText).filter(Boolean).join(' ');
  const translated = fragments.map(visibleTranslation).filter(Boolean).join(' ');
  const voiceScript = fragments.map((f) => f.spokenText || '').filter(Boolean).join(' ');
  originalText.textContent = source || 'Your speech will appear here.';
  translatedText.textContent = translated || (isSmartStyle() ? 'Waiting for the editor-verified translation…' : 'The translation will appear here.');
  voiceScriptText.textContent = voiceScript || 'The spoken version will appear here after verification.';
  saveVoiceButton.disabled = !voiceScript;
  setStatus(inputStatus, inputDot, state.sourceBusy ? 'running' : state.sourceQueueLength ? 'queued' : listening ? 'listening' : 'idle');
  setStatus(translatorStatus, translatorDot, state.translationBusy ? 'running' : state.translationQueueLength ? 'queued' : 'idle');
  setStatus(editorStatus, editorDot, state.editBusy ? 'running' : state.editQueueLength ? 'queued' : 'idle');
  setStatus(voiceWriterStatus, voiceWriterDot, state.voiceBusy ? 'running' : state.voiceQueueLength ? 'queued' : 'idle');
  sourceLanguage.value = state.sourceLanguage || sourceLanguage.value;
  targetLanguage.value = state.targetLanguage || targetLanguage.value;
  outputStyle.value = state.outputStyle || outputStyle.value;
  const latest = [...fragments].reverse().find((f) => f.clientFinalAt);
  latencyLine.textContent = latest ? `Latest fragment #${latest.id} · Translator ${latest.translatedAt ? ((latest.translatedAt - latest.clientFinalAt) / 1000).toFixed(2) + ' s' : '…'} · Editor ${latest.completedAt ? ((latest.completedAt - latest.clientFinalAt) / 1000).toFixed(2) + ' s' : '…'} · Voice ${latest.voiceCompletedAt ? ((latest.voiceCompletedAt - latest.clientFinalAt) / 1000).toFixed(2) + ' s' : '…'}` : 'Latency: waiting for speech…';
  requestTts();
}
async function refreshVoice() {
  try { renderVoice(await jsonApi('/voice-api/state')); }
  catch (error) { notice.textContent = `Connection error: ${error.message}`; }
}
async function sendFragment(text) {
  const clean = text.trim(); if (!clean) return;
  await jsonApi('/voice-api/fragment', { method: 'POST', body: JSON.stringify({ text: clean, clientFinalAt: Date.now() }) });
  interimText.textContent = '';
  await refreshVoice();
}
function stopRecognition() {
  listening = false; userSpeaking = false; ttsWaitingForMicStop = false;
  if (recognition) { try { recognition.abort(); } catch {} }
  recognitionActive = false; cancelTts(); micButton.textContent = '🎙 Start microphone'; listeningBadge.textContent = 'Ready'; interimText.textContent = '';
}
function startRecognition() {
  if (!SpeechRecognition) { notice.textContent = 'Chrome is required for microphone speech recognition.'; return; }
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
      if (event.results[i].isFinal) { userSpeaking = false; await sendFragment(text); }
      else { userSpeaking = true; interim += text; }
    }
    interimText.textContent = interim;
  };
  recognition.onerror = (event) => {
    if (ttsWaitingForMicStop && event.error === 'aborted') return;
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    notice.textContent = `Microphone error: ${event.error}`; stopRecognition();
  };
  recognition.onend = () => {
    recognitionActive = false; userSpeaking = false;
    if (ttsWaitingForMicStop) { ttsWaitingForMicStop = false; setTimeout(startTtsNow, 50); return; }
    restartRecognition();
  };
  listening = true; micButton.textContent = '■ Stop microphone'; listeningBadge.textContent = 'Listening'; notice.textContent = 'Speak naturally. The original voice backend is processing the fragment.'; recognition.start();
}

micButton.addEventListener('click', () => listening ? stopRecognition() : startRecognition());
voiceOutput.addEventListener('change', () => { if (voiceOutput.value === 'off') cancelTts(); else requestTts(); });
async function updateConfig() {
  if (listening) stopRecognition(); cancelTts();
  renderVoice(await jsonApi('/voice-api/config', { method: 'POST', body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value, outputStyle: outputStyle.value }) }));
}
sourceLanguage.addEventListener('change', updateConfig);
targetLanguage.addEventListener('change', updateConfig);
outputStyle.addEventListener('change', updateConfig);
clearButton.addEventListener('click', async () => { if (listening) stopRecognition(); cancelTts(); renderVoice(await jsonApi('/voice-api/clear', { method: 'POST', body: JSON.stringify({ sourceLanguage: sourceLanguage.value, targetLanguage: targetLanguage.value, outputStyle: outputStyle.value }) })); lastSpokenFragmentId = 0; });
copyButton.addEventListener('click', async () => { const text = currentOutputText(); if (text) await navigator.clipboard.writeText(text); });
saveVoiceButton.addEventListener('click', async () => {
  const text = currentVoiceScriptText(); if (!text) return;
  const response = await fetch('/voice-api/save-voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  if (!response.ok) return notice.textContent = 'Could not save voice.';
  const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'translator-voice.mp3'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

await refreshNetwork();
await refreshVoice();
setInterval(refreshNetwork, 300);
setInterval(refreshVoice, 300);
