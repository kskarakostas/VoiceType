import { describe, it, expect } from 'vitest';
import { isValidChord, matchesChord, chordFromEvent, formatChord } from '../../../src/shared/chord.js';

const CTRL_SHIFT_SPACE = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };

/** A keydown-like object; only the fields the helpers read. */
function key(code, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { code, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
}

describe('isValidChord', () => {
  it('accepts a main key with at least one of Ctrl, Alt or Meta', () => {
    expect(isValidChord(CTRL_SHIFT_SPACE)).toBe(true);
    expect(isValidChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false })).toBe(true);
    expect(isValidChord({ code: 'Digit5', ctrl: false, shift: true, alt: false, meta: true })).toBe(true);
  });

  it('rejects Shift alone or no modifier', () => {
    expect(isValidChord({ code: 'KeyA', ctrl: false, shift: true, alt: false, meta: false })).toBe(false);
    expect(isValidChord({ code: 'KeyA', ctrl: false, shift: false, alt: false, meta: false })).toBe(false);
  });

  it('rejects a modifier as the main key', () => {
    for (const code of ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']) {
      expect(isValidChord({ code, ctrl: true, shift: false, alt: true, meta: false }), code).toBe(false);
    }
  });

  it('rejects a missing or empty code and non-boolean flags', () => {
    expect(isValidChord({ ctrl: true, shift: false, alt: false, meta: false })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, code: '' })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, code: 32 })).toBe(false);
    expect(isValidChord({ ...CTRL_SHIFT_SPACE, ctrl: 1 })).toBe(false);
    expect(isValidChord({ code: 'Space', ctrl: true })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'Ctrl+Shift+Space', 5, true, []]) expect(isValidChord(value), String(value)).toBe(false);
  });
});

describe('matchesChord', () => {
  it('matches the exact code and modifier set', () => {
    expect(matchesChord(key('Space', { ctrl: true, shift: true }), CTRL_SHIFT_SPACE)).toBe(true);
  });

  it('rejects a missing or an extra modifier', () => {
    expect(matchesChord(key('Space', { ctrl: true }), CTRL_SHIFT_SPACE)).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true, alt: true }), CTRL_SHIFT_SPACE)).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true, meta: true }), CTRL_SHIFT_SPACE)).toBe(false);
  });

  it('rejects another key with the same modifiers', () => {
    expect(matchesChord(key('KeyS', { ctrl: true, shift: true }), CTRL_SHIFT_SPACE)).toBe(false);
  });

  it('never matches an invalid chord or a missing event', () => {
    expect(matchesChord(key('Space', { shift: true }), { code: 'Space', ctrl: false, shift: true, alt: false, meta: false })).toBe(false);
    expect(matchesChord(key('Space', { ctrl: true, shift: true }), null)).toBe(false);
    expect(matchesChord(null, CTRL_SHIFT_SPACE)).toBe(false);
  });
});

describe('chordFromEvent', () => {
  it('builds a chord from a key with Ctrl, Alt or Meta held', () => {
    expect(chordFromEvent(key('Space', { ctrl: true, shift: true }))).toEqual(CTRL_SHIFT_SPACE);
    expect(chordFromEvent(key('KeyD', { alt: true }))).toEqual({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false });
    expect(chordFromEvent(key('KeyK', { meta: true, shift: true }))).toEqual({ code: 'KeyK', ctrl: false, shift: true, alt: false, meta: true });
  });

  it('returns null for modifier-only keys', () => {
    expect(chordFromEvent(key('ControlLeft', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(key('ShiftRight', { ctrl: true, shift: true }))).toBeNull();
    expect(chordFromEvent(key('MetaLeft', { meta: true }))).toBeNull();
  });

  it('returns null for Escape and Tab even with modifiers', () => {
    expect(chordFromEvent(key('Escape', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(key('Tab', { alt: true }))).toBeNull();
  });

  it('returns null without Ctrl, Alt or Meta', () => {
    expect(chordFromEvent(key('KeyA'))).toBeNull();
    expect(chordFromEvent(key('KeyA', { shift: true }))).toBeNull();
  });

  it('returns null for an event without a code', () => {
    expect(chordFromEvent(key('', { ctrl: true }))).toBeNull();
    expect(chordFromEvent(null)).toBeNull();
  });
});

describe('formatChord', () => {
  it('formats the default chord', () => {
    expect(formatChord(CTRL_SHIFT_SPACE)).toBe('Ctrl+Shift+Space');
    expect(formatChord(CTRL_SHIFT_SPACE, { mac: true })).toBe('Ctrl+Shift+Space');
  });

  it('orders modifiers Ctrl, Alt, Shift, Meta and names them per platform', () => {
    const all = { code: 'KeyV', ctrl: true, shift: true, alt: true, meta: true };
    expect(formatChord(all)).toBe('Ctrl+Alt+Shift+Meta+V');
    expect(formatChord(all, { mac: true })).toBe('Ctrl+Option+Shift+Cmd+V');
  });

  it('shows letters and digits bare and other codes as is', () => {
    expect(formatChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false })).toBe('Alt+D');
    expect(formatChord({ code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false }, { mac: true })).toBe('Option+D');
    expect(formatChord({ code: 'Digit7', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+7');
    expect(formatChord({ code: 'KeyK', ctrl: false, shift: true, alt: false, meta: true }, { mac: true })).toBe('Shift+Cmd+K');
    expect(formatChord({ code: 'F5', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+F5');
    expect(formatChord({ code: 'Backquote', ctrl: false, shift: false, alt: true, meta: false })).toBe('Alt+Backquote');
    expect(formatChord({ code: 'Numpad1', ctrl: true, shift: false, alt: false, meta: false })).toBe('Ctrl+Numpad1');
  });

  it('returns an empty string for an invalid chord', () => {
    expect(formatChord(null)).toBe('');
    expect(formatChord({ code: 'KeyA', ctrl: false, shift: true, alt: false, meta: false })).toBe('');
  });
});
