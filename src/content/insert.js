// Insertion ladder. Each rung is verified by reading the field back; the return value
// of execCommand is never trusted because it is false without a user gesture.

/** @param {Element} el */
export function readValue(el) {
  return isFormField(el) ? el.value : el.textContent;
}

function isFormField(el) {
  const tag = el?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

/**
 * @param {Element|null} target
 * @param {string} text
 * @param {{ execCommand?: (text: string) => boolean, writeClipboard?: (text: string) => Promise<void> }} [deps]
 * @returns {Promise<'inserted'|'clipboard'|'failed'>}
 */
export async function insertText(target, text, deps = {}) {
  const execCommand = deps.execCommand || ((t) => document.execCommand('insertText', false, t));
  const writeClipboard = deps.writeClipboard || ((t) => navigator.clipboard.writeText(t));
  if (!text) return 'failed';
  if (!target || !target.isConnected) return copy(text, writeClipboard);

  const editable = !isFormField(target);
  const prior = editable ? rangeInside(target) : null;
  try { target.focus(); } catch { /* some hosts throw on focus */ }
  if (editable) placeCaret(target, prior);
  const before = readValue(target);

  try { execCommand(text); } catch { /* fall through to the next rung */ }
  if (readValue(target) !== before) return 'inserted';

  const changed = isFormField(target) ? setFormValue(target, text) : setEditableText(target, text);
  if (changed && readValue(target) !== before) return 'inserted';

  return copy(text, writeClipboard);
}

/** Clone of the selection range when it lies inside el, taken before focus() can move it. */
function rangeInside(el) {
  const sel = el.ownerDocument.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.commonAncestorContainer) ? range.cloneRange() : null;
}

/** focus() puts the caret at the start of an editable; restore the prior caret or go to the end. */
function placeCaret(el, prior) {
  try {
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    if (!sel) return;
    let range = prior;
    if (!range) {
      range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
  } catch { /* keep whatever selection focus() left */ }
}

async function copy(text, writeClipboard) {
  try {
    await writeClipboard(text);
    return 'clipboard';
  } catch {
    return 'failed';
  }
}

function inputEvent(type, text) {
  const Ctor = typeof InputEvent === 'function' ? InputEvent : Event;
  return new Ctor(type, { bubbles: true, inputType: 'insertText', data: text });
}

function setFormValue(el, text) {
  try {
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + text + el.value.slice(end);
    const proto = el.tagName.toLowerCase() === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, next); else el.value = next;
    const caret = start + text.length;
    try { el.setSelectionRange(caret, caret); } catch { /* email and number inputs refuse */ }
    el.dispatchEvent(inputEvent('input', text));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function setEditableText(el, text) {
  try {
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    let range;
    if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      range = sel.getRangeAt(0);
    } else {
      range = doc.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    range.deleteContents();
    const node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    el.dispatchEvent(inputEvent('input', text));
    return true;
  } catch {
    return false;
  }
}
