import { describe, it, expect, vi, afterEach } from 'vitest';
import { createChordTracker, HOLD_MS } from '../../../src/content/hotkey.js';

const CHORD = { code: 'Space', ctrl: true, shift: true, alt: false, meta: false };
const HELD = { ctrlKey: true, shiftKey: true };

function key(code, mods = {}, repeat = false) {
  return { code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods, repeat };
}

function setup({ chord = CHORD, holdMs } = {}) {
  const clock = { t: 1000 };
  const options = { getChord: () => chord, now: () => clock.t };
  if (holdMs !== undefined) options.holdMs = holdMs;
  return { tracker: createChordTracker(options), clock };
}

/** Ctrl, then Shift, then Space, in the order a keyboard delivers them. */
function pressChord(tracker) {
  expect(tracker.keydown(key('ControlLeft', { ctrlKey: true }))).toBeNull();
  expect(tracker.keydown(key('ShiftLeft', HELD))).toBeNull();
  return tracker.keydown(key('Space', HELD));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createChordTracker', () => {
  it('holds for 300 ms by default', () => {
    expect(HOLD_MS).toBe(300);
  });

  it('the first matching keydown is a press', () => {
    const { tracker } = setup();
    expect(tracker.pressed).toBe(false);
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.pressed).toBe(true);
  });

  it('repeat keydowns are not presses', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    for (let i = 0; i < 3; i += 1) {
      clock.t += 30;
      expect(tracker.keydown(key('Space', HELD, true))).toBe('repeat');
    }
    expect(tracker.keydown(key('Space', HELD))).toBe('repeat');
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
    // Auto-repeat that outlives the press never starts a new one.
    expect(tracker.keydown(key('Space', HELD, true))).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('modifier released first ends the press', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 500;
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toEqual({ held: true });
    expect(tracker.pressed).toBe(false);
    expect(tracker.keyup(key('Space', { shiftKey: true }))).toBeNull();
    expect(tracker.keyup(key('ShiftLeft'))).toBeNull();
  });

  it('a right-hand modifier released first also ends the press', () => {
    const { tracker, clock } = setup();
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    clock.t += 100;
    expect(tracker.keyup(key('ShiftRight', { ctrlKey: true }))).toEqual({ held: false });
    expect(tracker.pressed).toBe(false);
  });

  it('swallows the main key auto-repeat after a modifier is released first', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keydown(key('Space', HELD, true))).toBe('repeat');
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toEqual({ held: false });
    expect(tracker.keydown(key('Space', { shiftKey: true }, true))).toBe('repeat');
    expect(tracker.keyup(key('ShiftLeft'))).toBeNull();
    expect(tracker.keydown(key('Space', {}, true))).toBe('repeat');
    expect(tracker.pressed).toBe(false);
  });

  it('stops swallowing once the main key goes up', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keyup(key('ShiftLeft', { ctrlKey: true }))).toEqual({ held: false });
    expect(tracker.keydown(key('Space', { ctrlKey: true }, true))).toBe('repeat');
    expect(tracker.keyup(key('Space', { ctrlKey: true }))).toBeNull();
    expect(tracker.keydown(key('Space', {}, true))).toBeNull();
    expect(tracker.keydown(key('Space'))).toBeNull();
  });

  it('a fresh keydown of the main key ends the swallowing (its keyup was lost)', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toEqual({ held: false });
    expect(tracker.keydown(key('Space', { shiftKey: true }, true))).toBe('repeat');
    expect(tracker.keydown(key('Space'))).toBeNull();
    expect(tracker.keydown(key('Space', {}, true))).toBeNull();
  });

  it('blur ends the swallowing', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toEqual({ held: false });
    expect(tracker.keydown(key('Space', { shiftKey: true }, true))).toBe('repeat');
    expect(tracker.blur()).toBeNull();
    expect(tracker.keydown(key('Space', { shiftKey: true }, true))).toBeNull();
  });

  it('the main key released first ends the press; later modifier keyups are ignored', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 1000;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
    expect(tracker.keyup(key('ShiftLeft', { ctrlKey: true }))).toBeNull();
    expect(tracker.keyup(key('ControlLeft'))).toBeNull();
  });

  it('releasing a modifier the chord does not use keeps the press', () => {
    const { tracker } = setup();
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keyup(key('AltLeft', HELD))).toBeNull();
    expect(tracker.keyup(key('MetaLeft', HELD))).toBeNull();
    expect(tracker.pressed).toBe(true);
  });

  it('blur during hold ends the hold', () => {
    const { tracker, clock } = setup();
    expect(pressChord(tracker)).toBe('press');
    clock.t += 2000;
    expect(tracker.blur()).toEqual({ held: true });
    expect(tracker.pressed).toBe(false);
    // Keys released while the window was unfocused may still arrive later.
    expect(tracker.keyup(key('Space'))).toBeNull();
    expect(tracker.blur()).toBeNull();
  });

  it('tap versus hold at the 300 ms boundary', () => {
    const { tracker, clock } = setup();
    tracker.keydown(key('Space', HELD));
    clock.t += 299;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
    tracker.keydown(key('Space', HELD));
    clock.t += 300;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
    tracker.keydown(key('Space', HELD));
    clock.t += 299;
    expect(tracker.blur()).toEqual({ held: false });
  });

  it('honours a custom holdMs', () => {
    const { tracker, clock } = setup({ holdMs: 500 });
    tracker.keydown(key('Space', HELD));
    clock.t += 400;
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: false });
  });

  it('non-matching keys are ignored', () => {
    const { tracker } = setup();
    expect(tracker.keydown(key('Space', { ctrlKey: true }))).toBeNull();
    expect(tracker.keydown(key('Space', { ...HELD, altKey: true }))).toBeNull();
    expect(tracker.keydown(key('KeyA', HELD))).toBeNull();
    expect(tracker.keydown(key('Space'))).toBeNull();
    expect(tracker.pressed).toBe(false);
    expect(pressChord(tracker)).toBe('press');
    expect(tracker.keydown(key('KeyA', HELD))).toBeNull();
    expect(tracker.pressed).toBe(true);
  });

  it('keyup without a press is ignored', () => {
    const { tracker } = setup();
    expect(tracker.keyup(key('Space', HELD))).toBeNull();
    expect(tracker.keyup(key('ControlLeft', { shiftKey: true }))).toBeNull();
    expect(tracker.blur()).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('reads the current chord on every new press', () => {
    let chord = CHORD;
    const tracker = createChordTracker({ getChord: () => chord, now: () => 0 });
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    tracker.keyup(key('Space', HELD));
    chord = { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false };
    expect(tracker.keydown(key('Space', HELD))).toBeNull();
    expect(tracker.keydown(key('KeyD', { altKey: true }))).toBe('press');
    expect(tracker.keyup(key('AltLeft'))).toEqual({ held: false });
  });

  it('ignores every key while no chord is configured', () => {
    const tracker = createChordTracker({ getChord: () => null, now: () => 0 });
    expect(tracker.keydown(key('Space', HELD))).toBeNull();
    expect(tracker.pressed).toBe(false);
  });

  it('times presses with performance.now by default', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(400);
    const tracker = createChordTracker({ getChord: () => CHORD });
    expect(tracker.keydown(key('Space', HELD))).toBe('press');
    expect(tracker.keyup(key('Space', HELD))).toEqual({ held: true });
  });
});
