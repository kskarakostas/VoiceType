import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCapture, AUDIO_CONSTRAINTS, STOP_TIMEOUT_MS } from '../../../src/offscreen/capture.js';
import { RECORDING_MIME, LEVEL_INTERVAL_MS } from '../../../src/offscreen/audio.js';
import { MSG } from '../../../src/shared/messages.js';

const LOUD = Float32Array.from([0.5, -0.5, 0.5, -0.5]); // rms 0.5, level 1
const MID = Float32Array.from([0.0625, -0.0625]); // rms 1/16, level 0.625
const QUIET = new Float32Array(4); // rms 0, level 0
const OPTS = { maxSec: 60, silenceSec: 0 };
const GENERIC = { ok: false, reason: 'micError', error: 'Could not start the microphone.' };

class FakeRecorder {
  constructor(stream, options, log) {
    this.stream = stream;
    this.options = options;
    this.log = log;
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
    this.stopsItself = true;
    this.start = vi.fn(() => { this.state = 'recording'; });
    this.stop = vi.fn(() => {
      this.log.push('recorder.stop');
      this.state = 'inactive';
      if (!this.stopsItself) return;
      // Chrome delivers the last chunk and then the stop event asynchronously.
      queueMicrotask(() => {
        this.emit(Uint8Array.of(4, 5));
        this.onstop?.({ type: 'stop' });
      });
    });
  }
  emit(bytes) { this.ondataavailable?.({ data: new Blob([bytes]) }); }
  fail() { this.onerror?.({ type: 'error' }); }
}

