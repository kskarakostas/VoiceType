/** Input types VoiceType may dictate into. `password` is deliberately absent. */
export const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

/** `contenteditable` attribute values that make an element editable (empty means true). */
const EDITABLE_ATTR_VALUES = new Set(['', 'true', 'plaintext-only']);

/**
 * True for elements VoiceType may dictate into. Password fields are excluded on purpose:
 * their audio would otherwise be sent to a cloud API.
 * @param {Element|null|undefined} el
 * @returns {boolean}
 */
export function isValidInput(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return !el.disabled && !el.readOnly;
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type) && !el.disabled && !el.readOnly;
  }
  if (isEditableElement(el)) return true;
  return el.getAttribute('role') === 'textbox';
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
 * document.activeElement stops at shadow hosts; follow open shadow roots down.
 * @param {Document|ShadowRoot} [root]
 * @returns {Element|null}
 */
export function deepActiveElement(root = document) {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
