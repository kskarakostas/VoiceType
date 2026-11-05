// Insertion ladder v2. Every rung is read back only after the page had time to react,
// because editors such as Lexical and ProseMirror commit in a microtask or later. The ladder
// advances only when a rung provably did nothing; any other result ends at the clipboard,
// so the text is never inserted twice.
import { isEditableElement, isFrameworkEditor, isPasteFirstEditor } from './fields.js';

/** Hosts whose editors ignore synthetic input (Google Docs types into a hidden iframe). */
export const CLIPBOARD_ONLY_HOSTS = new Set(['docs.google.com']);

const FRAME_WAIT_MS = 50;
const POLL_MS = 16;
const SETTLE_MS = 100;
const CONFIRM_MS = 100;
/** How long a clipboard write may stay pending before the copy moves on. */
export const WRITE_LIMIT_MS = 1000;

/** @param {Event} event */
const isTrustedEvent = (event) => event.isTrusted === true;

/**
 * @typedef {'inserted'|'unverified'|'clipboard'|'failed'} InsertOutcome
 * @typedef {{
 *   execCommand?: (text: string) => boolean,
 *   dispatch?: (el: Element, event: Event) => boolean,
 *   writeClipboard?: (text: string) => Promise<void>,
 *   execCopy?: (text: string) => boolean,
 *   settle?: (check: () => boolean) => Promise<boolean>,
 *   confirm?: () => Promise<void>,
 *   hostname?: string,
 *   createPasteEvent?: (text: string) => Event|null,
 *   isTrusted?: (event: Event) => boolean,
 *   replacing?: boolean,
 * }} InsertDeps
 * `replacing`: the text goes over a selection the caller checked, so only the exact result counts,
 * and the ladder ends at the clipboard if that selection moves under it.
 */

/**
 * @param {Element} el
 * @returns {string}
 */
export function readValue(el) {
  return isFormField(el) ? el.value : el.textContent;
}

