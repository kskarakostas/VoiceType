// One-time microphone grant page. The offscreen document cannot show Chrome's permission
// prompt, so this tab asks once for the extension origin and reports the answer.
import { MSG } from '../shared/messages.js';

const CLOSE_DELAY_MS = 1500;

const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
const helpEl = /** @type {HTMLElement} */ (document.getElementById('help'));

/** @param {boolean} granted */
function report(granted) {
  chrome.runtime.sendMessage({ action: MSG.PERMISSION_RESULT, granted }).catch(() => {});
}

async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    report(true);
    statusEl.textContent = 'Microphone allowed. You can close this tab and press REC again.';
    setTimeout(() => window.close(), CLOSE_DELAY_MS);
  } catch (err) {
    report(false);
    statusEl.textContent = err?.name === 'NotFoundError'
      ? 'No microphone found. Connect one, then press REC again.'
      : 'Microphone not allowed.';
    helpEl.hidden = false;
  }
}

requestMicrophone();
