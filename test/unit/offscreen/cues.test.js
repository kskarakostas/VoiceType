import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CUES, CUE_NAMES, createCuePlayer } from '../../../src/offscreen/cues.js';

function fakeParam() {
  return { value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() };
}

class FakeContext {
  constructor({ resumes = true, closeError = null, failOn = null, currentTime = 2 } = {}) {
    this.state = 'suspended';
    this.currentTime = currentTime;
    this.destination = { name: 'destination' };
    this.oscillators = [];
    this.gains = [];
    this.log = [];
    this.failOn = failOn;
    this.resume = vi.fn(() => {
      if (!resumes) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    });
    this.close = vi.fn(() => {
      this.log.push('close');
      return closeError ? Promise.reject(closeError) : Promise.resolve();
    });
  }

  createOscillator() {
    if (this.failOn === 'oscillator') throw new Error('no oscillator');
    const osc = {
      frequency: fakeParam(),
      onended: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain() {
    if (this.failOn === 'gain') throw new Error('no gain');
    const gain = { gain: fakeParam(), connect: vi.fn() };
    this.gains.push(gain);
    return gain;
  }
}

function setup(options) {
  const ctx = new FakeContext(options);
  const createContext = vi.fn(() => ctx);
  return { ctx, createContext, player: createCuePlayer({ createContext }) };
}

/** Lets the awaited resume settle and the notes get scheduled. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('cues', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('names the four cues', () => {
    expect(CUE_NAMES).toEqual(['start', 'stop', 'done', 'error']);
  });

  it('keeps every cue at or under 250 ms', () => {
    for (const name of CUE_NAMES) {
      expect(CUES[name].reduce((sum, note) => sum + note.ms, 0)).toBeLessThanOrEqual(250);
    }
  });

  it.each([
    ['start', [660, 880], [70, 90]],
    ['stop', [880, 660], [70, 90]],
    ['done', [880, 1320], [70, 110]],
    ['error', [330, 247], [120, 120]],
  ])('plays the %s notes in order', async (name, freqs, lengths) => {
    const { ctx, player } = setup();
    const playing = player.play(name);
    await settle();
    expect(ctx.oscillators.map((osc) => osc.frequency.value)).toEqual(freqs);
    const [first, second] = ctx.oscillators;
    expect(first.start.mock.calls[0][0]).toBeCloseTo(2, 6);
    expect(first.stop.mock.calls[0][0]).toBeCloseTo(2 + lengths[0] / 1000, 6);
    expect(second.start.mock.calls[0][0]).toBeCloseTo(2 + lengths[0] / 1000, 6);
    expect(second.stop.mock.calls[0][0]).toBeCloseTo(2 + (lengths[0] + lengths[1]) / 1000, 6);
    second.onended();
    await expect(playing).resolves.toEqual({ ok: true });
  });

  it('wires each note to the destination through its own gain', async () => {
    const { ctx, player } = setup();
    const playing = player.play('start');
    await settle();
    expect(ctx.oscillators).toHaveLength(2);
    expect(ctx.gains).toHaveLength(2);
    ctx.oscillators.forEach((osc, i) => {
      expect(osc.connect).toHaveBeenCalledWith(ctx.gains[i]);
      expect(ctx.gains[i].connect).toHaveBeenCalledWith(ctx.destination);
    });
    ctx.oscillators[1].onended();
    await playing;
  });

  it('ramps each note from 0 to the 0.18 peak and back to 0, with no click', async () => {
    const { ctx, player } = setup({ currentTime: 0 });
    const playing = player.play('start');
    await settle();
    const { gain } = ctx.gains[0];
    expect(gain.setValueAtTime.mock.calls[0]).toEqual([0, 0]);
    const [[peak, peakAt], [end, endAt]] = gain.linearRampToValueAtTime.mock.calls;
    expect(peak).toBe(0.18);
    expect(peakAt).toBeCloseTo(0.005, 6);
    expect(end).toBe(0);
    expect(endAt).toBeCloseTo(0.07, 6);
    const levels = [...gain.setValueAtTime.mock.calls, ...gain.linearRampToValueAtTime.mock.calls].map(([value]) => value);
    expect(Math.max(...levels)).toBe(0.18);
    ctx.oscillators[1].onended();
    await playing;
  });

  it('closes the context 300 ms after the last note ended, not at onended', async () => {
    const { ctx, createContext, player } = setup();
    const playing = player.play('start');
    await settle();
    expect(ctx.close).not.toHaveBeenCalled();
    ctx.oscillators[0].onended?.();
    await settle();
    expect(ctx.close).not.toHaveBeenCalled();
    ctx.oscillators[1].onended();
    await settle();
    expect(ctx.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(ctx.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(createContext).toHaveBeenCalledTimes(1);
    await expect(playing).resolves.toEqual({ ok: true });
  });

  it('replies at the end of the cue, before the close', async () => {
    const { ctx, player } = setup();
    const outcome = vi.fn();
    player.play('start').then(outcome);
    await settle();
    expect(outcome).not.toHaveBeenCalled();
    ctx.oscillators[1].onended();
    await settle();
    expect(outcome).toHaveBeenCalledWith({ ok: true });
    expect(ctx.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(outcome.mock.invocationCallOrder[0]).toBeLessThan(ctx.close.mock.invocationCallOrder[0]);
  });

  it('uses a new context for every cue', async () => {
    const contexts = [new FakeContext(), new FakeContext()];
    const createContext = vi.fn(() => contexts.shift());
    const player = createCuePlayer({ createContext });
    for (const name of ['start', 'stop']) {
      const [ctx] = contexts;
      const playing = player.play(name);
      await settle();
      ctx.oscillators[1].onended();
      await playing;
      await vi.advanceTimersByTimeAsync(300);
      expect(ctx.close).toHaveBeenCalledTimes(1);
    }
    expect(createContext).toHaveBeenCalledTimes(2);
  });

  it.each(['__proto__', 'constructor', 'other', '', undefined, null, 7, {}])('refuses the cue name %j with no context', async (name) => {
    const { createContext, player } = setup();
    await expect(player.play(name)).resolves.toEqual({ ok: false });
    expect(createContext).not.toHaveBeenCalled();
  });

  it('gives up on a context that stays suspended past 1 s', async () => {
    const { ctx, player } = setup({ resumes: false });
    const outcome = vi.fn();
    player.play('start').then(outcome);
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).not.toHaveBeenCalled();
    expect(ctx.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledWith({ ok: false });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(ctx.oscillators).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves only the close timer behind at the reply, and none after it', async () => {
    const { ctx, player } = setup();
    const playing = player.play('start');
    await settle();
    ctx.oscillators[1].onended();
    await playing;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('replies 500 ms after the planned end and closes 300 ms later when onended never fires', async () => {
    const { ctx, player } = setup();
    const outcome = vi.fn();
    player.play('start').then(outcome);
    await settle();
    await vi.advanceTimersByTimeAsync(160 + 499);
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toHaveBeenCalledWith({ ok: true });
    await vi.advanceTimersByTimeAsync(299);
    expect(ctx.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('answers false when the context cannot be created', async () => {
    const player = createCuePlayer({ createContext: () => { throw new Error('no audio'); } });
    await expect(player.play('start')).resolves.toEqual({ ok: false });
  });

  it('answers false and closes when resume rejects', async () => {
    const { ctx, player } = setup();
    ctx.resume = vi.fn(() => Promise.reject(new Error('refused')));
    await expect(player.play('start')).resolves.toEqual({ ok: false });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['oscillator', 'gain'])('answers false and closes when the %s node throws', async (failOn) => {
    const { ctx, player } = setup({ failOn });
    const playing = player.play('start');
    await settle();
    await expect(playing).resolves.toEqual({ ok: false });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a close rejection in the timer', async () => {
    const { ctx, player } = setup({ closeError: new Error('already closed') });
    const playing = player.play('start');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('swallows a close that throws in the timer', async () => {
    const { ctx, player } = setup();
    ctx.close = vi.fn(() => { throw new Error('already closed'); });
    const playing = player.play('start');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('swallows a close that throws on a failure path', async () => {
    const { ctx, player } = setup({ resumes: false });
    ctx.close = vi.fn(() => { throw new Error('already closed'); });
    const playing = player.play('start');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(playing).resolves.toEqual({ ok: false });
  });

  it('does not wait for a close that never settles', async () => {
    const { ctx, player } = setup();
    ctx.close = vi.fn(() => new Promise(() => {}));
    const playing = player.play('start');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });
});
