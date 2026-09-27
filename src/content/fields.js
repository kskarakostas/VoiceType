/** Input types VoiceType may dictate into. `password` is deliberately absent. */
export const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

/** `contenteditable` attribute values that make an element editable (empty means true). */
const EDITABLE_ATTR_VALUES = new Set(['', 'true', 'plaintext-only']);

/**
 * Roots of editors that keep their own document model and revert foreign DOM writes:
 * Lexical, ProseMirror (and Tiptap), Slate, Quill, Draft.js, CodeMirror 6. Draft.js puts
 * `data-contents` on a child of its contenteditable, so its outer root class is listed too.
 */
const FRAMEWORK_EDITOR_SELECTOR = [
  '[data-lexical-editor]',
  '.ProseMirror',
  '[data-slate-editor]',
  '.ql-editor',
  '[data-contents]',
  '.DraftEditor-root',
  '.cm-content',
].join(', ');

/**
 * True for elements VoiceType may dictate into. Password fields (isPasswordField) are
 * excluded on purpose: their audio would otherwise be sent to a cloud API. `el.type` is used
 * because browsers report unknown type attributes as `text`.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isValidInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') {
    const type = String(el.type || 'text').toLowerCase();
    if (!TEXT_INPUT_TYPES.has(type) || isPasswordField(el)) return false;
    return !el.disabled && !el.readOnly;
  }
  if (isEditableElement(el)) return true;
  return el.getAttribute('role') === 'textbox';
}

/**
 * True for password fields: an input of type `password`, or an input with an `autocomplete`
 * token ending in `-password`, which marks a password field a page has revealed as plain
 * text. Checks the element only; which frame holds the focus is for the caller to check.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isPasswordField(el) {
  if (!el || el.nodeType !== 1 || el.tagName.toLowerCase() !== 'input') return false;
  if (String(el.type).toLowerCase() === 'password') return true;
  const tokens = (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  return tokens.some((token) => token.endsWith('-password'));
}

/**
 * True for contenteditable elements. jsdom lacks `isContentEditable`, and pages also use
 * `contenteditable=""`, so the attribute is checked as well.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isEditableElement(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable === true) return true;
  const editable = el.getAttribute('contenteditable');
  return editable !== null && EDITABLE_ATTR_VALUES.has(editable.toLowerCase());
}

/**
 * True when el belongs to a framework editor, which must never receive a raw DOM insert:
 * the editor reverts it after a microtask and the text is lost.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isFrameworkEditor(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.closest(FRAMEWORK_EDITOR_SELECTOR) !== null;
}

/**
 * Editors that get the paste rung before `execCommand('insertText')`, single-line text
 * included. Chrome fires no `beforeinput` for that command and slate-react ignores the
 * `input` that follows, so the text reaches Slate's DOM but not its model, and the next
 * keystroke erases it. Slate takes a plain-text paste into its model.
 */
export const PASTE_FIRST_EDITOR_SELECTOR = '[data-slate-editor]';

/**
 * True when el belongs to an editor that must get the paste rung first.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isPasteFirstEditor(el) {
  if (!el || el.nodeType !== 1) return false;
  return el.closest(PASTE_FIRST_EDITOR_SELECTOR) !== null;
}

/**
 * document.activeElement stops at shadow hosts; follow open shadow roots down.
 * @param {Document|ShadowRoot} [root]
 * @returns {Element|null}
 */
export function deepActiveElement(root = document) {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
