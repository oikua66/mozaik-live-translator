const micButton = document.querySelector('#micButton');

/*
 * Product 3 browser-session guard.
 *
 * The hosted demo uses one in-memory Mozaik voice runtime. Keep browser rendering
 * scoped to fragments submitted by this browser, buffer cumulative Chrome speech
 * finals, and make every explicit new session/configuration change authoritative
 * on the backend so stale fragments cannot reappear or leak old language settings.
 */
const nativeFetch = window.fetch.bind(window);
const ownedVoiceFragmentIds = new Set();
const FINAL_SETTLE_MS = 900;
const RECENT_FINAL_WINDOW_MS = 8000;
let pendingFinalPayload = null;
let pendingFinalTimer = null;
let recentSubmittedFinal = '';
let recentSubmittedAt = 0;
let micRestartBypass = false;
let pendingVoiceConfig = null;

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

  if (currentNorm.startsWith(`${previousNorm} `)) return current;
  if (previousNorm.startsWith(`${currentNorm} `)) return previous;

  const previousWordsNorm = previousNorm.split(' ').filter(Boolean);
  const currentWordsNorm = currentNorm.split(' ').filter(Boolean);
  const previousWordsRaw = rawWords(previous);
  const currentWordsRaw = rawWords(current);

  const maxOverlap = Math.min(previousWordsNorm.length, currentWordsNorm.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const tail = previousWordsNorm.slice(-size).join(' ');
    const head = currentWordsNorm.slice(0, size).join(' ');
    if (tail === head) return [...previousWordsRaw, ...currentWordsRaw.slice(size)].join(' ');
  }

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
  const transition = Boolean(pendingVoiceConfig);
  const fragments = transition
    ? []
    : Array.isArray(state?.fragments)
      ? state.fragments.filter((fragment) => ownedVoiceFragmentIds.has(fragment.id))
      : [];
  const effectiveConfig = pendingVoiceConfig || {};

  return {
    ...state,
    sourceLanguage: effectiveConfig.sourceLanguage || state.sourceLanguage,
    targetLanguage: effectiveConfig.targetLanguage || state.targetLanguage,
    outputStyle: effectiveConfig.outputStyle || state.outputStyle,
    fragments,
    sourceBusy: transition ? false : fragments.some((fragment) => fragment.sttStatus === 'normalizing'),
    translationBusy: transition ? false : fragments.some((fragment) => fragment.translationStatus === 'running'),
    editBusy: transition ? false : fragments.some((fragment) => ['queued', 'running'].includes(fragment.editingStatus)),
    voiceBusy: transition ? false : fragments.some((fragment) => ['queued', 'running'].includes(fragment.voiceStatus)),
    sourceQueueLength: transition ? 0 : fragments.filter((fragment) => fragment.sttStatus === 'normalizing').length,
    translationQueueLength: transition ? 0 : fragments.filter((fragment) => ['pending', 'running'].includes(fragment.translationStatus)).length,
    editQueueLength: transition ? 0 : fragments.filter((fragment) => ['queued', 'running'].includes(fragment.editingStatus)).length,
    voiceQueueLength: transition ? 0 : fragments.filter((fragment) => ['queued', 'running'].includes(fragment.voiceStatus)).length,
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
  const method = String(init?.method || 'GET').toUpperCase();
  const isVoiceApi = url.includes('/voice-api/');
  if (!isVoiceApi) return nativeFetch(input, init);

  if (url.includes('/voice-api/fragment') && method === 'POST') {
    let payload;
    try { payload = JSON.parse(init.body || '{}'); } catch { payload = null; }
    if (payload?.text) bufferFinalPayload(payload);
    return jsonResponse({ id: null, buffered: true }, 202);
  }

  if (url.includes('/voice-api/state') && method === 'GET') {
    const response = await nativeFetch(input, init);
    if (!response.ok) return response;
    try {
      const body = await response.clone().json();
      return jsonResponse(deriveScopedVoiceState(body), response.status);
    } catch {
      return response;
    }
  }

  if (url.includes('/voice-api/config') && method === 'POST') {
    let requested = {};
    try { requested = JSON.parse(init.body || '{}'); } catch {}
    pendingVoiceConfig = { ...requested };
    resetPendingFinal();
    const response = await nativeFetch('/voice-api/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pendingVoiceConfig),
    });
    if (response.ok) {
      resetLocalVoiceScope();
      pendingVoiceConfig = null;
    }
    return response;
  }

  if (url.includes('/voice-api/clear') && method === 'POST') {
    resetPendingFinal();
    let requested = {};
    try { requested = JSON.parse(init.body || '{}'); } catch {}
    const body = pendingVoiceConfig ? JSON.stringify(pendingVoiceConfig) : JSON.stringify(requested);
    const response = await nativeFetch(input, { ...init, body });
    if (response.ok) {
      resetLocalVoiceScope();
      pendingVoiceConfig = null;
    }
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) privacyStop('page hidden');
});
window.addEventListener('blur', () => privacyStop('window inactive'));
window.addEventListener('pagehide', () => privacyStop('page left'));

if (micButton) {
  micButton.addEventListener('click', (event) => {
    if (micRestartBypass) {
      micRestartBypass = false;
      return;
    }
    if (microphoneLooksActive()) return;

    if (pendingVoiceConfig) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const notice = document.querySelector('#notice');
      if (notice) notice.textContent = 'Applying language change…';
      const waitForConfig = async () => {
        const deadline = Date.now() + 8000;
        while (pendingVoiceConfig && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (pendingVoiceConfig) {
          if (notice) notice.textContent = 'Language change is still processing. Press Start microphone again in a moment.';
          return;
        }
        micRestartBypass = true;
        micButton.click();
      };
      waitForConfig();
      return;
    }

    const original = document.querySelector('#originalText');
    const hasPreviousSession = ownedVoiceFragmentIds.size > 0 || (original && !original.classList.contains('empty'));
    if (!hasPreviousSession) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const clearButton = document.querySelector('#clearButton');
    if (!clearButton) return;

    clearButton.click();
    const waitForCleanStart = async () => {
      const deadline = Date.now() + 7000;
      while (Date.now() < deadline) {
        const text = String(document.querySelector('#originalText')?.textContent || '');
        const clean = !ownedVoiceFragmentIds.size && (/your speech will appear here/i.test(text) || document.querySelector('#originalText')?.classList.contains('empty'));
        if (clean) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      micRestartBypass = true;
      micButton.click();
    };
    waitForCleanStart();
  }, true);
}

['sourceLanguage', 'targetLanguage', 'outputStyle'].forEach((id) => {
  const control = document.querySelector(`#${id}`);
  if (!control) return;
  control.addEventListener('change', (event) => {
    const sourceLanguage = document.querySelector('#sourceLanguage')?.value;
    const targetLanguage = document.querySelector('#targetLanguage')?.value;
    const outputStyle = document.querySelector('#outputStyle')?.value;
    pendingVoiceConfig = { sourceLanguage, targetLanguage, outputStyle };
    event.stopImmediatePropagation();
    const clearButton = document.querySelector('#clearButton');
    if (clearButton) clearButton.click();
  }, true);
});

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

injectLegalUi();
