// The in-page state machine: which field the pill follows, the recording state as this frame
// sees it, and where a finished transcript goes. Side effects arrive through deps.
import { MSG } from '../shared/messages.js';
import { finite } from '../shared/numbers.js';
import { MAX_EDIT_CHARS } from '../shared/defaults.js';
import { isPasswordField } from './fields.js';
import { normalizeForCompare, readSelection } from './insert.js';
import { createPlacement } from './placement.js';
import { STATUS_MS } from './pill.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {Pick<import('./pill.js').Pill, 'show'|'reposition'|'hide'|'visible'|'host'|'setStyle'|'setLook'|'setState'|'setLevel'
 *   |'setStatus'|'clearStatus'|'renderMenu'|'destroy'>} PillLike
 * @typedef {'idle'|'starting'|'recording'|'processing'} ControllerState
 * @typedef {{
 *   pill: PillLike,
 *   send: (message: object) => Promise<any|null>,
 *   insertText: typeof import('./insert.js').insertText,
 *   copyText: typeof import('./insert.js').copyText,
 *   markInsertion: typeof import('./insert.js').markInsertion,
 *   replaceInsertion: typeof import('./insert.js').replaceInsertion,
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
/** How often processing asks the service worker about its dictation, which also keeps it awake (V52). */
export const PING_MS = 5000;
/** Alive replies hold processing this long at most: past it a stuck session ends as the watchdog ends it. */
export const PROCESSING_CEILING_MS = PROCESSING_TIMEOUT_MS + 120_000;

const ORPHAN_NOTICE = 'VoiceType was turned off or updated. Reload this page.';
const NO_REPLY = 'VoiceType could not reach its background service. Try again.';
const NO_RESPONSE = 'No response from VoiceType. Try again.';
const LOST = Object.freeze({ text: 'VoiceType restarted. Check the clipboard, or try again.', tone: 'error' });
const HOLD_NOTICE = 'Return to the field to insert, or click here to copy.';
const PASSWORD_NOTICE = 'VoiceType does not record in password fields.';
const FOCUS_NOTICE = 'Click into the field you want to dictate into, then try again.';
const STILL_PROCESSING = 'Still processing';
const EDIT_START = 'Say how to change the selection.';
const NO_SELECTION = 'Select the text to edit first.';
const TOO_LONG = 'Selection too long to edit (10,000 characters at most).';
const AUTO_STOP = Object.freeze({
  maxTime: { text: 'Max time reached', tone: 'info' },
  silence: { text: 'Stopped after silence', tone: 'info' },
  ended: { text: 'Microphone disconnected', tone: 'warning' },
});
const DEFAULT_GAP = 8;

const textOr = (value, fallback) => (typeof value === 'string' && value ? value : fallback);

/**
 * @param {ControllerDeps} deps
 */
export function createController(deps) {
  const { pill, send, insertText, copyText, markInsertion, replaceInsertion, isValidInput, deepActiveElement, rectOf, watchAnchor } = deps;

  /** @type {ControllerState} */
  let state = 'idle';
  let settings = null;
  let usage = null;
  /** Element the pill is placed at (null: the corner or not shown). */
  let anchorEl = null;
  let unwatch = null;
  /** Field bound at REC start (D12): the text goes here only if it still has focus. */
  let target = null;
  /** The selection in target an edit started from (V47); null for a dictation. */
  let snapshot = null;
  let stopQueued = false;
  /** The current hotkey press started this recording, so a held release stops it. */
  let pressStarted = false;
  /** A press refused because a result is landing, kept while the chord stays down (V38): how it starts. */
  let pressQueued = null;
  let lastResult = null;
  /** The newest dictation of this site as of this menu open: `{ raw, text, refined }`, or null (V28). */
  let recent = null;
  /** A result for a field that kept this frame's focus while another frame or window had it. */
  let held = null;
  /** The last valid field focused in this frame (D12 across frames). */
  let lastField = null;
  /** A status is showing; the pill is not hidden under it. */
  let statusBusy = false;
  /** The status showing is sticky and clickable: a click on it is the way to a paid transcript. */
  let copyPending = false;
  /** A press could not copy the pending result: it has been offered twice, so the next press records. */
  let pressCopyFailed = false;
  /** Steps still putting a result in place or on the clipboard: `state` is idle, and their status is yet to come. */
  let landing = 0;
  let statusTimer = null;
  let focusTimer = null;
  let watchdog = null;
  let pinger = null;
  let processingSince = 0;
  let orphan = false;
  /** Orphaned under a click-to-copy status: the terminal notice waits for that click (V35). */
  let orphanNoticeOwed = false;
  let dead = false;

  const inactive = () => orphan || dead;
  /** This site's rule hides the pill (V64). */
  const hidden = () => settings?.site?.hidePill === true;
  const gap = () => (Number.isFinite(settings?.pillGap) && settings.pillGap >= 0 ? settings.pillGap : DEFAULT_GAP);
  /** The stored style, or Minimal where this site's rule hides the pill. */
  const presentation = () => (hidden() ? 'minimal' : settings?.pillStyle ?? 'dot');
  /** No idle pill here. Recording, processing and statuses still show (V10). */
  const noIdlePill = () => presentation() === 'minimal';
  /** Nothing is running, so a press may record. A step still landing would finish on top of the recording. */
  const canStart = () => state === 'idle' && landing === 0;
  /** No field is waiting on this frame any more. */
  const unbind = () => {
    target = null;
    snapshot = null;
  };

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
    // Never gated on pill.visible: a pill offscreen would come back when its field scrolls back.
    if (noIdlePill()) {
      hide();
      return;
    }
    // Another frame or window has the focus. This frame keeps its active field, but only the
    // frame the user is in shows an idle pill (spec 6.4); focusIn shows it again.
    if (!deps.hasFocus()) {
      hide();
      return;
    }
    const active = deepActiveElement();
    if (isValidInput(active)) {
      if (active !== anchorEl) anchorTo(active);
      return;
    }
    if (active && active === pill.host) return;
    hide();
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
      stopPings();
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
    stopPings();
  }

  /** Entering processing: every way out goes through the watchdog, which stops these. */
  function startPings() {
    if (pinger === null) processingSince = Date.now();
    deps.clearTimeout(pinger);
    pinger = deps.setTimeout(ping, PING_MS);
  }

  function stopPings() {
    deps.clearTimeout(pinger);
    pinger = null;
  }

  /** Scheduled on the send, not the reply: a reply that never comes must not end the pings. */
  async function ping() {
    const current = deps.setTimeout(ping, PING_MS);
    pinger = current;
    const reply = await send({ action: MSG.PROCESSING_PING });
    // Pings stopped, or a later one is out: this answer is old.
    if (pinger !== current) return;
    if (reply?.alive === false) onRecordingState({ state: 'idle', notice: LOST });
    else if (reply?.alive === true && Date.now() - processingSince < PROCESSING_CEILING_MS) armWatchdog();
  }

  function clearNotice() {
    deps.clearTimeout(statusTimer);
    statusTimer = null;
    statusBusy = false;
    copyPending = false;
    pill.clearStatus();
  }

  function render() {
    if (settings) pill.renderMenu(settings, usage, recent && { refined: recent.refined });
  }

  /** @param {unknown} next */
  function setSettings(next) {
    if (inactive()) return;
    if (!next || typeof next !== 'object' || !next.modes || typeof next.modes !== 'object') return;
    const hadNoIdlePill = noIdlePill();
    settings = next;
    // A hidden site keeps the Small indicator at the bottom (V64); the colour is the user's either way.
    pill.setLook({ miniSize: hidden() ? 'small' : settings.miniSize, recColor: settings.recColor, beside: !hidden() });
    pill.setStyle(presentation());
    render();
    if (noIdlePill() !== hadNoIdlePill) settle();
  }

  /** @param {unknown} stats the GET_USAGE reply ({ today, last7Days, thisWeek, total, week }) */
  function setUsage(stats) {
    if (inactive() || !stats || typeof stats !== 'object') return;
    const { today, total } = /** @type {any} */ (stats);
    if (!today || typeof today !== 'object' || !total || typeof total !== 'object') return;
    usage = { todayCost: finite(today.estimatedCost), todaySessions: finite(today.sessions), totalCost: finite(total.estimatedCost) };
    render();
  }

  /** @param {unknown} entry the GET_LAST_DICTATION reply's entry: `{ raw, text }`, or null */
  function setRecent(entry) {
    if (inactive()) return;
    const { raw, text, edit } = /** @type {any} */ (entry) ?? {};
    // A refine of whitespace alone gets no Undo: the ladder's read-back could not tell it happened.
    // Neither does an edit: raw is the instruction, and Ctrl+Z is the undo (V48).
    recent = typeof raw === 'string' && typeof text === 'string' && text
      ? { raw, text, refined: edit !== true && normalizeForCompare(raw) !== normalizeForCompare(text) }
      : null;
    render();
  }

  /** @param {Element|null} el */
  function focusIn(el) {
    if (inactive() || !isValidInput(el)) return;
    lastField = el;
    if (state === 'idle' && (statusBusy || !noIdlePill())) anchorTo(el);
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

  /** @param {{ selection?: ReturnType<typeof readSelection> }} [options] an edit starts from its selection */
  async function start({ selection = null } = {}) {
    // REC while a result is held settles that result first. The next REC starts a recording
    // when this frame has the focus and no password field is focused.
    if (held) return deliverHeld();
    // So does REC on a pending click-to-copy: both are user gestures, and the next result would
    // overwrite the transcript. Only once: a copy that cannot work must not block recording for good.
    if (copyPending && !pressCopyFailed) {
      pressStarted = false;
      pressCopyFailed = !(await copyLast());
      return;
    }
    const active = deepActiveElement();
    const refusal = startRefusal(active);
    if (refusal) {
      pressStarted = false;
      // A pending click-to-copy status is kept: replacing it would strand the transcript.
      if (!copyPending) notify(refusal, { tone: 'info' });
      return;
    }
    target = isValidInput(active) ? active : null;
    snapshot = selection;
    // A press during the first settings read comes before any focusIn.
    if (target) lastField = target;
    stopQueued = false;
    state = 'starting';
    clearNotice();
    anchorTo(target);
    // A dictation omits the field: the router refuses `edit: null`.
    const reply = await send({ action: MSG.START_RECORDING, ...(selection && { edit: { text: selection.text } }) });
    // Torn down, orphaned, or reset meanwhile (pagehide): this reply is stale.
    if (inactive() || state !== 'starting') return;
    if (reply?.ok === true) {
      state = 'recording';
      pill.setState('recording');
      if (stopQueued) await stop();
      else if (selection) notify(EDIT_START, { tone: 'info' });
      return;
    }
    state = 'idle';
    unbind();
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
    // The start status asked for words, and they are in.
    if (snapshot) clearNotice();
    armWatchdog();
    startPings();
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
    if (canStart()) return start();
    if (state === 'starting') {
      stopQueued = true;
      return;
    }
    if (state === 'recording') return stop();
    notify(STILL_PROCESSING, { tone: 'info' });
  }

  function pressStart() {
    pressStarted = true;
    return start();
  }

  async function press() {
    if (inactive()) return;
    if (canStart()) return pressStart();
    pressStarted = false;
    pressQueued = state === 'idle' ? pressStart : null;
    return toggle();
  }

  /**
   * Start an edit of the focused field's selection, if it has one to edit (V42, V43).
   * @returns {boolean} the chord is claimed
   */
  function pressEdit() {
    const active = deepActiveElement();
    // A pending click-to-copy stays, as for a refused start.
    const refuse = (text, { claimed = false } = {}) => {
      if (!copyPending) notify(text, { tone: 'info' });
      return claimed;
    };
    if (isPasswordField(active)) return refuse(PASSWORD_NOTICE);
    if (!deps.hasFocus() || !isValidInput(active)) return false;
    const selection = readSelection(active);
    if (!selection) return refuse(NO_SELECTION);
    if (selection.text.length > MAX_EDIT_CHARS) return refuse(TOO_LONG, { claimed: true });
    pressStarted = true;
    start({ selection });
    return true;
  }

  /**
   * The edit chord went down. Synchronous, unlike press: boot decides on this keydown whether to
   * preventDefault, so the answer cannot wait for anything (V43). In any state with something to
   * settle or stop it is the dictation chord, except that a press kept through a landing stays an edit.
   * @returns {boolean} the chord is claimed; if not, every keydown of this press is the page's
   */
  function editPress() {
    if (inactive()) return false;
    if (canStart() && !held && !(copyPending && !pressCopyFailed)) return pressEdit();
    press();
    if (pressQueued) pressQueued = pressEdit;
    return true;
  }

  /** @param {{ held: boolean }} release */
  async function release({ held } = { held: false }) {
    if (inactive()) return;
    pressQueued = null;
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
      startPings();
      const notice = Object.hasOwn(AUTO_STOP, message.reason) ? AUTO_STOP[message.reason] : null;
      if (notice) notify(notice.text, { tone: notice.tone });
      return;
    }
    if (message.state !== 'idle') return;
    // A permission result only concerns a frame that is not recording again already.
    if (message.reason === 'permission' && state !== 'idle') return;
    state = 'idle';
    clearWatchdog();
    unbind();
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
    const selection = snapshot;
    unbind();
    stopQueued = false;
    pressStarted = false;
    held = null;
    pressCopyFailed = false;
    if (state === 'processing') state = 'idle';
    if (!message.success) {
      pill.setState('error');
      // A failed edit's status copies what was said. Not sticky: the next press records (V46).
      const instruction = textOr(message.instruction, null);
      if (instruction) lastResult = { text: instruction, raw: instruction };
      notify(textOr(message.error, 'Transcription failed.'), { tone: message.tone === 'warning' ? 'warning' : 'error', clickable: instruction !== null });
      return;
    }
    const text = typeof message.text === 'string' ? message.text : '';
    lastResult = { text, raw: typeof message.raw === 'string' ? message.raw : text };
    clearMark();
    // The entry is no longer the newest dictation: an open menu drops it until its next open (V28).
    recent = null;
    render();
    // A result with no edit mark can reach an edit's frame, an earlier dictation's landing late: it
    // is not this selection's replacement.
    const edit = message.edit === true;
    const result = { text, cost: finite(message.cost), warning: textOr(message.warning, null), copied: message.copied, edit: edit || selection !== null, selection: edit ? selection : null };

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
   * @template T
   * @param {() => Promise<T>} step
   * @returns {Promise<T>}
   */
  async function whileLanding(step) {
    landing += 1;
    try {
      return await step();
    } finally {
      landing -= 1;
      startKeptPress();
    }
  }

  /** The last landing is over with the chord still down: the kept press starts, as any press. */
  function startKeptPress() {
    if (landing > 0 || !pressQueued) return;
    const kept = pressQueued;
    pressQueued = null;
    if (inactive() || !canStart()) return;
    kept();
  }

  /** True while el is the field the user is in: still in the document, focused, this frame included. */
  const hasLiveFocus = (el) => Boolean(el?.isConnected) && deepActiveElement() === el && deps.hasFocus();

  const { place, undoEdit, clearMark } = createPlacement({
    pill,
    insertText,
    copyText,
    markInsertion,
    replaceInsertion,
    isValidInput,
    hasLiveFocus,
    notify,
    inactive,
    whileLanding,
    lastRaw: () => lastResult.raw,
  });


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

  /**
   * Click-to-copy: the click is a user gesture, so the clipboard write is allowed now.
   * @returns {Promise<boolean>} the text was copied
   */
  function copyLast() {
    return whileLanding(copyResult);
  }

  async function copyResult() {
    // Only dead: an orphaned page's kept status lands here. The terminal notice takes no clicks.
    if (dead || !lastResult) return false;
    held = null;
    const copied = await copyText(lastResult.text);
    if (dead) return false;
    if (copied) {
      pressCopyFailed = false;
      pill.setState('idle');
      if (orphanNoticeOwed) showOrphanNotice();
      else notify('Copied to clipboard.', { tone: 'success' });
    } else {
      notify('Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true });
    }
    return copied;
  }

  /**
   * A choice in the menu's Last dictation section.
   * @param {'insert'|'copy'|'undo'} action
   */
  async function historyAction(action) {
    if (inactive() || !recent) return;
    if (!canStart()) {
      notify(STILL_PROCESSING, { tone: 'info' });
      return;
    }
    // A transcript waiting on a click goes first, as for REC: lastResult is the way to it (V35).
    if (held) return deliverHeld();
    if (copyPending && !pressCopyFailed) {
      pressCopyFailed = !(await copyLast());
      return;
    }
    // The copy failed, so lastResult is all there is of that text: only the same text may go ahead,
    // which keeps Insert as a way out. Undo would put raw in its place.
    if (copyPending && (action === 'undo' || recent.text !== lastResult.text)) return;
    const { raw, text } = recent;
    if (action === 'undo') {
      lastResult = { text: raw, raw };
      return whileLanding(() => undoEdit(raw, text));
    }
    lastResult = { text, raw };
    const active = deepActiveElement();
    const bound = action === 'insert' && isValidInput(active) ? active : null;
    return place(bound, { text, cost: 0, warning: null, copied: null, unpaid: true });
  }

  /**
   * Send a menu choice. The menu re-renders from the SETTINGS_CHANGED push that follows a save.
   * @param {object} message
   */
  async function save(message) {
    if (inactive()) return;
    const reply = await send(message);
    // A click-to-copy status is the way to a paid transcript: a failed save does not replace it (V35).
    if (inactive() || copyPending) return;
    if (!reply) notify(NO_REPLY, { tone: 'error' });
    else if (reply.success !== true) notify(textOr(reply.error, 'Could not save the setting.'), { tone: 'error' });
  }

  /** @param {{ activeMode?: string, provider?: string, translateTargetLang?: string }} patch */
  function choose(patch) {
    return save({ action: MSG.UPDATE_SETTINGS, patch });
  }

  /**
   * A mode picked in the menu: it updates this site's rule only on a site with a mode rule (V9).
   * @param {string} key
   */
  function chooseMode(key) {
    return settings?.site?.mode ? save({ action: MSG.SET_SITE_MODE, mode: key }) : choose({ activeMode: key });
  }

  /** Clear this site's mode, so the active mode applies here again. */
  function useActiveMode() {
    return save({ action: MSG.SET_SITE_MODE, mode: null });
  }

  function showOrphanNotice() {
    orphanNoticeOwed = false;
    ensureVisible();
    pill.setStatus(ORPHAN_NOTICE, { tone: 'error', sticky: true, terminal: true });
  }

  /**
   * The extension was turned off, reloaded or updated under this page: say so, then do nothing
   * more. A click-to-copy status stays first: lastResult holds its text, held included (V35).
   * That lasts on a turned-off extension or a page that refuses injection. After a reload or
   * update the re-injected copy tears this one down, status and text with it.
   */
  function orphaned() {
    if (inactive()) return;
    orphan = true;
    deps.clearTimeout(focusTimer);
    deps.clearTimeout(statusTimer);
    focusTimer = null;
    statusTimer = null;
    clearWatchdog();
    state = 'idle';
    unbind();
    stopQueued = false;
    pressStarted = false;
    held = null;
    pill.setState('idle');
    if (copyPending) orphanNoticeOwed = true;
    else showOrphanNotice();
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
    unbind();
    held = null;
    lastField = null;
    recent = null;
    clearMark();
    pill.destroy();
  }

  return {
    setSettings,
    /** The recording colour the mirror takes, as it has no settings of its own. */
    recColor: () => settings?.recColor ?? 'red',
    setUsage,
    focusIn,
    focusOut,
    toggle,
    press,
    editPress,
    release,
    handleMessage,
    copyLast,
    setRecent,
    historyAction,
    onWindowFocus,
    choose,
    chooseMode,
    useActiveMode,
    refreshAnchor: onAnchorChange,
    orphaned,
    teardown,
    get state() {
      return state;
    },
  };
}
