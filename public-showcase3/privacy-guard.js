const micButton = document.querySelector('#micButton');

/*
 * Product 3 browser-session guard.
 *
 * The hosted demo intentionally uses one in-memory Mozaik voice runtime. Multiple
 * browsers can therefore see the same server-side fragment list unless the UI
 * scopes it. We keep the runtime shared, but make each browser render and speak
 * only the fragments it submitted. This prevents a phone and desktop opened at
 * the same time from replaying each other's voice output.
 *
 * The same boundary also suppresses Chrome/Web Speech duplicate or cumulative
 * final transcripts (for example: "Let's" -> "Let's go" -> "Let's go now").
 * Only the non-overlapping remainder is submitted as the next fragment.
 */
const nativeFetch = window.fetch.bind(window);
const ownedVoiceFragmentIds = new Set();
let lastObservedFinal = '';
let lastObservedFinalAt = 0;
const FINAL_OVERLAP_WINDOW_MS = 8000;

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

function dedupeFinalTranscript(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const now = Date.now();
  if (!lastObservedFinal || now - lastObservedFinalAt > FINAL_OVERLAP_WINDOW_MS) {
    lastObservedFinal = raw;
    lastObservedFinalAt = now;
    return raw;
  }

  const previous = normalizeSpeech(lastObservedFinal);
  const current = normalizeSpeech(raw);
  const previousWords = previous.split(' ').filter(Boolean);
  const currentWords = current.split(' ').filter(Boolean);
  const originalWords = rawWords(raw);

  lastObservedFinal = raw;
  lastObservedFinalAt = now;

  if (!current || current === previous) return '';

  // Chrome can promote the same utterance through increasingly complete finals.
  if (current.startsWith(`${previous} `)) {
    return originalWords.slice(previousWords.length).join(' ');
  }
  if (previous.startsWith(`${current} `)) return '';

  // Also remove a short suffix/prefix overlap across consecutive finals.
  const maxOverlap = Math.min(previousWords.length, currentWords.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    const previousTail = previousWords.slice(-size).join(' ');
    const currentHead = currentWords.slice(0, size).join(' ');
    if (previousTail === currentHead) {
      return originalWords.slice(size).join(' ');
    }
  }

  return raw;
}

function resetLocalVoiceScope() {
  ownedVoiceFragmentIds.clear();
  lastObservedFinal = '';
  lastObservedFinalAt = 0;
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

window.fetch = async function scopedVoiceFetch(input, init = {}) {
  const url = requestUrl(input);
  const isVoiceApi = url.includes('/voice-api/');
  if (!isVoiceApi) return nativeFetch(input, init);

  if (url.includes('/voice-api/fragment') && String(init?.method || 'GET').toUpperCase() === 'POST') {
    let payload;
    try { payload = JSON.parse(init.body || '{}'); } catch { payload = null; }
    if (payload?.text) {
      const dedupedText = dedupeFinalTranscript(payload.text);
      if (!dedupedText) return jsonResponse({ id: null, deduped: true }, 202);
      payload.text = dedupedText;
      init = { ...init, body: JSON.stringify(payload) };
    }

    const response = await nativeFetch(input, init);
    try {
      const body = await response.clone().json();
      if (response.ok && Number.isFinite(Number(body?.id))) ownedVoiceFragmentIds.add(Number(body.id));
    } catch {}
    return response;
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
