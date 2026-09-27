// Keyboard chords for the hotkey: validation, matching, capture and display. Pure functions.

/**
 * A main key (`KeyboardEvent.code`) plus the exact set of modifiers held with it.
 * @typedef {{ code: string, ctrl: boolean, shift: boolean, alt: boolean, meta: boolean }} Chord
 */

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

// Escape cancels the popup recorder and Tab moves focus; neither may become the hotkey.
const RESERVED_CODES = new Set(['Escape', 'Tab']);

const FLAGS = ['ctrl', 'shift', 'alt', 'meta'];

/**
 * True for a usable chord: a non-modifier `code`, four boolean flags and at least one of
 * Ctrl, Alt or Meta (Shift alone would fire while typing capitals).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidChord(value) {
  if (!value || typeof value !== 'object') return false;
  const c = /** @type {Record<string, unknown>} */ (value);
  if (typeof c.code !== 'string' || c.code === '' || MODIFIER_CODES.has(c.code)) return false;
  if (!FLAGS.every((flag) => typeof c[flag] === 'boolean')) return false;
  return Boolean(c.ctrl || c.alt || c.meta);
}

/**
 * Exact match: same code and exactly the same modifiers. An invalid chord matches nothing.
 * @param {{ code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }|null|undefined} event
 * @param {Chord|null|undefined} chord
 * @returns {boolean}
 */
export function matchesChord(event, chord) {
  if (!event || !isValidChord(chord)) return false;
  return event.code === chord.code
    && Boolean(event.ctrlKey) === chord.ctrl
    && Boolean(event.shiftKey) === chord.shift
    && Boolean(event.altKey) === chord.alt
    && Boolean(event.metaKey) === chord.meta;
}

/**
 * The chord a keydown would record, or null for modifier-only keys, Escape, Tab, or a
 * key pressed without Ctrl, Alt or Meta.
 * @param {{ code: string, ctrlKey: boolean, shiftKey: boolean, altKey: boolean, metaKey: boolean }|null|undefined} event
 * @returns {Chord|null}
 */
export function chordFromEvent(event) {
  if (!event || RESERVED_CODES.has(event.code)) return null;
  const chord = {
    code: event.code,
    ctrl: Boolean(event.ctrlKey),
    shift: Boolean(event.shiftKey),
    alt: Boolean(event.altKey),
    meta: Boolean(event.metaKey),
  };
  return isValidChord(chord) ? chord : null;
}

/** @param {string} code */
function keyLabel(code) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return code;
}

/**
 * Human label such as `Ctrl+Shift+Space`. Modifiers in the order Ctrl, Alt, Shift, Meta;
 * on mac Alt is `Option` and Meta is `Cmd`. Empty for an invalid chord.
 * @param {Chord} chord
 * @param {{ mac?: boolean }} [options]
 * @returns {string}
 */
export function formatChord(chord, { mac = false } = {}) {
  if (!isValidChord(chord)) return '';
  const parts = [];
  if (chord.ctrl) parts.push('Ctrl');
  if (chord.alt) parts.push(mac ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  if (chord.meta) parts.push(mac ? 'Cmd' : 'Meta');
  parts.push(keyLabel(chord.code));
  return parts.join('+');
}