function isFormField(el) {
  const tag = el?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/**
 * Comparison form for read-backs. Editors turn spaces into NBSP, add zero-width characters
 * and split lines into paragraphs, so all of those are dropped.
 * @param {string} s
 * @returns {string}
 */
export function normalizeForCompare(s) {
  return String(s).replace(/\r\n?/g, '\n').replace(/[ \n\u00A0\u200B\uFEFF]/g, '');
}

/**
 * Copies text. Uses the Clipboard API when the page has one; plain http pages do not, and a
 * frame without focus or without clipboard-write rejects it, so `execCommand('copy')` stands
 * in there; the `clipboardWrite` permission lets that command run without a user gesture.
 * Neither path moves focus or the selection.
 * @param {string} text
 * @param {{
 *   writeClipboard?: (text: string) => Promise<void>,
 *   execCopy?: (text: string) => boolean,
 *   isTrusted?: (event: Event) => boolean,
 * }} [deps]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
  const write = deps.writeClipboard ?? clipboardWriter();
  if (write) {
    let timer;
    try {
      // With no user activation Chrome can leave writeText pending behind a permission prompt,
      // which would hold a paid transcript for as long as the prompt stays open.
      await Promise.race([
        write(text),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Clipboard write timed out.')), WRITE_LIMIT_MS);
        }),
      ]);
      return true;
    } catch {
      // Refused (no clipboard-write in this frame) or still pending: try the execCommand path
      // before giving up.
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const copy = deps.execCopy ?? ((t) => execCopy(t, deps.isTrusted ?? isTrustedEvent));
    return copy(text) === true;
  } catch {
    return false;
  }
}

function clipboardWriter() {
  const clipboard = globalThis.navigator?.clipboard;
  return typeof clipboard?.writeText === 'function' ? (text) => clipboard.writeText(text) : null;
}

/**
 * `execCommand('copy')` with the text supplied by a one-shot `copy` listener instead of a
 * selection, so nothing is focused or selected: a frame without focus copies without pulling
 * keyboard focus out of the page the user is typing in. The `clipboardWrite` permission lets
 * the command run without a user gesture.
 * @param {string} text
 * @param {(event: Event) => boolean} isTrusted
 * @returns {boolean} true only when the command ran and the listener supplied the text
 */
function execCopy(text, isTrusted) {
  const doc = globalThis.document;
  let supplied = false;
  const onCopy = (event) => {
    // A copy event the page dispatched itself is not the command's: filling it would hand the
    // page the text while the clipboard keeps whatever the page chose.
    if (!isTrusted(event)) return;
    // Cancelled first, so a failed setData never lets the page's selection reach the clipboard.
    event.preventDefault();
    event.stopImmediatePropagation();
    // A page listener that ran earlier may have added other types, such as text/html.
    event.clipboardData.clearData();
    event.clipboardData.setData('text/plain', text);
    supplied = true;
  };
  doc.addEventListener('copy', onCopy, true);
  try {
    return doc.execCommand('copy') === true && supplied;
  } finally {
    doc.removeEventListener('copy', onCopy, true);
  }
}

/**
 * Inserts text at the caret of target and verifies that it landed.
 * 'inserted': verified in the field. 'unverified': a rung may have inserted but the
 * read-back was ambiguous; the text was also copied. 'clipboard': nothing was inserted; the
 * text was copied. 'failed': nothing was inserted and the copy failed (or text was empty).
 * @param {Element|null} target
 * @param {string} text
 * @param {InsertDeps} [deps]
 * @returns {Promise<InsertOutcome>}
 */
export async function insertText(target, text, deps = {}) {
  if (typeof text !== 'string' || text === '') return 'failed';
  const copyAs = async (outcome) => ((await copyText(text, deps)) ? outcome : 'failed');
  const hostname = deps.hostname ?? frameHostname(target?.ownerDocument);
  if (!target || !target.isConnected || CLIPBOARD_ONLY_HOSTS.has(hostname)) return copyAs('clipboard');
  // Whitespace-only text cannot be verified by read-back, so it is never typed.
  if (normalizeForCompare(text) === '') return copyAs('clipboard');

  const run = prepare(target, text, deps);
  const stopWatching = watchTrustedInput(run);
  let verdict;
  try {
    verdict = isFormField(target) ? await formLadder(run) : await editableLadder(run);
  } catch {
    verdict = 'ambiguous';
  } finally {
    stopWatching();
  }
  if (verdict === 'inserted') return 'inserted';
  return copyAs(verdict === 'ambiguous' ? 'unverified' : 'clipboard');
}

/**
 * Where text inserted a moment ago lies in a form field, read from the caret the insert left
 * after it, with the field's length then. Null without offsets (a contenteditable, an input with
 * no selection support) and when the field does not hold exactly this text there: a page may
 * have changed it on the way in.
 * @param {Element} el
 * @param {string} text
 * @returns {{ start: number, end: number, length: number }|null}
 */
export function markInsertion(el, text) {
  if (!isFormField(el) || typeof el.selectionEnd !== 'number') return null;
  const end = el.selectionEnd;
  const start = end - text.length;
  return start >= 0 && el.value.slice(start, end) === text ? { start, end, length: el.value.length } : null;
}

/**
 * Puts raw over text at the mark through the ladder, so one Ctrl+Z restores text. Null, with the
 * field and its selection untouched, unless text is exactly at the mark in a field of the same
 * length, so the same words typed before it do not pass: it never searches (V31). A ladder that
 * left the field as it was leaves the caret after text, not a selection one key would replace.
 * Whether el may be written at all is for the caller to check.
 * @param {Element} el
 * @param {{ start: number, end: number, length: number }} mark
 * @param {string} text
 * @param {string} raw
 * @param {InsertDeps & { insertText?: typeof insertText }} [deps]
 * @returns {Promise<InsertOutcome|null>}
 */
export async function replaceInsertion(el, { start, end, length }, text, raw, deps = {}) {
  if (!isFormField(el) || typeof el.selectionStart !== 'number') return null;
  const before = el.value;
  if (before.length !== length || before.slice(start, end) !== text) return null;
  el.setSelectionRange(start, end);
  const outcome = await (deps.insertText ?? insertText)(el, raw, deps);
  if (outcome !== 'inserted' && el.value === before) {
    try { el.setSelectionRange(end, end); } catch { /* no selection support */ }
  }
  return outcome;
}

/**
 * The selection inside a field: offsets in text units, a contenteditable's as `editableSplice`
 * counts them, and the text. For a contenteditable both go to its end at text (`endAtText`), and
 * that text keeps its line breaks. Null for a caret, whitespace, a selection not wholly inside el,
 * an input type with no selection API (email) and Google Docs (V42).
 * @param {Element} el
 * @param {{ hostname?: string }} [deps]
 * @returns {{ text: string, start: number, end: number }|null}
 */
export function readSelection(el, { hostname = frameHostname(el.ownerDocument) } = {}) {
  if (CLIPBOARD_ONLY_HOSTS.has(hostname)) return null;
  const selection = isFormField(el) ? formSelection(el) : editableSelection(el);
  return selection && hasText(selection.text) ? selection : null;
}

/** @param {string} s */
function hasText(s) {
  return normalizeForCompare(s).trim() !== '';
}

/**
 * True while el's selection is the one read earlier: same offsets and same text. It never searches.
 * @param {Element} el
 * @param {{ text: string, start: number, end: number }|null} snapshot
 * @returns {boolean}
 */
export function sameSelection(el, snapshot) {
  const now = readSelection(el);
  return now !== null && now.start === snapshot?.start && now.end === snapshot.end && now.text === snapshot.text;
}

function formSelection(el) {
  const { selectionStart: start, selectionEnd: end } = el;
  return typeof start === 'number' && start !== end ? { text: el.value.slice(start, end), start, end } : null;
}

function editableSelection(el) {
  try {
    const range = rangeInside(el);
    if (!range) return null;
    endAtText(el, range);
    const offsets = textOffsets(el, range);
    return offsets.start === offsets.end ? null : { text: renderedText(selectionFor(el), range), ...offsets };
  } catch {
    return null;
  }
}

/**
 * Where a contenteditable selection ends (V42): its last point in a text node holding more than
 * whitespace, the range's own end when that is one. A triple click runs on into the next block, and
 * a write over that much pulls the block up into this one.
 * @param {Element} el
 * @param {Range} range changed in place, and left as it is when it holds no such node
 * @returns {Range}
 */
function endAtText(el, range) {
  const { endContainer: end, endOffset } = range;
  if (end.nodeType === Node.TEXT_NODE && endOffset > 0 && hasText(end.data)) return range;
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (hasText(node.data) && range.comparePoint(node, node.data.length) === 0) last = node;
  }
  if (last) range.setEnd(last, last.data.length);
  return range;
}

