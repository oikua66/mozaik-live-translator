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
