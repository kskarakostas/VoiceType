// Welcome: the first-install checklist (V32), opened by onInstalled and linked from the sidebar
// footer. It reads live state and holds no form: the key stays on Provider, where Test lives, and
// permission.html asks for the microphone. That page reports to the worker, which ignores a report
// with no recording waiting, so opening it from here starts nothing.
import { formatChord } from '../../shared/chord.js';
import { PROVIDERS } from '../../shared/models.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const UNKNOWN = 'Unknown';
const MIC_TEXT = { granted: 'Allowed', prompt: 'Not allowed yet', denied: 'Blocked' };
const MIC_ASKS = 'Chrome asks once, for VoiceType itself, in a new tab.';
/** The wording of DENIED in src/background/recorder.js. */
const MIC_BLOCKED = 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.';
const OPEN_ERROR = 'Could not open the microphone page.';

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createWelcomeSection(ctx) {
  const { $, mac } = ctx;
  const el = {
    keyStatus: $('welcome-key-status'), keyState: $('welcome-key-state'),
    micStatus: $('welcome-mic-status'), micState: $('welcome-mic-state'), micHint: $('welcome-mic-hint'), allowMic: $('welcome-allow-mic'),
    hotkey: $('welcome-hotkey'),
  };

  function render() {
    const settings = ctx.settings();
    const { label } = PROVIDERS[settings.provider];
    const hasKey = Boolean(settings.keys[settings.provider]?.trim());
    el.keyStatus.dataset.ready = String(ctx.loaded() && hasKey);
    // Without loaded settings the key is not known; the banner explains.
    if (!ctx.loaded()) el.keyState.textContent = UNKNOWN;
    else el.keyState.textContent = hasKey ? `${label} key saved` : `No ${label} key`;
    el.hotkey.textContent = formatChord(settings.hotkey, { mac });
  }

  /** @param {string} [state] a PermissionState, or nothing when it could not be read */
  function showMic(state) {
    const granted = state === 'granted';
    el.micStatus.dataset.ready = String(granted);
    el.micState.textContent = MIC_TEXT[state] ?? UNKNOWN;
    el.micHint.textContent = state === 'denied' ? MIC_BLOCKED : MIC_ASKS;
    el.micHint.hidden = granted;
    el.allowMic.hidden = granted;
  }

  async function watchMic() {
    showMic();
    try {
      const status = await ctx.window.navigator.permissions.query({ name: 'microphone' });
      showMic(status.state);
      status.addEventListener('change', () => showMic(status.state));
    } catch {
      // The name is not one every browser knows; the button still works.
    }
  }

  el.allowMic.addEventListener('click', async () => {
    try {
      await ctx.chrome.tabs.create({ url: ctx.chrome.runtime.getURL('permission.html') });
    } catch {
      ctx.toast(OPEN_ERROR, 'error');
    }
  });

  watchMic();

  return { render };
}
