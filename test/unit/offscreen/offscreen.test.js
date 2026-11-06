// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MSG } from '../../../src/shared/messages.js';

const WORKER = { id: 'abc' };
const PAGE = { id: 'abc', tab: { id: 1 } };

class FakeAudioContext {
  static created = [];

  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = {};
    this.close = vi.fn(async () => {});
    this.oscillators = [];
    this.filters = [];
    FakeAudioContext.created.push(this);
  }

  resume() { return Promise.resolve(); }

  createOscillator() {
    const osc = {
      frequency: {},
      onended: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(() => { queueMicrotask(() => osc.onended?.()); }),
    };
    this.oscillators.push(osc);
    return osc;
  }

  createBiquadFilter() {
    const filter = { frequency: {}, connect: vi.fn() };
    this.filters.push(filter);
    return filter;
  }

  createGain() {
    const param = { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
    return { gain: param, connect: vi.fn() };
  }
}

/** Fires `copy` as Chrome does, with a fake clipboardData, and reports true. */
function stubExecCommand() {
  const written = [];
  document.execCommand = vi.fn(() => {
    const event = new Event('copy', { cancelable: true });
    event.clipboardData = { setData: (_type, text) => written.push(text) };
    document.dispatchEvent(event);
    return true;
  });
  return written;
}

describe('offscreen listener', () => {
  let listener;
  let written;

  beforeEach(async () => {
    FakeAudioContext.created = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('chrome', {
      runtime: {
        onMessage: { addListener: vi.fn((fn) => { listener = fn; }) },
        sendMessage: vi.fn(async () => {}),
      },
    });
    written = stubExecCommand();
    vi.resetModules();
    await import('../../../src/offscreen/offscreen.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete document.execCommand;
  });

  /** @returns {{ returned: unknown, reply: Promise<unknown> }} */
  function deliver(message, sender) {
    let sendResponse;
    const reply = new Promise((resolve) => { sendResponse = resolve; });
    return { returned: listener(message, sender, sendResponse), reply };
  }

  it('plays a cue for the service worker and replies when it ended', async () => {
    const { returned, reply } = deliver({ action: MSG.OFFSCREEN_CUE, cue: 'done' }, WORKER);
    expect(returned).toBe(true);
    await expect(reply).resolves.toEqual({ ok: true });
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(FakeAudioContext.created[0].close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(FakeAudioContext.created[0].close).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['soft', 440, 0],
    ['warm', 392, 2],
    ['tap', 523, 0],
    ['classic', 660, 0],
  ])('plays the %s set named in the message: its first start note is %i Hz, with %i filters', async (set, freq, filters) => {
    const { reply } = deliver({ action: MSG.OFFSCREEN_CUE, cue: 'start', set }, WORKER);
    await expect(reply).resolves.toEqual({ ok: true });
    const [ctx] = FakeAudioContext.created;
    expect(ctx.oscillators[0].frequency.value).toBe(freq);
    expect(ctx.filters).toHaveLength(filters);
  });

  it.each([[undefined], ['nope'], [7], [null]])('plays Soft for the set %j', async (set) => {
    const { reply } = deliver({ action: MSG.OFFSCREEN_CUE, cue: 'start', set }, WORKER);
    await expect(reply).resolves.toEqual({ ok: true });
    const [ctx] = FakeAudioContext.created;
    expect(ctx.oscillators.map((osc) => osc.frequency.value)).toEqual([440, 587]);
    expect(ctx.filters).toEqual([]);
  });

  it('replies false to an unknown cue, with no context', async () => {
    const { reply } = deliver({ action: MSG.OFFSCREEN_CUE, cue: '__proto__' }, WORKER);
    await expect(reply).resolves.toEqual({ ok: false });
    expect(FakeAudioContext.created).toEqual([]);
  });

  it('copies for the service worker and replies at once', async () => {
    const { returned, reply } = deliver({ action: MSG.OFFSCREEN_COPY, text: 'Καλημέρα' }, WORKER);
    expect(returned).toBe(false);
    await expect(reply).resolves.toEqual({ ok: true });
    expect(written).toEqual(['Καλημέρα']);
  });

  it('replies false when the copy event never ran', async () => {
    document.execCommand = vi.fn(() => true);
    const { reply } = deliver({ action: MSG.OFFSCREEN_COPY, text: 'text' }, WORKER);
    await expect(reply).resolves.toEqual({ ok: false });
  });

  it.each([[undefined], [7], [null], [{ raw: 'x' }]])('replies false to the non-string text %j', async (text) => {
    const { reply } = deliver({ action: MSG.OFFSCREEN_COPY, text }, WORKER);
    await expect(reply).resolves.toEqual({ ok: false });
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('drops a cue from a page: nothing plays', async () => {
    const sendResponse = vi.fn();
    expect(listener({ action: MSG.OFFSCREEN_CUE, cue: 'start' }, PAGE, sendResponse)).toBe(false);
    await Promise.resolve();
    expect(FakeAudioContext.created).toEqual([]);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('drops a copy from a page: nothing is copied', () => {
    const sendResponse = vi.fn();
    expect(listener({ action: MSG.OFFSCREEN_COPY, text: 'text' }, PAGE, sendResponse)).toBe(false);
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