/**
 * The text of range, which starts where the selection does. Not range.toString(): that runs
 * paragraphs together, and the text model would read one word. Only a selection renders, so one
 * with another end goes to range's for the read and back, in this task.
 * @param {Selection} sel
 * @param {Range} range
 */
function renderedText(sel, range) {
  const live = sel.getRangeAt(0);
  if (live.endContainer === range.endContainer && live.endOffset === range.endOffset) return sel.toString();
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel;
  sel.setBaseAndExtent(range.startContainer, range.startOffset, range.endContainer, range.endOffset);
  const text = sel.toString();
  sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  return text;
}

/** Focuses the target, fixes the caret and records the state every rung is judged against. */
function prepare(target, text, deps) {
  const editable = !isFormField(target);
  const replacing = deps.replacing === true;
  const prior = editable ? rangeInside(target) : null;
  try { target.focus({ preventScroll: true }); } catch { /* some hosts throw on focus */ }
  if (editable) placeCaret(target, replacing && prior ? endAtText(target, prior) : prior);
  const before = readValue(target);
  return {
    target,
    text,
    before,
    nBefore: normalizeForCompare(before),
    nText: normalizeForCompare(text),
    nExpected: null,
    replacing,
    selection: replacing ? readSelection(target) : null,
    trusted: false,
    prevented: false,
    exec: deps.execCommand ?? ((t) => target.ownerDocument.execCommand('insertText', false, t)),
    dispatch: deps.dispatch ?? ((el, event) => el.dispatchEvent(event)),
    settle: deps.settle ?? defaultSettle,
    confirm: deps.confirm ?? defaultConfirm,
    createPasteEvent: deps.createPasteEvent ?? createPasteEvent,
    isTrusted: deps.isTrusted ?? isTrustedEvent,
  };
}

async function formLadder(run) {
  const el = run.target;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  // Inputs without selection support (email) report null offsets; the text is appended.
  const from = typeof start === 'number' ? start : run.before.length;
  const to = typeof end === 'number' ? end : from;
  const expected = run.before.slice(0, from) + run.text + run.before.slice(to);
  run.nExpected = normalizeForCompare(expected);

  // Rung 0: re-applying the same offsets ends the page's typing run, so one Ctrl+Z
  // removes exactly the dictation.
  if (typeof start === 'number') {
    try { el.setSelectionRange(start, end); } catch { /* no selection support */ }
  }
  // Rung 1 only when focus really reached the target, so a focus trap cannot redirect it.
  if (isFocused(el)) {
    const verdict = await attempt(run, () => runExec(run));
    if (verdict !== 'advance') return verdict;
  }
  // Rung 2: a page that prevents beforeinput takes over; otherwise the native setter.
  return attempt(run, () => {
    const allowed = fire(run, beforeInputEvent(run.text));
    if (allowed && el.isConnected && normalizeForCompare(readValue(el)) === run.nBefore) {
      setNativeValue(run, expected, from + run.text.length);
    }
    return true;
  });
}

