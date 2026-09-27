// Insertion ladder v2. Every rung is read back only after the page had time to react,
// because editors such as Lexical and ProseMirror commit in a microtask or later. The ladder
// advances only when a rung provably did nothing; any other result ends at the clipboard,
// so the text is never inserted twice.
import { deepActiveElement, isEditableElement, isFrameworkEditor } from './fields.js';

/** Hosts whose editors ignore synthetic input (Google Docs types into a hidden iframe). */
export const CLIPBOARD_ONLY_HOSTS = new Set(['docs.google.com']);

const FRAME_WAIT_MS = 50;
const POLL_MS = 16;
const SETTLE_MS = 100;

/**
 * @typedef {'inserted'|'unverified'|'clipboard'|'failed'} InsertOutcome
 * @typedef {{
 *   execCommand?: (text: string) => boolean,
 *   dispatch?: (el: Element, event: Event) => boolean,
 *   writeClipboard?: (text: string) => Promise<void>,
 *   execCopy?: (text: string) => boolean,
 *   settle?: (check: () => boolean) => Promise<boolean>,
 *   hostname?: string,
 *   createPasteEvent?: (text: string) => Event|null,
 *   isTrusted?: (event: Event) => boolean,
 * }} InsertDeps
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
 * Copies text. Uses the Clipboard API when the page has one; plain http pages do not, so a
 * hidden textarea and `execCommand('copy')` stand in there.
 * @param {string} text
 * @param {{ writeClipboard?: (text: string) => Promise<void>, execCopy?: (text: string) => boolean }} [deps]
 * @returns {Promise<boolean>}
 */
export async function copyText(text, deps = {}) {
  const write = deps.writeClipboard ?? clipboardWriter();
  if (write) {
    try {
      await write(text);
      return true;
    } catch {
      return false;
    }
  }
  try {
    return (deps.execCopy ?? execCopy)(text) === true;
  } catch {
    return false;
  }
}

function clipboardWriter() {
  const clipboard = globalThis.navigator?.clipboard;
  return typeof clipboard?.writeText === 'function' ? (text) => clipboard.writeText(text) : null;
}

function execCopy(text) {
  const doc = globalThis.document;
  const active = deepActiveElement(doc);
  const selection = active && !isFormField(active) ? selectionFor(active) : null;
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  const area = doc.createElement('textarea');
  area.value = text;
  // readonly keeps the helper out of isValidInput, so the pill never moves to it.
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0;';
  doc.documentElement.append(area);
  try {
    area.focus({ preventScroll: true });
    area.select();
    return doc.execCommand('copy') === true;
  } finally {
    area.remove();
    try {
      active?.focus?.({ preventScroll: true });
      if (range) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } catch { /* restoring focus is best effort */ }
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

/** Focuses the target, fixes the caret and records the state every rung is judged against. */
function prepare(target, text, deps) {
  const editable = !isFormField(target);
  const prior = editable ? rangeInside(target) : null;
  try { target.focus({ preventScroll: true }); } catch { /* some hosts throw on focus */ }
  if (editable) placeCaret(target, prior);
  const before = readValue(target);
  return {
    target,
    text,
    before,
    nBefore: normalizeForCompare(before),
    nText: normalizeForCompare(text),
    nExpected: null,
    trusted: false,
    prevented: false,
    exec: deps.execCommand ?? ((t) => target.ownerDocument.execCommand('insertText', false, t)),
    dispatch: deps.dispatch ?? ((el, event) => el.dispatchEvent(event)),
    settle: deps.settle ?? defaultSettle,
    createPasteEvent: deps.createPasteEvent ?? createPasteEvent,
    isTrusted: deps.isTrusted ?? ((event) => event.isTrusted === true),
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
  // may drop after the first line; editors take a multi-line paste whole.
  const rungs = /[\r\n]/.test(run.text) ? [paste, exec] : [exec, paste];
  // A synthetic beforeinput has no default action: it counts only when the editor handles it.
  rungs.push(() => attempt(run, () => {
    fire(run, beforeInputEvent(run.text));
    return true;
  }));
  // Framework editors revert foreign DOM writes one microtask later (the Lexical bug).
  if (isEditableElement(el) && !isFrameworkEditor(el)) rungs.push(() => attempt(run, () => rawInsert(run)));

  for (const rung of rungs) {
    const verdict = await rung();
    if (verdict !== 'advance') return verdict;
  }
  return 'advance';
}

/**
 * Runs one rung. `act` returns false when it did nothing observable, which skips the wait;
 * otherwise the page gets `settle` to react before the read-back.
 */
async function attempt(run, act) {
  run.trusted = false;
  run.prevented = false;
  if (act()) await run.settle(() => judge(run) === 'inserted');
  return judge(run);
}

/**
 * 'inserted' when verified; 'advance' only when the rung provably did nothing; 'untouched'
 * when the target left the document without a sign of an insert; 'ambiguous' otherwise.
 */
function judge(run) {
  const after = normalizeForCompare(readValue(run.target));
  const touched = after !== run.nBefore || run.trusted || run.prevented;
  if (!run.target.isConnected) return touched ? 'ambiguous' : 'untouched';
  if (after === run.nExpected || count(after, run.nText) > count(run.nBefore, run.nText)) return 'inserted';
  return touched ? 'ambiguous' : 'advance';
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
  try {
    const sel = selectionFor(el);
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!el.contains(range.commonAncestorContainer)) return null;
    const prefix = el.ownerDocument.createRange();
    prefix.selectNodeContents(el);
    prefix.setEnd(range.startContainer, range.startOffset);
    const from = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    return before.slice(0, from) + text + before.slice(prefix.toString().length);
  } catch {
    return null;
  }
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
