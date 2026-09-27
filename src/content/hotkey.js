// Hold-to-talk chord tracking. Pure: the entry feeds it window keydown, keyup and blur
// events and acts on the results; a release under HOLD_MS is a tap.
import { matchesChord } from '../shared/chord.js';

/** A press held at least this long is a hold (record until release); shorter is a tap. */
export const HOLD_MS = 300;

/** Key codes that release each modifier flag of a chord. */
const MODIFIER_CODES = Object.freeze({
  ctrl: ['ControlLeft', 'ControlRight'],
  shift: ['ShiftLeft', 'ShiftRight'],
  alt: ['AltLeft', 'AltRight'],
  meta: ['MetaLeft', 'MetaRight'],
});

/** True when keyup of `code` breaks the chord: its main key or a modifier it requires. */
function releases(code, chord) {
  if (code === chord.code) return true;
  return Object.entries(MODIFIER_CODES).some(([flag, codes]) => chord[flag] === true && codes.includes(code));
}

/**
 * `keydown` returns 'repeat' for auto-repeat of the held chord, and also for the main key's
 * auto-repeat after a modifier went up first (drained until that key goes up); the caller
 * swallows both.
 * @param {{ getChord: () => import('../shared/chord.js').Chord, holdMs?: number, now?: () => number }} options
 * @returns {{
 *   keydown(event: KeyboardEvent): 'press'|'repeat'|null,
 *   keyup(event: KeyboardEvent): { held: boolean }|null,
 *   blur(): { held: boolean }|null,
 *   readonly pressed: boolean,
 * }}
 */
export function createChordTracker({ getChord, holdMs = HOLD_MS, now = () => performance.now() }) {
  /** @type {{ chord: import('../shared/chord.js').Chord, at: number }|null} */
  let press = null;
  /** Main key code still down after a modifier ended its press; its auto-repeat is swallowed. */
  let draining = null;

  function end() {
    const held = now() - press.at >= holdMs;
    press = null;
    return { held };
  }

  return {
    keydown(event) {
      // While pressed, matching keydowns are auto-repeat: swallowed, never a second press.
      if (press) return matchesChord(event, press.chord) ? 'repeat' : null;
      if (event.code === draining) {
        // Its repeats now carry partial modifiers and would reach the page. A fresh keydown
        // means its keyup was lost: stop draining so real typing is never swallowed.
        if (event.repeat) return 'repeat';
        draining = null;
      }
      const chord = getChord();
      if (!chord || event.repeat || !matchesChord(event, chord)) return null;
      press = { chord, at: now() };
      return 'press';
    },
    keyup(event) {
      if (event.code === draining) draining = null;
      // Whichever key of the chord goes up first ends the press.
      if (!press || !releases(event.code, press.chord)) return null;
      if (event.code !== press.chord.code) draining = press.chord.code;
      return end();
    },
    blur() {
      // Keyups are lost while the window is unfocused (Alt+Tab), so a blur ends the hold.
      draining = null;
      return press ? end() : null;
    },
    get pressed() {
      return press !== null;
    },
  };
}