async function editableLadder(run) {
  const el = run.target;
  const expected = editableSplice(el, run.before, run.text);
  run.nExpected = expected === null ? null : normalizeForCompare(expected);

  const exec = () => attempt(run, () => isFocused(el) && runExec(run));
  const paste = () => attempt(run, () => {
    const event = run.createPasteEvent(run.text);
    if (!event) return false;
    fire(run, event);
    return true;
  });
  // Chrome turns each newline of execCommand into a separate paragraph step, which Lexical
  // may drop after the first line; editors take a multi-line paste whole. Slate never takes
  // execCommand text into its model, so it gets the paste first whatever the text.
  const pasteFirst = /[\r\n]/.test(run.text) || isPasteFirstEditor(el);
  const rungs = pasteFirst ? [paste, exec] : [exec, paste];
  // A synthetic beforeinput has no default action: it counts only when the editor handles it.
  rungs.push(() => attempt(run, () => {
    fire(run, beforeInputEvent(run.text));
    return true;
  }));
  // Framework editors revert foreign DOM writes one microtask later (the Lexical bug).
  if (isEditableElement(el) && !isFrameworkEditor(el)) rungs.push(() => rawRung(run));

  for (const rung of rungs) {
    const verdict = await rung();
    if (verdict !== 'advance') return verdict;
  }
  return 'advance';
}

/**
 * Runs one rung. `act` returns false when it did nothing observable, which skips the wait;
 * otherwise the page gets `settle` to react before the read-back. A rung writes at the live
 * selection, and the last rung's wait gave the page time to move it, so a replacement checks it
 * here, in the same task as `act`: 'moved' ends the ladder at the clipboard.
 */
async function attempt(run, act) {
  if (run.replacing && !sameSelection(run.target, run.selection)) return 'moved';
  run.trusted = false;
  run.prevented = false;
  if (act()) await run.settle(() => judge(run) === 'inserted');
  return judge(run);
}

/**
 * The raw DOM write. Other editors can re-render a task or more later and throw a foreign write
 * away, so a positive read-back is judged again after a confirmation window: still there is
 * 'inserted', back to the value before is 'reverted' (the clipboard takes the text), anything
 * else is 'ambiguous'.
 */
async function rawRung(run) {
  const verdict = await attempt(run, () => rawInsert(run));
  if (verdict !== 'inserted') return verdict;
  await run.confirm();
  if (judge(run) === 'inserted') return 'inserted';
  const reverted = run.target.isConnected && normalizeForCompare(readValue(run.target)) === run.nBefore;
  return reverted ? 'reverted' : 'ambiguous';
}

/**
 * 'inserted' when verified; 'advance' only when the rung provably did nothing; 'untouched'
 * when the target left the document without a sign of an insert; 'ambiguous' otherwise.
 */
function judge(run) {
  const after = normalizeForCompare(readValue(run.target));
  const touched = after !== run.nBefore || run.trusted || run.prevented;
  if (!run.target.isConnected) return touched ? 'ambiguous' : 'untouched';
  if (landed(run, after, touched)) return 'inserted';
  return touched ? 'ambiguous' : 'advance';
}

/**
 * A count cannot verify a replacement: its text may have been in the field, even inside the
 * selection, and the selection may have stayed beside it. Only the exact result does. Compare form
 * drops whitespace, so a rung that left the field as it was proves nothing about a change of
 * whitespace alone.
 */
function landed(run, after, touched) {
  if (run.replacing) return after === run.nExpected && (touched || readValue(run.target) !== run.before);
  return after === run.nExpected || count(after, run.nText) > count(run.nBefore, run.nText);
}

function count(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

function runExec(run) {
  try {
    return run.exec(run.text) === true;
  } catch {
    return false;
  }
}

/** Dispatches a synthetic event at the target; returns false when the page prevented it. */
function fire(run, event) {
  const notCancelled = run.dispatch(run.target, event);
  if (notCancelled === false || event.defaultPrevented) run.prevented = true;
  return !run.prevented;
}

function beforeInputEvent(text) {
  return new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text });
}

function inputEvent(text) {
  return new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text });
}

function createPasteEvent(text) {
  const { ClipboardEvent: Clipboard, DataTransfer: Transfer } = globalThis;
  if (typeof Clipboard !== 'function' || typeof Transfer !== 'function') return null;
  const clipboardData = new Transfer();
  clipboardData.setData('text/plain', text);
  return new Clipboard('paste', { bubbles: true, cancelable: true, composed: true, clipboardData });
}

