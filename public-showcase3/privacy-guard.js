const micButton = document.querySelector('#micButton');

/*
 * Product 3 browser-session guard.
 *
 * The hosted demo intentionally uses one in-memory Mozaik voice runtime. Multiple
 * browsers can therefore see the same server-side fragment list unless the UI
 * scopes it. We keep the runtime shared, but make each browser render and speak
 * only the fragments it submitted.
 *
 * Chrome/Web Speech can emit several cumulative "final" transcripts for one
 * utterance (for example: "Let's" -> "Let's go" -> "Let's go now"). Instead of
 * sending each final immediately, we buffer a short burst and submit one merged
 * utterance after recognition settles. This prevents duplicated text, repeated
 * agent work, and repeated TTS playback.
 */
const nativeFetch = window.fetch.bind(window);
const ownedVoiceFragmentIds = new Set();
const FINAL_SETTLE_MS = 900;
const RECENT_FINAL_WINDOW_MS = 8000;
let pendingFinalPayload = null;
let pendingFinalTimer = null;
let recentSubmittedFinal = '';
let recentSubmittedAt = 0;

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input?.url || '';
}

function normalizeSpeech(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function rawWords(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function mergeFinalText(previousRaw, currentRaw) {
  const previous = String(previousRaw || '').trim();
  const current = String(currentRaw || '').trim();
  if (!previous) return current;
  if (!current) return previous;

  const previousNorm = normalizeSpeech(previous);
  const currentNorm = normalizeSpeech(current);
  if (!previousNorm) return current;
  if (!currentNorm) return previous;
  if (currentNorm === previousNorm) return current.length >= previous.length ? current : previous;

  // Most common Chrome behaviour: the newer final is a longer version of the old one.
  if (currentNorm.startsWith(`${previousNorm} `)) return current;
  if (previousNorm.startsWith(`${currentNorm} `)) return previous;

  const previousWordsNorm = previousNorm.split(' ').filter(Boolean);
  const currentWordsNorm = currentNorm.split(' ').filter(Boolean);
  const previousWordsRaw = rawWords(previous);
  const currentWordsRaw = rawWords(current);

  // Merge suffix/prefix overlap without repeating the shared words.
  const maxOverlap = Math.min(previousWordsNorm.length, currentWordsNorm.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tail = previousWordsNorm.slice(-size).join(' ');
    const head = currentWordsNorm.slice(0, size).join(' ');
    if (tail === head) return [...previousWordsRaw, ...currentWordsRaw.slice(size)].join(' ');
  }

  // Two distinct finals received in the same short recognition burst belong to
  // the same utterance for this demo, so keep both once rather than sending two jobs.
  return `${previous} ${current}`.trim();
}

function resetPendingFinal() {
  if (pendingFinalTimer) clearTimeout(pendingFinalTimer);
  pendingFinalTimer = null;
  pendingFinalPayload = null;
}

function resetLocalVoiceScope() {
  ownedVoiceFragmentIds.clear();
  recentSubmittedFinal = '';
  recentSubmittedAt = 0;
  resetPendingFinal();
}

function deriveScopedVoiceState(state) {
  const fragments = Array.isArray(state?.fragments)
    ? state.fragments.filter((fragment) => ownedVoiceFragmentIds.has(fragment.id))
    : [];

  return {
    ...state,
    fragments,
    sourceBusy: fragments.some((fragment) => fragment.sttStatus === 'normalizing'),
    translationBusy: fragments.some((fragment) => fragment.translationStatus === 'running'),
    editBusy: fragments.some((fragment) => ['queued', 'running'].includes(fragment.editingStatus)),
    voiceBusy: fragments.some((fragment) => ['queued', 'running'].includes(fragment.voiceStatus)),
    sourceQueueLength: fragments.filter((fragment) => fragment.sttStatus === 'normalizing').length,
    translationQueueLength: fragments.filter((fragment) => ['pending', 'running'].includes(fragment.translationStatus)).length,
    editQueueLength: fragments.filter((fragment) => ['queued', 'running'].includes(fragment.editingStatus)).length,
    voiceQueueLength: fragments.filter((fragment) => ['queued', 'running'].includes(fragment.voiceStatus)).length,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function flushPendingFinal() {
  pendingFinalTimer = null;
  const payload = pendingFinalPayload;
  pendingFinalPayload = null;
  if (!payload?.text) return;

  const text = String(payload.text).trim();
  const normalized = normalizeSpeech(text);
  if (!normalized) return;

  const now = Date.now();
  const recentNorm = normalizeSpeech(recentSubmittedFinal);
  if (recentNorm && now - recentSubmittedAt <= RECENT_FINAL_WINDOW_MS) {
    if (normalized === recentNorm || recentNorm.startsWith(`${normalized} `)) return;

    // A late cumulative final that extends the utterance after the settle window:
    // submit only the genuinely new tail, never the already processed prefix.
    if (normalized.startsWith(`${recentNorm} `)) {
      const recentWordCount = recentNorm.split(' ').filter(Boolean).length;
      const tail = rawWords(text).slice(recentWordCount).join(' ').trim();
      if (!tail) return;
      payload.text = tail;
    }
  }

  try {
    const response = await nativeFetch('/voice-api/fragment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) return;
    const body = await response.clone().json();
    if (Number.isFinite(Number(body?.id))) ownedVoiceFragmentIds.add(Number(body.id));
    recentSubmittedFinal = text;
    recentSubmittedAt = Date.now();
  } catch (error) {
    console.error('Buffered voice fragment failed:', error);
  }
}

function bufferFinalPayload(payload) {
  const text = String(payload?.text || '').trim();
  if (!text) return;

  if (!pendingFinalPayload) {
    pendingFinalPayload = { ...payload, text };
  } else {
    pendingFinalPayload = {
      ...pendingFinalPayload,
      ...payload,
      text: mergeFinalText(pendingFinalPayload.text, text),
      clientFinalAt: payload.clientFinalAt || pendingFinalPayload.clientFinalAt,
    };
  }

  if (pendingFinalTimer) clearTimeout(pendingFinalTimer);
  pendingFinalTimer = setTimeout(flushPendingFinal, FINAL_SETTLE_MS);
}

window.fetch = async function scopedVoiceFetch(input, init = {}) {
  const url = requestUrl(input);
  const isVoiceApi = url.includes('/voice-api/');
  if (!isVoiceApi) return nativeFetch(input, init);

  if (url.includes('/voice-api/fragment') && String(init?.method || 'GET').toUpperCase() === 'POST') {
    let payload;
    try { payload = JSON.parse(init.body || '{}'); } catch { payload = null; }
    if (payload?.text) bufferFinalPayload(payload);

    // Return immediately so multiple finals from the same recognition event can
    // reach the buffer instead of being serialized by app.js's await sendFragment().
    return jsonResponse({ id: null, buffered: true }, 202);
  }

  if (url.includes('/voice-api/state') && String(init?.method || 'GET').toUpperCase() === 'GET') {
    const response = await nativeFetch(input, init);
    if (!response.ok) return response;
    try {
      const body = await response.clone().json();
      return jsonResponse(deriveScopedVoiceState(body), response.status);
    } catch {
      return response;
    }
  }

  if (url.includes('/voice-api/clear') && String(init?.method || 'GET').toUpperCase() === 'POST') {
    resetPendingFinal();

    // Do not wipe another browser's active/completed session merely because this
    // browser entered Live Voice or pressed Clear. If foreign fragments exist,
    // clear only our local scope. If this browser is the sole owner, preserve the
    // original server-side clear behaviour.
    try {
      const stateResponse = await nativeFetch('/voice-api/state');
      const state = await stateResponse.clone().json();
      const fragments = Array.isArray(state?.fragments) ? state.fragments : [];
      const hasForeignFragments = fragments.some((fragment) => !ownedVoiceFragmentIds.has(fragment.id));

      if (hasForeignFragments) {
        let requested = {};
        try { requested = JSON.parse(init.body || '{}'); } catch {}
        resetLocalVoiceScope();
        return jsonResponse(deriveScopedVoiceState({
          ...state,
          sourceLanguage: requested.sourceLanguage || state.sourceLanguage,
          targetLanguage: requested.targetLanguage || state.targetLanguage,
          outputStyle: requested.outputStyle || state.outputStyle,
          fragments: [],
        }), 200);
      }
    } catch {}

    const response = await nativeFetch(input, init);
    if (response.ok) resetLocalVoiceScope();
    return response;
  }

  return nativeFetch(input, init);
};

function microphoneLooksActive() {
  return Boolean(micButton && /stop microphone/i.test(micButton.textContent || ''));
}

function privacyStop(reason) {
  if (!microphoneLooksActive()) return;
  micButton.click();
  const notice = document.querySelector('#notice');
  if (notice) notice.textContent = `Microphone stopped automatically for privacy (${reason}). Press Start microphone to resume.`;
}

// Switching tabs or minimizing the browser.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) privacyStop('page hidden');
});

// Switching to another application/window. Privacy-first: do not keep listening
// merely because Chrome still considers the document visible.
window.addEventListener('blur', () => privacyStop('window inactive'));

// Navigation, reload, closing the page, mobile app backgrounding.
window.addEventListener('pagehide', () => privacyStop('page left'));

async function clearStaleServerVoiceStateOnLoad() {
  try {
    const response = await nativeFetch('/voice-api/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (response.ok) resetLocalVoiceScope();
  } catch (error) {
    console.warn('Could not clear stale voice state on page load:', error);
  }
}

function injectLegalUi() {
  const style = document.createElement('style');
  style.textContent = `
    .legal-consent{margin:12px 0 0;color:#667085;font-size:11px;line-height:1.5;text-align:center}
    .legal-consent a,.legal-footer a{color:#475467;text-decoration:none;font-weight:750}
    .legal-consent a:hover,.legal-footer a:hover{text-decoration:underline}
    .legal-footer{display:flex;justify-content:center;align-items:center;gap:9px;flex-wrap:wrap;margin:26px 0 0;padding:16px 0 0;border-top:1px solid #e4e7ec;color:#98a2b3;font-size:11px}
    .legal-footer .legal-brand{color:#667085;font-weight:750}
    .legal-footer .legal-dot{color:#c8cdd7}
  `;
  document.head.appendChild(style);

  const voiceShell = document.querySelector('#voiceView .shell');
  const notice = document.querySelector('#notice');
  if (voiceShell && notice && !document.querySelector('#legalConsent')) {
    const consent = document.createElement('p');
    consent.id = 'legalConsent';
    consent.className = 'legal-consent';
    consent.innerHTML = 'By using Live Voice, you agree to the <a href="/terms.html">Terms of Use</a> and acknowledge the <a href="/privacy.html">Privacy Policy</a>.';
    notice.insertAdjacentElement('afterend', consent);
  }

  document.querySelectorAll('.shell').forEach((shell) => {
    if (shell.querySelector('.legal-footer')) return;
    const footer = document.createElement('footer');
    footer.className = 'legal-footer';
    footer.innerHTML = '<span class="legal-brand">Corporate Agent Network</span><span class="legal-dot">·</span><a href="/terms.html">Terms</a><span class="legal-dot">·</span><a href="/privacy.html">Privacy</a><span class="legal-dot">·</span><a href="mailto:office@koretskiy.rs">Contact</a>';
    shell.appendChild(footer);
  });
}

clearStaleServerVoiceStateOnLoad();
injectLegalUi();
