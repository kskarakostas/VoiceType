import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMirror } from '../../../src/content/mirror.js';
import { PROCESSING_TIMEOUT_MS } from '../../../src/content/controller.js';
import { MSG } from '../../../src/shared/messages.js';

const fakePill = () => ({ setStyle: vi.fn(), show: vi.fn(), setState: vi.fn(), setLevel: vi.fn(), destroy: vi.fn() });
const message = (state, elapsedMs = 5000) => ({ action: MSG.RECORDING_MIRROR, state, elapsedMs });

function setup() {
  const pills = [];
  const makePill = vi.fn(() => {
    pills.push(fakePill());
    return pills.at(-1);
  });
  const onChange = vi.fn();
  const mirror = createMirror({ makePill, onChange, setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) });
  return { mirror, makePill, pills, onChange };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mirror', () => {
  it('recording creates one pill in Minimal at no anchor', () => {
    const { mirror, makePill, pills } = setup();
    mirror.update(message('recording'));
    mirror.update(message('recording', 6000));
    expect(makePill).toHaveBeenCalledTimes(1);
    const [pill] = pills;
    expect(pill.setStyle).toHaveBeenCalledTimes(1);
    expect(pill.setStyle).toHaveBeenCalledWith('minimal');
    expect(pill.show).toHaveBeenCalledTimes(1);
    expect(pill.show).toHaveBeenCalledWith(null);
    expect(pill.setState).toHaveBeenNthCalledWith(1, 'recording', { elapsedMs: 5000 });
    const order = [pill.setStyle, pill.show, pill.setState].map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('processing moves the same pill', () => {
    const { mirror, makePill, pills } = setup();
    mirror.update(message('recording'));
    mirror.update(message('processing', 7000));
    expect(makePill).toHaveBeenCalledTimes(1);
    expect(pills[0].setState).toHaveBeenLastCalledWith('processing', { elapsedMs: 7000 });
  });

  it('idle destroys it', () => {
    const { mirror, makePill, pills } = setup();
    mirror.update(message('recording'));
    mirror.update(message('idle'));
    expect(pills[0].destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    mirror.update(message('recording'));
    expect(makePill).toHaveBeenCalledTimes(2);
  });

  it('idle with none does nothing', () => {
    const { mirror, makePill } = setup();
    mirror.update(message('idle'));
    expect(makePill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('level reaches the pill and rearms the timer', () => {
    const { mirror, pills } = setup();
    mirror.update(message('recording'));
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    mirror.level(0.4);
    expect(pills[0].setLevel).toHaveBeenCalledWith(0.4);
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    expect(pills[0].destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pills[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('level with none does nothing', () => {
    const { mirror, makePill } = setup();
    mirror.level(0.4);
    expect(makePill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a level after destroy neither reaches the pill nor rearms the timer', () => {
    const { mirror, makePill, pills } = setup();
    mirror.update(message('recording'));
    mirror.destroy();
    mirror.level(0.4);
    expect(pills[0].setLevel).not.toHaveBeenCalled();
    expect(makePill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires after PROCESSING_TIMEOUT_MS of silence', () => {
    const { mirror, pills } = setup();
    mirror.update(message('recording'));
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    mirror.update(message('processing'));
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    expect(pills[0].destroy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pills[0].destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('destroy clears the timer', () => {
    const { mirror, pills } = setup();
    mirror.update(message('recording'));
    expect(vi.getTimerCount()).toBe(1);
    mirror.destroy();
    expect(pills[0].destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    mirror.destroy();
    expect(pills[0].destroy).toHaveBeenCalledTimes(1);
  });

  describe('onChange', () => {
    const calls = (onChange) => onChange.mock.calls.map(([up]) => up);

    it('says up once for a pill, after it shows', () => {
      const { mirror, pills, onChange } = setup();
      mirror.update(message('recording'));
      mirror.update(message('recording', 6000));
      mirror.update(message('processing'));
      mirror.level(0.4);
      expect(calls(onChange)).toEqual([true]);
      expect(onChange.mock.invocationCallOrder[0]).toBeGreaterThan(pills[0].show.mock.invocationCallOrder[0]);
    });

    it('says down once on idle, after the pill is gone', () => {
      const { mirror, pills, onChange } = setup();
      mirror.update(message('recording'));
      mirror.update(message('idle'));
      mirror.update(message('idle'));
      expect(calls(onChange)).toEqual([true, false]);
      expect(onChange.mock.invocationCallOrder[1]).toBeGreaterThan(pills[0].destroy.mock.invocationCallOrder[0]);
    });

    it('says down once on expiry', () => {
      const { mirror, onChange } = setup();
      mirror.update(message('recording'));
      vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
      expect(calls(onChange)).toEqual([true, false]);
      mirror.destroy();
      expect(calls(onChange)).toEqual([true, false]);
    });

    it('says down once on destroy', () => {
      const { mirror, onChange } = setup();
      mirror.update(message('recording'));
      mirror.destroy();
      mirror.destroy();
      expect(calls(onChange)).toEqual([true, false]);
    });

    it('says nothing with no pill', () => {
      const { mirror, onChange } = setup();
      mirror.update(message('idle'));
      mirror.level(0.4);
      mirror.destroy();
      expect(onChange).not.toHaveBeenCalled();
    });

    it('says up again for the next pill', () => {
      const { mirror, onChange } = setup();
      mirror.update(message('recording'));
      mirror.update(message('idle'));
      mirror.update(message('recording'));
      expect(calls(onChange)).toEqual([true, false, true]);
    });
  });
});