function setNativeValue(run, value, caret) {
  const el = run.target;
  const setter = valueSetter(el);
  if (setter) setter.call(el, value); else el.value = value;
  try { el.setSelectionRange(caret, caret); } catch { /* no selection support */ }
  run.dispatch(el, inputEvent(run.text));
  run.dispatch(el, new Event('change', { bubbles: true }));
}

/** The prototype's value setter, found on the element's own realm (frames have their own). */
function valueSetter(el) {
  for (let proto = Object.getPrototypeOf(el); proto; proto = Object.getPrototypeOf(proto)) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) return setter;
  }
  return null;
}

function rawInsert(run) {
  const el = run.target;
  const sel = selectionFor(el);
  let range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  if (!range || !el.contains(range.commonAncestorContainer)) range = endOfContents(el);
  range.deleteContents();
  const node = el.ownerDocument.createTextNode(run.text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  run.dispatch(el, inputEvent(run.text));
  return true;
}

/** Records trusted input events in the target's window for the duration of the call. */
function watchTrustedInput(run) {
  const win = run.target.ownerDocument?.defaultView;
  if (!win) return () => {};
  const onInput = (event) => {
    if (run.isTrusted(event)) run.trusted = true;
  };
  win.addEventListener('input', onInput, true);
  return () => win.removeEventListener('input', onInput, true);
}

function isFocused(el) {
  return el.getRootNode().activeElement === el;
}

/** The field's value with text spliced over the current selection, or null when unknown. */
function editableSplice(el, before, text) {
  const offsets = selectionOffsets(el);
  return offsets && before.slice(0, offsets.start) + text + before.slice(offsets.end);
}

/** The current selection as text offsets into el, or null when it is not inside el or unknown. */
function selectionOffsets(el) {
  try {
    const range = rangeInside(el);
    return range && textOffsets(el, range);
  } catch {
    return null;
  }
}

/**
 * @param {Element} el
 * @param {Range} range inside el
 */
function textOffsets(el, range) {
  const prefix = el.ownerDocument.createRange();
  prefix.selectNodeContents(el);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset);
  return { start, end: prefix.toString().length };
}

/**
 * Selection that sees into el's shadow root; Chrome retargets document.getSelection() to the host.
 * @param {Element} el
 */
function selectionFor(el) {
  const root = el.getRootNode();
  return (typeof root.getSelection === 'function' && root.getSelection()) || el.ownerDocument.getSelection();
}

/** Clone of the selection range when it lies inside el, taken before focus() can move it. */
function rangeInside(el) {
  const sel = selectionFor(el);
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

/** focus() puts the caret at the start of an editable; restore the prior caret or go to the end. */
function placeCaret(el, prior) {
  try {
    const sel = selectionFor(el);
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(prior ?? endOfContents(el));
  } catch { /* keep whatever selection focus() left */ }
}

/**
 * Collapsed range at the end of the last non-blank text node, so text typed "at the end"
 * joins the last paragraph instead of landing after it at the editor root.
 */
function endOfContents(el) {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (/\S/.test(node.data)) last = node;
  }
  if (last) {
    range.setStart(last, last.data.length);
    range.collapse(true);
  } else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  return range;
}

function frameHostname(doc) {
  const loc = doc?.location;
  if (!loc) return '';
  if (loc.hostname) return loc.hostname;
  // about:blank frames inherit their parent's origin; Google Docs types into one.
  try {
    return new URL(loc.ancestorOrigins?.[0] ?? '').hostname;
  } catch {
    return '';
  }
}

/**
 * Waits for the page to react: one macrotask (MessageChannel, which hidden tabs do not
 * throttle and fake timers do not replace), then one animation frame raced with 50 ms, then
 * polls every 16 ms up to 100 ms in total. Resolves true as soon as check() is true.
 * @param {() => boolean} check
 * @returns {Promise<boolean>}
 */
async function defaultSettle(check) {
  const started = performance.now();
  await nextMacrotask();
  if (check()) return true;
  await nextFrame();
  if (check()) return true;
  while (performance.now() - started < SETTLE_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (check()) return true;
  }
  return false;
}

/** The raw rung's confirmation window: one animation frame raced with 50 ms, then 100 ms. */
async function defaultConfirm() {
  await nextFrame();
  await new Promise((resolve) => setTimeout(resolve, CONFIRM_MS));
}

function nextMacrotask() {
  if (typeof MessageChannel !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function nextFrame() {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_MS);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}
