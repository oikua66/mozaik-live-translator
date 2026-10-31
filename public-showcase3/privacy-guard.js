const micButton = document.querySelector('#micButton');

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
