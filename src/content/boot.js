// Boots the VoiceType content script in one frame: wires the page, the service worker and the
// controller. Everything is registered synchronously. Page script can dispatch look-alike
// events, so the page listeners act only on the browser's own (trusted) events.
import { MSG } from '../shared/messages.js';
import { DEFAULT_SETTINGS } from '../shared/defaults.js';
import { isValidChord } from '../shared/chord.js';
import { isValidInput, deepActiveElement } from './fields.js';
import { insertText, copyText } from './insert.js';
import { watchAnchor } from './anchor.js';
import { createChordTracker } from './hotkey.js';
import { Pill } from './pill.js';
import { createController } from './controller.js';

const TEARDOWN_EVENT = 'voicetype:teardown';

/**
 * @param {{ isTrusted?: (event: Event) => boolean }} [options] isTrusted is a seam for tests,
 *   whose dispatched events are all untrusted.
 */
export function boot({ isTrusted = (event) => event.isTrusted === true } = {}) {
  // A copy injected before an extension reload or update is still listening: remove it first.
  document.dispatchEvent(new CustomEvent(TEARDOWN_EVENT));

  let chord = DEFAULT_SETTINGS.hotkey;

  const pill = new Pill({
    onRec: () => { controller.toggle(); },
    onStatusClick: () => { controller.copyLast(); },
    onMenuOpen: () => { loadSettings({ withUsage: true }); },
    onMode: (key) => { controller.choose({ activeMode: key }); },
    onProvider: (id) => { controller.choose({ provider: id }); },
    onTargetLang: (lang) => { controller.choose({ translateTargetLang: lang }); },
  });

  const controller = createController({
    pill,
    send,
    insertText,
    copyText,
    isValidInput,
    deepActiveElement: () => deepActiveElement(document),
    rectOf,
    watchAnchor,
    hasFocus: () => document.hasFocus(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  });

  const tracker = createChordTracker({ getChord: () => chord });

  /**
   * Message the service worker. Resolves null on any failure; an invalidated extension
   * context (reloaded or updated extension) turns this copy into the terminal notice.
   * @param {object} message
   * @returns {Promise<any|null>}
   */
  async function send(message) {
    try {
      return (await chrome.runtime.sendMessage(message)) ?? null;
    } catch (err) {
      const text = String(err?.message ?? err);
      if (text.includes('Extension context invalidated')) controller.orphaned();
      else console.warn(`VoiceType: ${text}`);
      return null;
    }
  }

  /** @param {Element} el @returns {import('./position.js').Box|null} */
  function rectOf(el) {
    if (!el?.isConnected) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  }

  /** The chord tracker reads the hotkey from here; the controller keeps the rest of the settings. */
  function trackHotkey(settings) {
    if (settings && typeof settings === 'object' && isValidChord(settings.hotkey)) chord = settings.hotkey;
  }

  async function loadSettings({ withUsage = false } = {}) {
    const [settings, usage] = await Promise.all([
      send({ action: MSG.GET_SETTINGS }),
      withUsage ? send({ action: MSG.GET_USAGE }) : null,
    ]);
    trackHotkey(settings);
    controller.setSettings(settings);
    if (withUsage) controller.setUsage(usage);
  }

  function onFocusIn(event) {
    if (!isTrusted(event)) return;
    controller.focusIn(event.composedPath()[0] ?? null);
  }

  function onFocusOut(event) {
    if (!isTrusted(event)) return;
    controller.focusOut();
  }

  function onKeyDown(event) {
    if (!isTrusted(event)) return;
    const kind = tracker.keydown(event);
    if (!kind) return;
    event.preventDefault();
    event.stopPropagation();
    if (kind === 'press') controller.press();
  }

  function onKeyUp(event) {
    if (!isTrusted(event)) return;
    const released = tracker.keyup(event);
    if (released) controller.release(released);
  }

  function onWindowBlur(event) {
    if (!isTrusted(event)) return;
    const released = tracker.blur();
    if (released) controller.release(released);
  }

  function onWindowFocus(event) {
    if (!isTrusted(event)) return;
    controller.onWindowFocus();
  }

  function onPageHide(event) {
    if (!isTrusted(event)) return;
    if (controller.state !== 'starting' && controller.state !== 'recording') return;
    send({ action: MSG.CANCEL_RECORDING });
    // The page may come back from the back-forward cache; do not leave it showing a recording.
    controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
  }

  function onMessage(message) {
    if (message?.action === MSG.SETTINGS_CHANGED) trackHotkey(message.settings);
    controller.handleMessage(message);
    return false;
  }

  function teardown() {
    controller.teardown();
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pagehide', onPageHide);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // An orphaned context may refuse; its listener is dead anyway.
    }
  }

  document.addEventListener(TEARDOWN_EVENT, teardown, { once: true });
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  // Not capture: element blur and focus events would reach a capturing window listener too.
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pagehide', onPageHide);
  chrome.runtime.onMessage.addListener(onMessage);

  loadSettings();
  // Injected after an update, or at document_idle after the user already clicked into a field.
  controller.focusIn(deepActiveElement(document));
}
