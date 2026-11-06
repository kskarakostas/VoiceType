import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CUE_SETS, CUE_NAMES, createCuePlayer, cueLengthMs } from '../../../src/offscreen/cues.js';
import { SOUND_SETS } from '../../../src/shared/defaults.js';

/** An AudioParam that also keeps its scheduled events in order, as [method, value, time]. */
function fakeParam() {
  const calls = [];
  const event = (method) => vi.fn((value, time) => { calls.push([method, value, time]); });
  return {
    value: 1,
    calls,
    setValueAtTime: event('setValueAtTime'),
    linearRampToValueAtTime: event('linearRampToValueAtTime'),
    exponentialRampToValueAtTime: event('exponentialRampToValueAtTime'),
  };
}

class FakeContext {
  constructor({ resumes = true, closeError = null, failOn = null, currentTime = 2 } = {}) {
    this.state = 'suspended';
    this.currentTime = currentTime;
    this.destination = { name: 'destination' };
    this.oscillators = [];
    this.gains = [];
    this.filters = [];
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
      start: vi.fn((at) => { osc.startedAt = at; }),
      stop: vi.fn((at) => { osc.stoppedAt = at; }),
    };
    this.oscillators.push(osc);
    return osc;
  }

  createBiquadFilter() {
    const filter = { type: 'lowpass', frequency: fakeParam(), connect: vi.fn() };
    this.filters.push(filter);
    return filter;
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

/** The last note ends: what the browser reports when the cue is over. */
const finish = (ctx) => ctx.oscillators.at(-1).onended();

describe('cues', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('names the four cues', () => {
    expect(CUE_NAMES).toEqual(['start', 'stop', 'done', 'error']);
  });

  it('keeps every Classic cue at or under 250 ms', () => {
    for (const name of CUE_NAMES) {
      expect(CUE_SETS.classic.notes[name].reduce((sum, note) => sum + note.ms, 0)).toBeLessThanOrEqual(250);
    }
  });

  it.each([
    ['start', [660, 880], [70, 90]],
    ['stop', [880, 660], [70, 90]],
    ['done', [880, 1320], [70, 110]],
    ['error', [330, 247], [120, 120]],
  ])('plays the %s notes in order', async (name, freqs, lengths) => {
    const { ctx, player } = setup();
    const playing = player.play(name, 'classic');
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
    const playing = player.play('start', 'classic');
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
    const playing = player.play('start', 'classic');
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
    const playing = player.play('start', 'classic');
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
    player.play('start', 'classic').then(outcome);
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
      const playing = player.play(name, 'classic');
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
    await expect(player.play(name, 'classic')).resolves.toEqual({ ok: false });
    expect(createContext).not.toHaveBeenCalled();
  });

  it('gives up on a context that stays suspended past 1 s', async () => {
    const { ctx, player } = setup({ resumes: false });
    const outcome = vi.fn();
    player.play('start', 'classic').then(outcome);
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
    const playing = player.play('start', 'classic');
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
    player.play('start', 'classic').then(outcome);
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
    await expect(player.play('start', 'classic')).resolves.toEqual({ ok: false });
  });

  it('answers false and closes when resume rejects', async () => {
    const { ctx, player } = setup();
    ctx.resume = vi.fn(() => Promise.reject(new Error('refused')));
    await expect(player.play('start', 'classic')).resolves.toEqual({ ok: false });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['oscillator', 'gain'])('answers false and closes when the %s node throws', async (failOn) => {
    const { ctx, player } = setup({ failOn });
    const playing = player.play('start', 'classic');
    await settle();
    await expect(playing).resolves.toEqual({ ok: false });
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('swallows a close rejection in the timer', async () => {
    const { ctx, player } = setup({ closeError: new Error('already closed') });
    const playing = player.play('start', 'classic');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('swallows a close that throws in the timer', async () => {
    const { ctx, player } = setup();
    ctx.close = vi.fn(() => { throw new Error('already closed'); });
    const playing = player.play('start', 'classic');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  it('swallows a close that throws on a failure path', async () => {
    const { ctx, player } = setup({ resumes: false });
    ctx.close = vi.fn(() => { throw new Error('already closed'); });
    const playing = player.play('start', 'classic');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(playing).resolves.toEqual({ ok: false });
  });

  it('does not wait for a close that never settles', async () => {
    const { ctx, player } = setup();
    ctx.close = vi.fn(() => new Promise(() => {}));
    const playing = player.play('start', 'classic');
    await settle();
    ctx.oscillators[1].onended();
    await expect(playing).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.close).toHaveBeenCalledTimes(1);
  });

  describe('the sound sets (V61, table 5)', () => {
    /** Table 5 of the spec, as [Hz, ms] pairs. */
    const TABLE = {
      soft: { start: [[440, 110], [587, 190]], stop: [[587, 110], [440, 190]], done: [[587, 110], [784, 240]], error: [[294, 160], [247, 240]] },
      warm: { start: [[392, 110], [523, 190]], stop: [[523, 110], [392, 190]], done: [[523, 110], [659, 240]], error: [[262, 160], [220, 240]] },
      tap: { start: [[523, 200]], stop: [[392, 200]], done: [[659, 260]], error: [[247, 280]] },
      classic: { start: [[660, 70], [880, 90]], stop: [[880, 70], [660, 90]], done: [[880, 70], [1320, 110]], error: [[330, 120], [247, 120]] },
    };

    it('has one set per setting, each with the four cues', () => {
      expect(Object.keys(CUE_SETS)).toEqual(SOUND_SETS);
      for (const set of SOUND_SETS) expect(Object.keys(CUE_SETS[set].notes)).toEqual(CUE_NAMES);
    });

    it.each(SOUND_SETS)('%s holds the notes of table 5', (set) => {
      for (const name of CUE_NAMES) {
        expect(CUE_SETS[set].notes[name].map(({ freq, ms }) => [freq, ms])).toEqual(TABLE[set][name]);
      }
    });

    it.each(SOUND_SETS)('%s stays inside the length limits', (set) => {
      expect(cueLengthMs(set, 'start')).toBeLessThanOrEqual(450);
      for (const name of ['stop', 'done', 'error']) expect(cueLengthMs(set, name)).toBeLessThanOrEqual(700);
    });

    it.each(SOUND_SETS)('%s: cueLengthMs is the end of the last oscillator after the start of the first', async (set) => {
      for (const name of CUE_NAMES) {
        const { ctx, player } = setup({ currentTime: 0 });
        const playing = player.play(name, set);
        await settle();
        const ends = ctx.oscillators.map((osc) => osc.stoppedAt);
        expect(ctx.oscillators.at(-1).stoppedAt).toBe(Math.max(...ends));
        expect(cueLengthMs(set, name)).toBeCloseTo((ctx.oscillators.at(-1).stoppedAt - ctx.oscillators[0].startedAt) * 1000, 6);
        finish(ctx); await playing;
      }
    });

    it('Soft overlaps its notes and decays from the peak', async () => {
      const { ctx, player } = setup({ currentTime: 0 });
      const playing = player.play('start', 'soft');
      await settle();
      expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([440, 587]);
      expect(ctx.oscillators[1].startedAt - ctx.oscillators[0].startedAt).toBeCloseTo(0.0935);
      expect(ctx.gains[0].gain.calls).toContainEqual(['exponentialRampToValueAtTime', 0.0008, expect.closeTo(0.165)]);
      finish(ctx); await playing;
    });

    it.each([
      ['soft', 'sine', 0.07, 0.02],
      ['warm', 'triangle', 0.09, 0.015],
      ['tap', 'sine', 0.08, 0.012],
    ])('%s: %s wave, linear attack to %f over %f s, exponential decay, stop at 1.6 times the note', async (set, wave, peak, attack) => {
      const { ctx, player } = setup({ currentTime: 0 });
      const playing = player.play('done', set);
      await settle();
      ctx.oscillators.forEach((osc, i) => {
        const { ms } = CUE_SETS[set].notes.done[i];
        const from = osc.startedAt;
        expect(osc.type).toBe(wave);
        expect(osc.stoppedAt).toBeCloseTo(from + ms * 1.6 / 1000, 9);
        expect(ctx.gains[i].gain.calls).toEqual([
          ['setValueAtTime', 0, from],
          ['linearRampToValueAtTime', peak, expect.closeTo(from + attack, 9)],
          ['exponentialRampToValueAtTime', 0.0008, expect.closeTo(from + ms * 1.5 / 1000, 9)],
        ]);
      });
      finish(ctx); await playing;
    });

    it('a note after the first starts at 85% of the one before it', async () => {
      const { ctx, player } = setup({ currentTime: 0 });
      const playing = player.play('error', 'warm');
      await settle();
      expect(ctx.oscillators.map((o) => o.startedAt)).toEqual([0, expect.closeTo(0.136, 9)]);
      finish(ctx); await playing;
    });

    it('Warm filters through a low-pass at 1200 Hz, between the oscillator and the gain', async () => {
      const { ctx, player } = setup();
      const playing = player.play('start', 'warm');
      await settle();
      expect(ctx.filters).toHaveLength(2);
      expect(ctx.filters[0].type).toBe('lowpass');
      expect(ctx.filters[0].frequency.value).toBe(1200);
      ctx.oscillators.forEach((osc, i) => {
        expect(osc.connect).toHaveBeenCalledTimes(1);
        expect(osc.connect).toHaveBeenCalledWith(ctx.filters[i]);
        expect(ctx.filters[i].connect).toHaveBeenCalledWith(ctx.gains[i]);
        expect(ctx.gains[i].connect).toHaveBeenCalledWith(ctx.destination);
      });
      finish(ctx); await playing;
    });

    it.each(['soft', 'tap', 'classic'])('%s has no filter: the oscillator goes straight to the gain', async (set) => {
      const { ctx, player } = setup();
      const playing = player.play('start', set);
      await settle();
      expect(ctx.filters).toEqual([]);
      ctx.oscillators.forEach((osc, i) => expect(osc.connect).toHaveBeenCalledWith(ctx.gains[i]));
      finish(ctx); await playing;
    });

    it.each([['an unknown set', 'nope'], ['a missing set', undefined], ['null', null], ['__proto__', '__proto__'], ['constructor', 'constructor']])(
      '%s plays Soft',
      async (_label, set) => {
        const { ctx, player } = setup();
        const playing = player.play('start', set);
        await settle();
        expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([440, 587]);
        finish(ctx); await playing;
      },
    );

    it('replies 500 ms after the end of a long cue when onended never fires, and closes 300 ms later', async () => {
      const { ctx, player } = setup();
      const outcome = vi.fn();
      player.play('start', 'tap').then(outcome);
      await settle();
      expect(cueLengthMs('tap', 'start')).toBe(320);
      await vi.advanceTimersByTimeAsync(320 + 499);
      expect(outcome).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toHaveBeenCalledWith({ ok: true });
      await vi.advanceTimersByTimeAsync(299);
      expect(ctx.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it.each(['oscillator', 'gain'])('answers false and closes when the %s node throws in a new set', async (failOn) => {
      const { ctx, player } = setup({ failOn });
      const playing = player.play('start', 'warm');
      await settle();
      await expect(playing).resolves.toEqual({ ok: false });
      expect(ctx.close).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