function fakeStream(log) {
  const listeners = new Set();
  const track = {
    stop: vi.fn(() => { log.push('track.stop'); }),
    addEventListener: vi.fn((type, fn) => { if (type === 'ended') listeners.add(fn); }),
    removeEventListener: vi.fn((type, fn) => { if (type === 'ended') listeners.delete(fn); }),
  };
  return {
    track,
    getTracks: () => [track],
    end: () => { for (const fn of [...listeners]) fn({ type: 'ended' }); },
    listenerCount: () => listeners.size,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Fresh capture with fakes; `samples` scripts the analyser (an empty queue reads silence). */
function setup(overrides = {}, { recorderStartThrows = false } = {}) {
  const log = [];
  const stream = fakeStream(log);
  const recorders = [];
  const samples = [];
  const analyser = {
    read: vi.fn(() => samples.shift() ?? QUIET),
    close: vi.fn(async () => { log.push('analyser.close'); }),
  };
  const sent = [];
  const waiters = [];
  const deps = {
    queryPermission: vi.fn(async () => 'granted'),
    getUserMedia: vi.fn(async () => stream),
    createMediaRecorder: vi.fn((s, options) => {
      const recorder = new FakeRecorder(s, options, log);
      if (recorderStartThrows) recorder.start.mockImplementation(() => { throw new Error('start failed'); });
      recorders.push(recorder);
      return recorder;
    }),
    createAnalyser: vi.fn(async () => analyser),
    send: vi.fn((message) => {
      sent.push(message);
      log.push(message.action);
      for (const wake of waiters.splice(0)) wake();
    }),
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    ...overrides,
  };
  const capture = createCapture(deps);
  const of = (action) => sent.filter((m) => m.action === action);
  /** Resolves with the first message of `action`, waiting for it when needed. */
  async function until(action) {
    while (of(action).length === 0) await new Promise((resolve) => waiters.push(resolve));
    return of(action)[0];
  }
  return { capture, deps, stream, analyser, samples, sent, log, of, until, recorder: () => recorders.at(-1) };
}

function domError(name) {
  return new DOMException(`${name} message`, name);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('start failures', () => {
  it('prompt state never calls getUserMedia', async () => {
    const h = setup({ queryPermission: vi.fn(async () => 'prompt') });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();
    expect(h.deps.createMediaRecorder).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it('denied state is denied without calling getUserMedia', async () => {
    const h = setup({ queryPermission: vi.fn(async () => 'denied') });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'denied', error: 'Microphone access is blocked.' });
    expect(h.deps.getUserMedia).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(false);
  });

  it('NotAllowedError from getUserMedia is denied', async () => {
    const h = setup({ getUserMedia: vi.fn(async () => { throw domError('NotAllowedError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'denied', error: 'Microphone access is blocked.' });
    expect(h.capture.active).toBe(false);
  });

  it('NotFoundError is micError with "No microphone found."', async () => {
    const h = setup({ getUserMedia: vi.fn(async () => { throw domError('NotFoundError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'No microphone found.' });
    expect(h.capture.active).toBe(false);
  });

  it('any other failure is micError with the generic text', async () => {
    const busy = setup({ getUserMedia: vi.fn(async () => { throw domError('NotReadableError'); }) });
    await expect(busy.capture.start(OPTS)).resolves.toEqual(GENERIC);
    const query = setup({ queryPermission: vi.fn(async () => { throw new TypeError('bad name'); }) });
    await expect(query.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(query.deps.getUserMedia).not.toHaveBeenCalled();
    expect(busy.capture.active).toBe(false);
    expect(query.capture.active).toBe(false);
  });

  it('tracks stopped on every failure path', async () => {
    // The recorder cannot be created (unsupported mime type).
    let h = setup({ createMediaRecorder: vi.fn(() => { throw domError('NotSupportedError'); }) });
    await expect(h.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);

    // The recorder refuses to start.
    h = setup({}, { recorderStartThrows: true });
    await expect(h.capture.start(OPTS)).resolves.toEqual(GENERIC);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.stream.listenerCount()).toBe(0);
    expect(h.capture.active).toBe(false);

    // Cancelled while getUserMedia was pending.
    const gum = deferred();
    h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const starting = h.capture.start(OPTS);
    await h.capture.stop({ discard: true });
    gum.resolve(h.stream);
    await expect(starting).resolves.toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);

    // The recorder fails while recording.
    h = setup();
    await h.capture.start(OPTS);
    h.recorder().fail();
    await h.until(MSG.OFFSCREEN_ERROR);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('a stop while starting cancels the start and records nothing', async () => {
    const gum = deferred();
    const h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const starting = h.capture.start(OPTS);
    expect(h.capture.active).toBe(true);
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: true });
    gum.resolve(h.stream);
    await expect(starting).resolves.toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(h.deps.createMediaRecorder).not.toHaveBeenCalled();
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
    expect(h.capture.active).toBe(false);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
  });
});

describe('recording', () => {
  it('starts an opus recorder at 32 kbps with a 100 ms timeslice', async () => {
    const h = setup();
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
    expect(AUDIO_CONSTRAINTS).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(h.deps.getUserMedia).toHaveBeenCalledWith(AUDIO_CONSTRAINTS);
    expect(h.deps.createAnalyser).toHaveBeenCalledWith(h.stream);
    expect(h.deps.createMediaRecorder).toHaveBeenCalledWith(h.stream, { mimeType: RECORDING_MIME, audioBitsPerSecond: 32000 });
    expect(h.recorder().start).toHaveBeenCalledWith(100);
    expect(h.stream.listenerCount()).toBe(1);
    expect(h.capture.active).toBe(true);
  });

  it('levels sent every interval', async () => {
    const h = setup();
    h.samples.push(LOUD, MID);
    await h.capture.start(OPTS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([{ action: MSG.OFFSCREEN_LEVEL, level: 1 }]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS);
    expect(h.of(MSG.OFFSCREEN_LEVEL)[1]).toEqual({ action: MSG.OFFSCREEN_LEVEL, level: 0.625 });
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS * 3);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(5);
    expect(h.of(MSG.OFFSCREEN_LEVEL)[4].level).toBe(0);
  });

  it('second start while active', async () => {
    const gum = deferred();
    const h = setup({ getUserMedia: vi.fn(() => gum.promise) });
    const first = h.capture.start(OPTS);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'Already recording.' });
    gum.resolve(h.stream);
    await expect(first).resolves.toEqual({ ok: true });
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: false, reason: 'micError', error: 'Already recording.' });
    expect(h.deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(h.stream.track.stop).not.toHaveBeenCalled();
    expect(h.capture.active).toBe(true);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS * 2);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(2);
  });

  it('records without levels when the analyser cannot be created', async () => {
    const h = setup({ createAnalyser: vi.fn(async () => { throw new Error('no audio context'); }) });
    await expect(h.capture.start({ maxSec: 60, silenceSec: 2 })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toEqual([]);
    expect(h.capture.active).toBe(true);
    await h.capture.stop({ discard: false });
    expect(h.of(MSG.OFFSCREEN_DONE)).toHaveLength(1);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
  });
});

describe('finishing', () => {
  it('user stop sends OFFSCREEN_DONE with base64 and duration', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1500);
    await expect(h.capture.stop({ discard: false })).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([{
      action: MSG.OFFSCREEN_DONE,
      audioBase64: 'AQIDBAU=', // bytes 1 to 5: the chunk above plus the final chunk
      mimeType: 'audio/webm',
      durationSec: 1.5,
      reason: 'user',
    }]);
    expect(h.log.filter((entry) => entry !== MSG.OFFSCREEN_LEVEL))
      .toEqual(['recorder.stop', 'track.stop', 'analyser.close', MSG.OFFSCREEN_DONE]);
    expect(h.stream.listenerCount()).toBe(0);
    expect(h.capture.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const levels = h.of(MSG.OFFSCREEN_LEVEL).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(levels);
    await expect(h.capture.start(OPTS)).resolves.toEqual({ ok: true });
  });

  it('max time finishes with reason maxTime', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 5, silenceSec: 0 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'maxTime', durationSec: 5, mimeType: 'audio/webm' });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('silence detector stops with reason silence only after speech', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 60, silenceSec: 2 });
    await vi.advanceTimersByTimeAsync(3000); // 3 s of silence before any speech
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.capture.active).toBe(true);
    h.samples.push(LOUD);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS); // speech
    await vi.advanceTimersByTimeAsync(1900); // 19 quiet samples
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    await vi.advanceTimersByTimeAsync(LEVEL_INTERVAL_MS); // the 20th quiet sample
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'silence', durationSec: 5.1 });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('silenceSec 0 never auto-stops', async () => {
    const h = setup();
    await h.capture.start({ maxSec: 600, silenceSec: 0 });
    h.samples.push(LOUD);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.capture.active).toBe(true);
  });

  it('track ended finishes with reason ended', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    await vi.advanceTimersByTimeAsync(700);
    h.stream.end();
    const done = await h.until(MSG.OFFSCREEN_DONE);
    expect(done).toMatchObject({ reason: 'ended', durationSec: 0.7 });
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('discard sends nothing', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    await vi.advanceTimersByTimeAsync(1000);
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('recorder error sends OFFSCREEN_ERROR', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    await vi.advanceTimersByTimeAsync(300);
    h.recorder().fail();
    await h.until(MSG.OFFSCREEN_ERROR);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([{ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }]);
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.analyser.close).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const levels = h.of(MSG.OFFSCREEN_LEVEL).length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.of(MSG.OFFSCREEN_LEVEL)).toHaveLength(levels);
  });

  it('a recorder that never fires stop is released after the stop timeout', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().emit(Uint8Array.of(1, 2, 3));
    h.recorder().stopsItself = false;
    await vi.advanceTimersByTimeAsync(2000);
    const stopping = h.capture.stop({ discard: false });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await expect(stopping).resolves.toEqual({ ok: true });
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([{
      action: MSG.OFFSCREEN_DONE, audioBase64: 'AQID', mimeType: 'audio/webm', durationSec: 2, reason: 'user',
    }]);
    expect(h.stream.track.stop).toHaveBeenCalledTimes(1);
    expect(h.capture.active).toBe(false);
  });

  it('a recording without any audio data is an error', async () => {
    const h = setup();
    await h.capture.start(OPTS);
    h.recorder().stopsItself = false;
    const stopping = h.capture.stop({ discard: false });
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    await stopping;
    expect(h.of(MSG.OFFSCREEN_DONE)).toEqual([]);
    expect(h.of(MSG.OFFSCREEN_ERROR)).toEqual([{ action: MSG.OFFSCREEN_ERROR, error: 'Recording failed.' }]);
  });

  it('stop without a recording answers ok false', async () => {
    const h = setup();
    await expect(h.capture.stop({ discard: false })).resolves.toEqual({ ok: false });
    await expect(h.capture.stop({ discard: true })).resolves.toEqual({ ok: false });
    expect(h.sent).toEqual([]);
  });
});
