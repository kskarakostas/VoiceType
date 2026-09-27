// The in-page state machine: which field the pill follows, the recording state as this frame
// sees it, and where a finished transcript goes. Side effects arrive through deps.
import { MSG } from '../shared/messages.js';
import { formatCost } from '../shared/pricing.js';
import { isPasswordField } from './fields.js';
import { STATUS_MS } from './pill.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {Pick<import('./pill.js').Pill, 'show'|'reposition'|'hide'|'visible'|'host'|'setState'|'setLevel'
 *   |'setStatus'|'clearStatus'|'renderMenu'|'destroy'>} PillLike
 * @typedef {'idle'|'starting'|'recording'|'processing'} ControllerState
 * @typedef {{
 *   pill: PillLike,
 *   send: (message: object) => Promise<any|null>,
 *   insertText: typeof import('./insert.js').insertText,
 *   copyText: typeof import('./insert.js').copyText,
 *   isValidInput: (el: Element|null) => boolean,
 *   deepActiveElement: () => Element|null,
 *   rectOf: (el: Element) => Box|null,
 *   watchAnchor: (el: Element, onChange: () => void) => () => void,
 *   hasFocus: () => boolean,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} ControllerDeps
 */

/** Delay before a focus-out hides the pill, so a click that moves focus can land first. */
export const FOCUS_OUT_MS = 200;
/** Processing with no word from the service worker for this long: it stopped or restarted. */
export const PROCESSING_TIMEOUT_MS = 75_000;

const ORPHAN_NOTICE = 'VoiceType was turned off or updated. Reload this page.';
const NO_REPLY = 'VoiceType could not reach its background service. Try again.';
const NO_RESPONSE = 'No response from VoiceType. Try again.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';
const HOLD_NOTICE = 'Return to the field to insert, or click here to copy.';
const PASSWORD_NOTICE = 'VoiceType does not record in password fields.';
const FOCUS_NOTICE = 'Click into the field you want to dictate into, then press REC.';
const AUTO_STOP = Object.freeze({
  maxTime: { text: 'Max time reached', tone: 'info' },
  silence: { text: 'Stopped after silence', tone: 'info' },
  ended: { text: 'Microphone disconnected', tone: 'warning' },
});
const DEFAULT_GAP = 8;

const finite = (value) => (Number.isFinite(value) ? value : 0);
const textOr = (value, fallback) => (typeof value === 'string' && value ? value : fallback);

/**
 * @param {ControllerDeps} deps
 */
export function createController(deps) {
  const { pill, send, insertText, copyText, isValidInput, deepActiveElement, rectOf, watchAnchor } = deps;

  /** @type {ControllerState} */
  let state = 'idle';
  let settings = null;
  let usage = null;
  /** Element the pill is placed at (null: the corner or not shown). */
  let anchorEl = null;
  let unwatch = null;
  /** Field bound at REC start (D12): the text goes here only if it still has focus. */
  let target = null;
  let stopQueued = false;
  /** The current hotkey press started this recording, so a held release stops it. */
  let pressStarted = false;
  let lastResult = null;
  /** A result for a field that kept this frame's focus while another frame or window had it. */
  let held = null;
  /** The last valid field focused in this frame (D12 across frames). */
  let lastField = null;
  /** A status is showing; the pill is not hidden under it. */
  let statusBusy = false;
  /** The status showing is sticky and clickable: a click on it is the way to a paid transcript. */
  let copyPending = false;
  let statusTimer = null;
  let focusTimer = null;
  let watchdog = null;
  let orphan = false;
  let dead = false;

  const inactive = () => orphan || dead;
  const gap = () => (Number.isFinite(settings?.pillGap) && settings.pillGap >= 0 ? settings.pillGap : DEFAULT_GAP);

  /** Show the pill at el (null: the corner) and follow it. */
  function anchorTo(el) {
    if (el !== anchorEl) {
      unwatch?.();
      unwatch = null;
      anchorEl = el;
      if (el) unwatch = watchAnchor(el, onAnchorChange);
    }
    pill.show(el ? rectOf(el) : null, { gap: gap() });
  }

  function onAnchorChange() {
    if (dead || !anchorEl) return;
    const box = rectOf(anchorEl);
    // A status (a sticky click-to-copy above all) moves to the corner instead of going away.
    if (!box && state === 'idle' && !orphan && !statusBusy) hide();
    else pill.reposition(box);
  }

  function hide() {
    unwatch?.();
    unwatch = null;
    anchorEl = null;
    pill.hide();
  }

  /** After focus or a status changes: follow the focused field, or hide an idle pill with nothing to show. */
  function settle() {
    if (inactive() || state !== 'idle' || statusBusy) return;
    // Another frame or window has the focus. This frame keeps its active field, but only the
    // frame the user is in shows an idle pill (spec 6.4); focusIn shows it again.
    if (!deps.hasFocus()) {
      if (pill.visible) hide();
      return;
    }
    const active = deepActiveElement();
    if (isValidInput(active)) {
      if (active !== anchorEl) anchorTo(active);
      return;
    }
    if (active && active === pill.host) return;
    if (pill.visible) hide();
  }

  /** A status lives on the pill: show a hidden pill at the focused field, else at the corner. */
  function ensureVisible() {
    if (pill.visible) return;
    const active = deepActiveElement();
    anchorTo(isValidInput(active) ? active : null);
  }

  function notify(text, { tone = 'info', sticky = false, clickable = false } = {}) {
    ensureVisible();
    pill.setStatus(text, { tone, sticky, clickable });
    deps.clearTimeout(statusTimer);
    statusTimer = null;
    statusBusy = true;
    copyPending = sticky && clickable;
    if (sticky) return;
    statusTimer = deps.setTimeout(() => {
      statusTimer = null;
      statusBusy = false;
      if (state === 'idle') pill.setState('idle');
      settle();
    }, STATUS_MS[tone] ?? STATUS_MS.info);
  }

  /** Processing: (re)start the wait for the service worker's next word. */
  function armWatchdog() {
    deps.clearTimeout(watchdog);
    watchdog = deps.setTimeout(() => {
      watchdog = null;
      if (inactive() || state !== 'processing') return;
      // target stays bound, so a result that still arrives goes to the field under D12.
      state = 'idle';
      stopQueued = false;
      pressStarted = false;
      pill.setState('error');
      notify(NO_RESPONSE, { tone: 'error' });
    }, PROCESSING_TIMEOUT_MS);
  }

  function clearWatchdog() {
    deps.clearTimeout(watchdog);
    watchdog = null;
  }

  function clearNotice() {
    deps.clearTimeout(statusTimer);
    statusTimer = null;
    statusBusy = false;
    copyPending = false;
    pill.clearStatus();
  }

  function render() {
    if (settings) pill.renderMenu(settings, usage);
  }

  /** @param {unknown} next */
  function setSettings(next) {
    if (inactive()) return;
    if (!next || typeof next !== 'object' || !next.modes || typeof next.modes !== 'object') return;
    settings = next;
    render();
  }

  /** @param {unknown} stats the GET_USAGE reply ({ today, last7Days, total }) */
  function setUsage(stats) {
    if (inactive() || !stats || typeof stats !== 'object') return;
    const { today, total } = /** @type {any} */ (stats);
    if (!today || typeof today !== 'object' || !total || typeof total !== 'object') return;
    usage = { todayCost: finite(today.estimatedCost), todaySessions: finite(today.sessions), totalCost: finite(total.estimatedCost) };
    render();
  }

  /** @param {Element|null} el */
  function focusIn(el) {
    if (inactive() || !isValidInput(el)) return;
    lastField = el;
    if (state === 'idle') anchorTo(el);
  }

  function focusOut() {
    if (inactive()) return;
    deps.clearTimeout(focusTimer);
    focusTimer = deps.setTimeout(() => {
      focusTimer = null;
      settle();
    }, FOCUS_OUT_MS);
  }

  /**
   * Why a recording may not start from this frame now, or null. A REC click on this frame's
   * pill leaves the keyboard focus where it was, possibly in another frame whose field this
   * frame cannot see, so only the frame that holds the focus records. The audio would go to a
   * cloud API, so a password field never starts a recording.
   * @param {Element|null} active
   */
  function startRefusal(active) {
    const tag = active?.tagName.toLowerCase();
    if (!deps.hasFocus() || tag === 'iframe' || tag === 'frame') return FOCUS_NOTICE;
    if (isPasswordField(active)) return PASSWORD_NOTICE;
    return null;
  }

  async function start() {
    // REC while a result is held settles that result first. The next REC starts a recording
    // when this frame has the focus and no password field is focused.
    if (held) return deliverHeld();
    const active = deepActiveElement();
    const refusal = startRefusal(active);
    if (refusal) {
      pressStarted = false;
      // A pending click-to-copy status is kept: replacing it would strand the transcript.
      if (!copyPending) notify(refusal, { tone: 'info' });
      return;
    }
    target = isValidInput(active) ? active : null;
    stopQueued = false;
    state = 'starting';
    clearNotice();
    anchorTo(target);
    const reply = await send({ action: MSG.START_RECORDING });
    // Torn down, orphaned, or reset meanwhile (pagehide): this reply is stale.
    if (inactive() || state !== 'starting') return;
    if (reply?.ok === true) {
      state = 'recording';
      pill.setState('recording');
      if (stopQueued) await stop();
      return;
    }
    state = 'idle';
    target = null;
    stopQueued = false;
    pressStarted = false;
    pill.setState('idle');
    if (reply && reply.ok === false) {
      const text = textOr(reply.error, 'Could not start the microphone.');
      notify(text, reply.reason === 'needsPermission' ? { tone: 'info', sticky: true } : { tone: 'error' });
    } else {
      notify(NO_REPLY, { tone: 'error' });
    }
  }

  async function stop() {
    stopQueued = false;
    state = 'processing';
    pill.setState('processing');
    armWatchdog();
    const reply = await send({ action: MSG.STOP_RECORDING });
    if (inactive() || state !== 'processing' || reply?.ok === true) return;
    // The service worker holds no session for this frame, so no result is coming for a stop.
    // A result that does arrive is still delivered: target stays bound until then.
    state = 'idle';
    clearWatchdog();
    pill.setState('idle');
    if (!reply) notify(NO_REPLY, { tone: 'error' });
    else settle();
  }

  /** One path for REC clicks and hotkey taps. */
  async function toggle() {
    if (inactive()) return;
    if (state === 'idle') return start();
    if (state === 'starting') {
      stopQueued = true;
      return;
    }
    if (state === 'recording') return stop();
    notify('Still processing', { tone: 'info' });
  }

  async function press() {
    if (inactive()) return;
    if (state === 'idle') {
      pressStarted = true;
      return start();
    }
    pressStarted = false;
    return toggle();
  }

  /** @param {{ held: boolean }} release */
  async function release({ held } = { held: false }) {
    if (inactive()) return;
    const started = pressStarted;
    pressStarted = false;
    if (!started || !held) return;
    if (state === 'starting') stopQueued = true;
    else if (state === 'recording') await stop();
  }

  function onRecordingState(message) {
    if (message.state === 'processing') {
      state = 'processing';
      stopQueued = false;
      pill.setState('processing');
      armWatchdog();
      const notice = Object.hasOwn(AUTO_STOP, message.reason) ? AUTO_STOP[message.reason] : null;
      if (notice) notify(notice.text, { tone: notice.tone });
      return;
    }
    if (message.state !== 'idle') return;
    // A permission result only concerns a frame that is not recording again already.
    if (message.reason === 'permission' && state !== 'idle') return;
    state = 'idle';
    clearWatchdog();
    target = null;
    stopQueued = false;
    pressStarted = false;
    pill.setState('idle');
    const notice = message.notice;
    if (notice && typeof notice === 'object' && typeof notice.text === 'string' && notice.text) {
      const tone = Object.hasOwn(STATUS_MS, notice.tone) ? notice.tone : 'info';
      // Permission notices arrive while the user is in the permission tab; keep them until the next REC.
      notify(notice.text, { tone, sticky: message.reason === 'permission' });
    } else {
      settle();
    }
  }

  /**
   * True while el still owns this frame's focus. Chromium resets a frame's activeElement to its
   * body when another frame takes the focus, so a blank activeElement counts for the field
   * focused last.
   * @param {Element} el
   */
  function ownsFrameFocus(el) {
    const active = deepActiveElement();
    if (active === el) return true;
    const doc = el.ownerDocument;
    return lastField === el && (active === null || active === doc.body || active === doc.documentElement);
  }

  async function deliver(message) {
    clearWatchdog();
    const bound = target;
    target = null;
    stopQueued = false;
    pressStarted = false;
    held = null;
    if (state === 'processing') state = 'idle';
    if (!message.success) {
      pill.setState('error');
      notify(textOr(message.error, 'Transcription failed.'), { tone: message.tone === 'warning' ? 'warning' : 'error' });
      return;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    lastResult = { text, raw: typeof message.raw === 'string' ? message.raw : text };
    const result = { text, cost: finite(message.cost), warning: textOr(message.warning, null) };

    if (bound && bound.isConnected && ownsFrameFocus(bound) && !deps.hasFocus()) {
      // The field kept this frame's focus, but another frame or window has the page's focus.
      // Inserting would pull focus away from where the user is typing, so wait for it to return.
      held = { bound, result };
      pill.setState('idle');
      notify(HOLD_NOTICE, { tone: 'info', sticky: true, clickable: true });
      return;
    }
    await place(bound, result);
  }

  /**
   * D12: the text goes into the field bound at REC start only while that field has focus,
   * this frame included; otherwise to the clipboard.
   * @param {Element|null} bound
   * @param {{ text: string, cost: number, warning: string|null }} result
   */
  async function place(bound, { text, cost, warning }) {
    if (bound && bound.isConnected && deepActiveElement() === bound && deps.hasFocus()) {
      let outcome;
      try {
        outcome = await insertText(bound, text);
      } catch {
        // A paid transcript is never dropped: the click-to-copy status keeps it.
        outcome = 'failed';
      }
      if (inactive()) return;
      if (outcome === 'inserted') {
        pill.setState('done');
        if (warning) notify(warning, { tone: 'warning' });
        else notify(`Done ${formatCost(cost)}`, { tone: 'success' });
      } else if (outcome === 'unverified') {
        pill.setState('done');
        notify('Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning' });
      } else if (outcome === 'clipboard') {
        pill.setState('done');
        notify('Copied to clipboard. The field could not be edited.', { tone: 'warning' });
      } else {
        pill.setState('error');
        notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
      }
      return;
    }

    const copied = await copyText(text);
    if (inactive()) return;
    if (!copied) {
      pill.setState('error');
      notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
    } else if (bound) {
      pill.setState('done');
      notify('The field lost focus. Text copied to clipboard.', { tone: 'warning' });
    } else {
      pill.setState('done');
      notify('Copied to clipboard.', { tone: 'info' });
    }
  }

  /** Deliver the held result once: into its field if that has focus now, else the clipboard. */
  async function deliverHeld() {
    const { bound, result } = held;
    held = null;
    await place(bound, result);
  }

  /** This frame's window regained focus: a held result can go to its field now. */
  async function onWindowFocus() {
    if (inactive() || !held) return;
    const { bound } = held;
    if (bound.isConnected && deepActiveElement() !== bound && ownsFrameFocus(bound)) {
      // Chromium focuses a frame's window before the element clicked inside it, so the
      // field's own focus lands later in this task: check again once it has.
      deps.setTimeout(() => {
        if (!inactive() && held) deliverHeld();
      }, 0);
      return;
    }
    await deliverHeld();
  }

  /** @param {unknown} message a runtime message from the service worker */
  function handleMessage(message) {
    if (inactive() || !message || typeof message !== 'object') return;
    const m = /** @type {any} */ (message);
    switch (m.action) {
      case MSG.SETTINGS_CHANGED:
        setSettings(m.settings);
        break;
      case MSG.AUDIO_LEVEL:
        if (state === 'recording') pill.setLevel(Number(m.level));
        break;
      case MSG.RECORDING_STATE:
        // An auto-stop turns this frame's recording into processing, but no report of a
        // recording that has not started yet can be current: it belongs to an earlier one.
        if (m.state === 'processing' && state === 'starting') break;
        onRecordingState(m);
        break;
      case MSG.DICTATION_RESULT:
        // A new recording is starting or running here, so this result belongs to an earlier one.
        if (state === 'starting' || state === 'recording') break;
        deliver(m);
        break;
      default:
        break;
    }
  }

  /** Click-to-copy: the click is a user gesture, so the clipboard write is allowed now. */
  async function copyLast() {
    if (inactive() || !lastResult) return;
    held = null;
    const copied = await copyText(lastResult.text);
    if (inactive()) return;
    if (copied) {
      pill.setState('idle');
      notify('Copied to clipboard.', { tone: 'success' });
    } else {
      notify('Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true });
    }
  }

  /**
   * A menu choice. The menu re-renders from the SETTINGS_CHANGED push that follows a save.
   * @param {{ activeMode?: string, provider?: string, translateTargetLang?: string }} patch
   */
  async function choose(patch) {
    if (inactive()) return;
    const reply = await send({ action: MSG.UPDATE_SETTINGS, patch });
    if (inactive()) return;
    if (!reply) notify(NO_REPLY, { tone: 'error' });
    else if (reply.success !== true) notify(textOr(reply.error, 'Could not save the setting.'), { tone: 'error' });
  }

  /** The extension was turned off, reloaded or updated under this page: say so, then do nothing more. */
  function orphaned() {
    if (inactive()) return;
    orphan = true;
    deps.clearTimeout(focusTimer);
    deps.clearTimeout(statusTimer);
    focusTimer = null;
    statusTimer = null;
    clearWatchdog();
    state = 'idle';
    target = null;
    stopQueued = false;
    pressStarted = false;
    held = null;
    pill.setState('idle');
    ensureVisible();
    pill.setStatus(ORPHAN_NOTICE, { tone: 'error', sticky: true, terminal: true });
  }

  /** Remove everything this instance added. Also runs after orphaned(): a newer copy replaces this one. */
  function teardown() {
    if (dead) return;
    if (!orphan && (state === 'starting' || state === 'recording')) send({ action: MSG.CANCEL_RECORDING });
    dead = true;
    deps.clearTimeout(focusTimer);
    deps.clearTimeout(statusTimer);
    focusTimer = null;
    statusTimer = null;
    clearWatchdog();
    unwatch?.();
    unwatch = null;
    anchorEl = null;
    target = null;
    held = null;
    lastField = null;
    pill.destroy();
  }

  return {
    setSettings,
    setUsage,
    focusIn,
    focusOut,
    toggle,
    press,
    release,
    handleMessage,
    copyLast,
    onWindowFocus,
    choose,
    orphaned,
    teardown,
    get state() {
      return state;
    },
  };
}
