import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRecorder, COPY_TIMEOUT_MS, PENDING_WRITE_LIMIT_MS, PENDING_WINDOW_MS } from '../../../src/background/recorder.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, EDIT_MODE } from '../../../src/shared/defaults.js';

const A = { tabId: 1, frameId: 0 };
const A_CHILD = { tabId: 1, frameId: 5 };
const B = { tabId: 2, frameId: 0 };

const BUSY = { ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' };
const IN_OTHER_FIELD = { ok: false, reason: 'busy', error: 'VoiceType is recording in another field of this page. Click back into it to stop.' };
const STILL_WORKING = { ok: false, reason: 'busy', error: 'VoiceType is still working on this page. Try again in a moment.' };
const NEEDS_PERMISSION = { ok: false, reason: 'needsPermission', error: 'Allow the microphone in the VoiceType tab that just opened, then try again.' };
const DENIED = { ok: false, reason: 'denied', error: 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.' };
const DICTATION = { success: true, text: 'final', raw: 'raw', cost: 0.001, warning: null };
const RESULT = { ...DICTATION, copied: null };
const CANCELLED = { ok: false, reason: 'micError', error: 'Recording cancelled.' };
const stopOf = (captureId) => ({ action: MSG.OFFSCREEN_STOP, discard: false, captureId });
const discardOf = (captureId) => ({ action: MSG.OFFSCREEN_STOP, discard: true, captureId });
const done = (over = {}) => ({ audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 4.2, reason: 'user', ...over });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The pending store, in memory; a record goes in and out by copy, as in Chrome. */
function fakePending(seed = null) {
  const store = { record: seed };
  return {
    store,
    save: vi.fn(async (record) => { store.record = structuredClone(record); }),
    read: vi.fn(async () => structuredClone(store.record)),
    clear: vi.fn(async () => { store.record = null; }),
  };
}

const BOOT = 'boot-now';
const T0 = 1_000_000;
/** What a worker before this one left for frame A. */
const leftBehind = (over = {}) => ({
  captureId: 'c-old', endpoint: { ...A }, modeKey: 'email', host: 'example.com', incognito: false, sounds: true, alwaysCopy: false,
  audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 4.2, editText: null, bootId: 'boot-old', at: T0 - 5000, attempts: 0, ...over,
});

/**
 * Recorder over fake deps. `startReply` answers OFFSCREEN_START (a value, or a function returning
 * one); `record` is what the pending store holds at the start.
 */
function setup({ startReply = { ok: true }, settings: patch = {}, record = null } = {}) {
  const settings = { ...freshSettings(), activeMode: 'email', autoStopSilenceSec: 3, ...patch };
  if (!patch.keys) settings.keys = { openai: 'sk-test-123456', gemini: '' };
  const deps = {
    ensureOffscreen: vi.fn(async () => {}),
    toOffscreen: vi.fn(async (message) => {
      if (message.action !== MSG.OFFSCREEN_START) return { ok: true };
      return typeof startReply === 'function' ? startReply() : startReply;
    }),
    toTab: vi.fn(async () => true),
    openPermissionPage: vi.fn(async () => {}),
    getSettings: vi.fn(async () => settings),
    dictate: vi.fn(async () => ({ ...DICTATION })),
    pending: fakePending(record),
    bootId: BOOT,
    now: vi.fn(() => T0),
  };
  const recorder = createRecorder(deps);
  const offscreenMessages = () => deps.toOffscreen.mock.calls.map(([message]) => message);
  const tabMessages = () => deps.toTab.mock.calls.map(([endpoint, message]) => ({ endpoint, ...message }));
  /** Capture ids of the offscreen starts so far; id() is the latest. */
  const ids = () => offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_START).map((m) => m.captureId);
  const id = () => ids().at(-1);
  /** Every cue sent so far, in order. */
  const cues = () => offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_CUE).map((m) => m.cue);
  const copies = () => offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_COPY);
  const result = () => tabMessages().find((m) => m.action === MSG.DICTATION_RESULT);
  return { deps, recorder, settings, offscreenMessages, tabMessages, ids, id, cues, copies, result };
}

/** Answer one offscreen action with `reply`; every other message keeps the fake's answer. */
function answer(deps, action, reply) {
  const base = deps.toOffscreen.getMockImplementation();
  deps.toOffscreen.mockImplementation((message) => (message.action === action ? reply() : base(message)));
}

/** One recording from A through a finished dictation, with every fire-and-forget send landed. */
async function dictation(t, over = {}) {
  await t.recorder.start(A);
  await t.recorder.stop(A);
  await t.recorder.onDone(done({ captureId: t.id(), ...over }));
  await flush();
}

describe('the site of a recording', () => {
  /** What one dictation hands to dictate, started with these `start` arguments from `endpoint`. */
  async function inputFor(endpoint, ...args) {
    const t = setup({ settings: { activeMode: 'default', siteRules: { 'top.com': { hidePill: false, mode: 'email' } } } });
    await t.recorder.start(endpoint, ...args);
    await t.recorder.stop(endpoint);
    await t.recorder.onDone(done({ captureId: t.id() }));
    return t.deps.dictate.mock.calls[0][0];
  }

  it('passes the site the router worked out to dictate', async () => {
    expect((await inputFor(A, 'https://top.com/', { host: 'top.com', incognito: false })).host).toBe('top.com');
  });

  it('never works the site out from the top-level URL: a third-party frame stays null', async () => {
    expect((await inputFor(A_CHILD, 'https://top.com/', { host: null, incognito: false })).host).toBeNull();
  });

  it('the site rule still comes from the top-level URL', async () => {
    expect((await inputFor(A_CHILD, 'https://top.com/', { host: null, incognito: false })).modeKey).toBe('email');
  });

  it('passes an incognito tab on to dictate', async () => {
    expect((await inputFor(A, 'https://top.com/', { host: 'top.com', incognito: true })).incognito).toBe(true);
    expect((await inputFor(A, 'https://top.com/', { host: 'top.com', incognito: false })).incognito).toBe(false);
  });

  it('a start with no site info is no site and not incognito', async () => {
    expect(await inputFor(A)).toMatchObject({ host: null, incognito: false });
  });

  it('keeps the host and incognito out of the public session', async () => {
    const { recorder } = setup();
    await recorder.start(A, 'https://example.com/', { host: 'example.com', incognito: true });
    expect(recorder.session).toEqual({ endpoint: A, state: 'recording', modeKey: 'email', minSec: 1 });
  });
});

describe('start', () => {
  it('starts the offscreen capture with the recording limits and records the session', async () => {
    const { deps, recorder } = setup();
    expect(await recorder.start(A)).toEqual({ ok: true });
    expect(deps.ensureOffscreen.mock.invocationCallOrder[0]).toBeLessThan(deps.toOffscreen.mock.invocationCallOrder[0]);
    expect(deps.toOffscreen).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_START, maxSec: 120, silenceSec: 3, captureId: expect.any(String) });
    expect(recorder.session).toEqual({ endpoint: A, state: 'recording', modeKey: 'email', minSec: 1 });
  });

  describe('site mode', () => {
    const rule = (over) => ({ activeMode: 'default', siteRules: { 'a.com': { hidePill: false, mode: 'email', ...over } } });

    it('a site rule\'s mode fixes the session mode', async () => {
      const { recorder } = setup({ settings: rule() });
      await recorder.start(A, 'https://a.com/');
      expect(recorder.session.modeKey).toBe('email');
    });

    it('a hide-only rule leaves the active mode', async () => {
      const { recorder } = setup({ settings: { ...rule({ hidePill: true, mode: null }), activeMode: 'translate' } });
      await recorder.start(A, 'https://a.com/');
      expect(recorder.session.modeKey).toBe('translate');
    });

    it('a stale site mode falls back to the active mode', async () => {
      const { recorder } = setup({ settings: rule({ mode: 'gone' }) });
      await recorder.start(A, 'https://a.com/');
      expect(recorder.session.modeKey).toBe('default');
    });

    it('no URL uses the active mode', async () => {
      const { recorder } = setup({ settings: rule() });
      await recorder.start(A);
      expect(recorder.session.modeKey).toBe('default');
    });

    it('the mode stays fixed when the rule changes during the recording', async () => {
      const { deps, recorder, settings, id } = setup({ settings: rule() });
      await recorder.start(A, 'https://a.com/');
      settings.siteRules = { 'a.com': { hidePill: false, mode: 'default' } };
      settings.activeMode = 'translate';
      await recorder.stop(A);
      await recorder.onDone(done({ captureId: id() }));
      expect(deps.dictate).toHaveBeenCalledWith(expect.objectContaining({ modeKey: 'email' }));
    });
  });

  it('gives every session its own capture id', async () => {
    const { recorder, ids } = setup();
    await recorder.start(A);
    await recorder.cancel(A);
    await recorder.start(B);
    const [first, second] = ids();
    expect(first).toEqual(expect.any(String));
    expect(first).not.toBe('');
    expect(second).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it('busy from another endpoint', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    expect(await recorder.start(B)).toEqual(BUSY);
    expect(await recorder.start(A_CHILD)).toEqual(IN_OTHER_FIELD);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
    expect(recorder.session.endpoint).toEqual(A);
  });

  it('another frame of the tab hears the same while the start is in flight', async () => {
    const reply = deferred();
    const { recorder } = setup({ startReply: () => reply.promise });
    const starting = recorder.start(A_CHILD);
    await vi.waitFor(() => expect(recorder.session.state).toBe('starting'));
    expect(await recorder.start(A)).toEqual(IN_OTHER_FIELD);
    expect(await recorder.start(B)).toEqual(BUSY);
    reply.resolve({ ok: true });
    await starting;
  });

  it('concurrent starts from two tabs: one records, the other is busy', async () => {
    const { deps, recorder } = setup();
    expect(await Promise.all([recorder.start(A), recorder.start(B)])).toEqual([{ ok: true }, BUSY]);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
  });

  it('still working while processing, even for the frame that recorded', async () => {
    const { recorder } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    expect(await recorder.start(A)).toEqual(STILL_WORKING);
    expect(await recorder.start(A_CHILD)).toEqual(STILL_WORKING);
    expect(await recorder.start(B)).toEqual(BUSY);
  });

  it('idempotent start', async () => {
    const { deps, recorder } = setup();
    const [first, second] = await Promise.all([recorder.start(A), recorder.start(A)]);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(await recorder.start(A)).toEqual({ ok: true });
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
  });

  it('noKey when the active provider has only whitespace', async () => {
    const { deps, recorder } = setup({ settings: { keys: { openai: '   ', gemini: 'AQ.gemini-key' } } });
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'noKey', error: 'Add an API key in VoiceType settings.' });
    expect(recorder.session).toBeNull();
    expect(deps.ensureOffscreen).not.toHaveBeenCalled();
    expect(deps.toOffscreen).not.toHaveBeenCalled();
  });

  it('uses the key of the active provider', async () => {
    const { recorder } = setup({ settings: { provider: 'gemini', keys: { openai: '', gemini: 'AQ.gemini-key' } } });
    expect(await recorder.start(A)).toEqual({ ok: true });
  });

  it('needsPermission opens the page once and frees the session', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    expect(await recorder.start(A)).toEqual(NEEDS_PERMISSION);
    expect(deps.openPermissionPage).toHaveBeenCalledTimes(1);
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual(NEEDS_PERMISSION);
    expect(deps.openPermissionPage).toHaveBeenCalledTimes(2);
  });

  it('needsPermission still answers when the page cannot open', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    deps.openPermissionPage.mockRejectedValueOnce(new Error('no tabs'));
    expect(await recorder.start(A)).toEqual(NEEDS_PERMISSION);
    expect(recorder.session).toBeNull();
  });

  it('denied frees the session with the settings hint', async () => {
    const { deps, recorder } = setup({ startReply: { ok: false, reason: 'denied', error: 'Microphone blocked.' } });
    expect(await recorder.start(A)).toEqual(DENIED);
    expect(recorder.session).toBeNull();
    expect(deps.openPermissionPage).not.toHaveBeenCalled();
    expect((await recorder.start(B)).reason).toBe('denied');
  });

  it('micError passes the offscreen text through and frees the session', async () => {
    const { recorder } = setup({ startReply: { ok: false, reason: 'micError', error: 'No microphone found.' } });
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'No microphone found.' });
    expect(recorder.session).toBeNull();
  });

  it('a failed offscreen send or document creation frees the session', async () => {
    const { deps, recorder } = setup();
    deps.toOffscreen.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
    deps.ensureOffscreen.mockRejectedValueOnce(new Error('Invalid reason'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
  });

  it('a failed settings read frees the session', async () => {
    const { deps, recorder } = setup();
    deps.getSettings.mockRejectedValueOnce(new Error('storage down'));
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'Could not start the microphone.' });
    expect(recorder.session).toBeNull();
    expect(await recorder.start(A)).toEqual({ ok: true });
  });

  it('stop while starting stops as soon as the capture is up', async () => {
    const pending = deferred();
    const { recorder, offscreenMessages, id } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(recorder.session.state).toBe('starting');
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(stopOf(id()));
    expect(recorder.session.state).toBe('processing');
  });

  it('cancel while starting ignores the late start response', async () => {
    const replies = [deferred(), deferred()];
    let calls = 0;
    const { deps, recorder, offscreenMessages, ids } = setup({ startReply: () => replies[calls++].promise });
    const startedA = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toEqual([expect.objectContaining({ action: MSG.OFFSCREEN_START }), discardOf(ids()[0])]);
    const startedB = recorder.start(B);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(3));
    replies[1].resolve({ ok: true });
    expect(await startedB).toEqual({ ok: true });
    replies[0].resolve({ ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' });
    expect(await startedA).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(recorder.session).toEqual({ endpoint: B, state: 'recording', modeKey: 'email', minSec: 1 });
    expect(deps.openPermissionPage).not.toHaveBeenCalled();
    expect(offscreenMessages()).toHaveLength(3);
  });

  it('a cancel before the offscreen start is sent skips the start', async () => {
    const pending = deferred();
    const { deps, recorder, offscreenMessages } = setup();
    deps.ensureOffscreen.mockImplementationOnce(() => pending.promise);
    const started = recorder.start(A);
    await vi.waitFor(() => expect(deps.ensureOffscreen).toHaveBeenCalled());
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    pending.resolve();
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages()).toEqual([discardOf(expect.any(String))]);
  });
});

describe('stop and cancel', () => {
  it('stop sends the offscreen stop and moves to processing', async () => {
    const { recorder, offscreenMessages, id } = setup();
    await recorder.start(A);
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(stopOf(id()));
    expect(recorder.session.state).toBe('processing');
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_STOP)).toHaveLength(1);
  });

  it('stop and cancel from anyone but the owner are refused', async () => {
    const { recorder } = setup();
    expect(await recorder.stop(A)).toEqual({ ok: false });
    expect(await recorder.cancel(A)).toEqual({ ok: false });
    await recorder.start(A);
    expect(await recorder.stop(B)).toEqual({ ok: false });
    expect(await recorder.cancel(A_CHILD)).toEqual({ ok: false });
    expect(recorder.session.state).toBe('recording');
  });

  it('cancel discards the capture and frees the session', async () => {
    const { deps, recorder, offscreenMessages, id } = setup();
    await recorder.start(A);
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(offscreenMessages()).toContainEqual(discardOf(id()));
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual({ ok: true });
    expect(deps.dictate).not.toHaveBeenCalled();
  });

  it('cancel swallows an offscreen send failure', async () => {
    const { deps, recorder } = setup();
    await recorder.start(A);
    deps.toOffscreen.mockRejectedValueOnce(new Error('gone'));
    expect(await recorder.cancel(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
  });

  it('a failed offscreen stop frees the session with the error notice', async () => {
    const { deps, recorder, tabMessages } = setup();
    await recorder.start(A);
    deps.toOffscreen.mockRejectedValueOnce(new Error('gone'));
    expect(await recorder.stop(A)).toEqual({ ok: true });
    expect(recorder.session).toBeNull();
    expect(tabMessages()).toEqual([{
      endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    }]);
  });
});

describe('levels', () => {
  it('relays levels to the session frame only while recording', async () => {
    const { deps, recorder, tabMessages, id } = setup();
    recorder.onLevel(0.3, undefined);
    await recorder.start(A_CHILD);
    recorder.onLevel(0.4, id());
    await flush();
    expect(tabMessages()).toEqual([{ endpoint: A_CHILD, action: MSG.AUDIO_LEVEL, level: 0.4 }]);
    await recorder.stop(A_CHILD);
    recorder.onLevel(0.5, id());
    await flush();
    expect(deps.toTab).toHaveBeenCalledTimes(1);
  });

  it('undeliverable level cancels the session', async () => {
    const { deps, recorder, offscreenMessages, id } = setup();
    await recorder.start(A);
    deps.toTab.mockResolvedValueOnce(false);
    recorder.onLevel(0.2, id());
    await vi.waitFor(() => expect(recorder.session).toBeNull());
    await vi.waitFor(() => expect(offscreenMessages()).toContainEqual(discardOf(id())));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });
});

describe('a session in a document', () => {
  const DOCUMENT = { ...A, documentId: 'DOC' };

  it('sends its result to the document that recorded', async () => {
    const t = setup();
    await t.recorder.start(DOCUMENT);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.result().endpoint).toStrictEqual(DOCUMENT);
  });

  it('still belongs to its tab and frame when another document of that frame asks', async () => {
    const t = setup();
    await t.recorder.start(DOCUMENT);
    expect(await t.recorder.cancel({ ...A, documentId: 'NEXT' })).toEqual({ ok: true });
    expect(t.recorder.session).toBeNull();
  });
});

describe('mirror', () => {
  const FRAME = { tabId: 1, frameId: 7 };
  const OTHER_FRAME = { tabId: 1, frameId: 9 };
  const TOP = { tabId: 1, frameId: 0 };
  const IDLE = { endpoint: TOP, action: MSG.RECORDING_MIRROR, state: 'idle', elapsedMs: expect.any(Number) };

  const toTop = (t) => t.tabMessages().filter((m) => m.endpoint.tabId === TOP.tabId && m.endpoint.frameId === TOP.frameId);
  const mirrored = (t) => toTop(t).filter((m) => m.action === MSG.RECORDING_MIRROR);
  const states = (t) => mirrored(t).map((m) => m.state);
  const idles = (t) => mirrored(t).filter((m) => m.state === 'idle');
  /** No receiver in the recording frame; frame 0 still answers. */
  const frameGone = (t) => t.deps.toTab.mockImplementation(async (endpoint) => endpoint.frameId !== FRAME.frameId);

  afterEach(() => {
    vi.useRealTimers();
  });

  async function recording(over) {
    const t = setup(over);
    await t.recorder.start(FRAME);
    return t;
  }

  async function unseen(over) {
    const t = await recording(over);
    t.recorder.onFrameSight(FRAME, false);
    return t;
  }

  it('the mirror goes to frame 0 by frameId', async () => {
    const t = setup();
    await t.recorder.start({ ...FRAME, documentId: 'DOC' });
    t.recorder.onFrameSight(FRAME, false);
    expect(mirrored(t)).toHaveLength(1);
    expect(mirrored(t)[0].endpoint).toStrictEqual(TOP);
  });

  it('onFrameSight(false) sends recording to frame 0', async () => {
    const t = await unseen();
    expect(mirrored(t)).toEqual([{ endpoint: TOP, action: MSG.RECORDING_MIRROR, state: 'recording', elapsedMs: expect.any(Number) }]);
  });

  it('elapsedMs counts from the moment the recording went live', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = await recording();
    vi.setSystemTime(Date.now() + 5000);
    t.recorder.onFrameSight(FRAME, false);
    expect(mirrored(t)[0].elapsedMs).toBe(5000);
  });

  it('ignored from frame 0', async () => {
    const t = setup();
    await t.recorder.start(TOP);
    t.recorder.onFrameSight(TOP, false);
    expect(mirrored(t)).toEqual([]);
  });

  it('ignored from another frame', async () => {
    const t = await recording();
    t.recorder.onFrameSight(OTHER_FRAME, false);
    expect(mirrored(t)).toEqual([]);
  });

  it('ignored with no session', () => {
    const t = setup();
    t.recorder.onFrameSight(FRAME, false);
    expect(t.deps.toTab).not.toHaveBeenCalled();
  });

  it('ignored while starting', async () => {
    const pending = deferred();
    const t = setup({ startReply: () => pending.promise });
    const start = t.recorder.start(FRAME);
    await vi.waitFor(() => expect(t.ids()).toHaveLength(1));
    t.recorder.onFrameSight(FRAME, false);
    expect(mirrored(t)).toEqual([]);
    pending.resolve({ ok: true });
    await start;
    await t.recorder.stop(FRAME);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(mirrored(t)).toEqual([]);
  });

  it('ignored when repeated', async () => {
    const t = await unseen();
    t.recorder.onFrameSight(FRAME, false);
    expect(states(t)).toEqual(['recording']);
    t.recorder.onFrameSight(FRAME, true);
    t.recorder.onFrameSight(FRAME, true);
    expect(states(t)).toEqual(['recording', 'idle']);
  });

  it('seen from the start sends nothing', async () => {
    const t = await recording();
    t.recorder.onFrameSight(FRAME, true);
    expect(mirrored(t)).toEqual([]);
  });

  it('onFrameSight(true) sends idle', async () => {
    const t = await unseen();
    t.recorder.onFrameSight(FRAME, true);
    expect(mirrored(t).at(-1)).toEqual(IDLE);
  });

  it('out of sight during processing mirrors processing', async () => {
    const pending = deferred();
    const t = await recording();
    t.deps.dictate.mockReturnValueOnce(pending.promise);
    await t.recorder.stop(FRAME);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    t.recorder.onFrameSight(FRAME, false);
    expect(states(t)).toEqual(['processing']);
    pending.resolve({ ...DICTATION });
    await finished;
    expect(states(t)).toEqual(['processing', 'idle']);
  });

  it('stop while unseen sends processing', async () => {
    const t = await unseen();
    await t.recorder.stop(FRAME);
    expect(states(t)).toEqual(['recording', 'processing']);
  });

  it('an auto-stop while unseen sends processing', async () => {
    const pending = deferred();
    const t = await unseen();
    t.deps.dictate.mockReturnValueOnce(pending.promise);
    const finished = t.recorder.onDone(done({ reason: 'silence', captureId: t.id() }));
    await flush();
    expect(states(t)).toEqual(['recording', 'processing']);
    pending.resolve({ ...DICTATION });
    await finished;
  });

  it('levels go to frame 0 only while unseen', async () => {
    const t = await recording();
    const levels = () => toTop(t).filter((m) => m.action === MSG.AUDIO_LEVEL);
    t.recorder.onLevel(0.1, t.id());
    expect(levels()).toEqual([]);
    t.recorder.onFrameSight(FRAME, false);
    t.recorder.onLevel(0.2, t.id());
    expect(levels()).toEqual([{ endpoint: TOP, action: MSG.AUDIO_LEVEL, level: 0.2 }]);
    t.recorder.onFrameSight(FRAME, true);
    t.recorder.onLevel(0.3, t.id());
    expect(levels()).toHaveLength(1);
    await flush();
    expect(t.recorder.session.state).toBe('recording');
  });

  it.each([
    ['no receiver', async () => false],
    ['a rejection', async () => { throw new Error('gone'); }],
  ])('a failed delivery to frame 0 never drops the session: %s', async (_name, top) => {
    const t = await unseen();
    t.deps.toTab.mockImplementation(async (endpoint, message) => (endpoint.frameId === TOP.frameId ? top(message) : true));
    t.recorder.onLevel(0.2, t.id());
    t.recorder.onFrameSight(FRAME, true);
    t.recorder.onFrameSight(FRAME, false);
    await flush();
    expect(t.recorder.session.state).toBe('recording');
    await t.recorder.stop(FRAME);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.result()).toEqual({ endpoint: FRAME, action: MSG.DICTATION_RESULT, ...RESULT });
  });

  describe('a mirror message frame 0 was not ready for', () => {
    const topLevels = (t) => toTop(t).filter((m) => m.action === MSG.AUDIO_LEVEL);
    /** Frame 0 has no receiver for its first `lost` mirror messages. */
    function lose(t, lost) {
      let left = lost;
      t.deps.toTab.mockImplementation(async (endpoint, message) => {
        if (endpoint.frameId !== TOP.frameId || message.action !== MSG.RECORDING_MIRROR || left === 0) return true;
        left -= 1;
        return false;
      });
    }

    it('goes again at the next level, once, and then levels flow', async () => {
      const t = await recording();
      lose(t, 1);
      t.recorder.onFrameSight(FRAME, false);
      await flush();
      expect(states(t)).toEqual(['recording']);

      t.recorder.onLevel(0.2, t.id());
      await flush();
      expect(states(t)).toEqual(['recording', 'recording']);
      expect(topLevels(t)).toEqual([]);

      t.recorder.onLevel(0.3, t.id());
      await flush();
      expect(states(t)).toEqual(['recording', 'recording']);
      expect(topLevels(t).map((m) => m.level)).toEqual([0.3]);
    });

    it('keeps going until one lands', async () => {
      const t = await recording();
      lose(t, 3);
      t.recorder.onFrameSight(FRAME, false);
      await flush();
      for (const level of [0.1, 0.2, 0.3, 0.4]) {
        t.recorder.onLevel(level, t.id());
        await flush();
      }
      expect(states(t)).toEqual(['recording', 'recording', 'recording', 'recording']);
      expect(topLevels(t).map((m) => m.level)).toEqual([0.4]);
    });

    it('a delivered one never goes again', async () => {
      const t = await unseen();
      await flush();
      t.recorder.onLevel(0.2, t.id());
      t.recorder.onLevel(0.3, t.id());
      await flush();
      expect(states(t)).toEqual(['recording']);
      expect(topLevels(t).map((m) => m.level)).toEqual([0.2, 0.3]);
    });

    it('carries the time since the recording went live', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const t = await recording();
      lose(t, 1);
      t.recorder.onFrameSight(FRAME, false);
      await flush();
      vi.setSystemTime(Date.now() + 4000);
      t.recorder.onLevel(0.2, t.id());
      expect(mirrored(t).at(-1).elapsedMs).toBe(4000);
    });

    it('does not go again once the indicator is back in sight', async () => {
      const t = await recording();
      lose(t, 1);
      t.recorder.onFrameSight(FRAME, false);
      await flush();
      t.recorder.onFrameSight(FRAME, true);
      await flush();
      t.recorder.onLevel(0.2, t.id());
      await flush();
      expect(states(t)).toEqual(['recording', 'idle']);
    });

    it('free still sends idle', async () => {
      const t = await recording();
      lose(t, 1);
      t.recorder.onFrameSight(FRAME, false);
      await flush();
      await t.recorder.cancel(FRAME);
      expect(states(t)).toEqual(['recording', 'idle']);
    });
  });

  const stopThen = (run) => async (t) => {
    await t.recorder.stop(FRAME);
    await run(t);
  };
  const EXITS = [
    ['result', stopThen((t) => t.recorder.onDone(done({ captureId: t.id() })))],
    ['too short', stopThen((t) => t.recorder.onDone(done({ durationSec: 0.4, captureId: t.id() })))],
    ['dictate threw', stopThen((t) => {
      t.deps.dictate.mockRejectedValueOnce(new Error('bug'));
      return t.recorder.onDone(done({ captureId: t.id() }));
    })],
    ['empty capture', stopThen((t) => t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true, durationSec: 0.05 }))],
    ['failure', (t) => t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id() })],
    ['failure while processing', stopThen((t) => t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id() }))],
    ['finish failed', (t) => {
      answer(t.deps, MSG.OFFSCREEN_STOP, async () => { throw new Error('gone'); });
      return t.recorder.stop(FRAME);
    }],
    ['cancel', (t) => t.recorder.cancel(FRAME)],
    ['cancel while processing', stopThen((t) => t.recorder.cancel(FRAME))],
    ['frame gone', async (t) => {
      frameGone(t);
      t.recorder.onLevel(0.2, t.id());
      await flush();
    }],
    ['frame gone at auto-stop', (t) => {
      frameGone(t);
      return t.recorder.onDone(done({ reason: 'silence', captureId: t.id() }));
    }],
    ['auto-stop into a result', (t) => t.recorder.onDone(done({ reason: 'maxTime', captureId: t.id() }))],
    ['tab closed', (t) => {
      t.deps.toTab.mockResolvedValue(false);
      return t.recorder.onTabRemoved(TOP.tabId);
    }],
    ['tab closed while processing, at the result', stopThen(async (t) => {
      t.deps.toTab.mockResolvedValue(false);
      await t.recorder.onTabRemoved(TOP.tabId);
      await t.recorder.onDone(done({ captureId: t.id() }));
    })],
  ];

  it.each(EXITS)('one idle to frame 0 at exit: %s', async (_name, exit) => {
    const t = await unseen();
    await exit(t);
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(idles(t)).toEqual([IDLE]);
    expect(mirrored(t).at(-1)).toEqual(IDLE);
  });

  it.each(EXITS)('no mirror, no message at exit: %s', async (_name, exit) => {
    const t = await recording();
    await exit(t);
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(toTop(t)).toEqual([]);
  });

  it('a frame seen again before the exit sends no second idle', async () => {
    const t = await unseen();
    t.recorder.onFrameSight(FRAME, true);
    await t.recorder.cancel(FRAME);
    await flush();
    expect(idles(t)).toEqual([IDLE]);
  });

  it('a cancel during the dictation sends one idle, not another at the result', async () => {
    const pending = deferred();
    const t = await unseen();
    t.deps.dictate.mockReturnValueOnce(pending.promise);
    await t.recorder.stop(FRAME);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await t.recorder.cancel(FRAME);
    expect(idles(t)).toEqual([IDLE]);
    pending.resolve({ ...DICTATION });
    await finished;
    await flush();
    expect(idles(t)).toEqual([IDLE]);
  });

  it('a late result of a mirrored session leaves the next session alone', async () => {
    const pending = deferred();
    const t = await unseen();
    t.deps.dictate.mockReturnValueOnce(pending.promise);
    await t.recorder.stop(FRAME);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await t.recorder.cancel(FRAME);
    await t.recorder.start(FRAME);
    t.recorder.onFrameSight(FRAME, false);
    pending.resolve({ ...DICTATION });
    await finished;
    await flush();
    expect(t.recorder.session.state).toBe('recording');
    expect(states(t)).toEqual(['recording', 'processing', 'idle', 'recording']);
  });

  it('a second session mirrors again', async () => {
    const t = await unseen();
    await t.recorder.cancel(FRAME);
    await t.recorder.start(FRAME);
    t.recorder.onFrameSight(FRAME, false);
    await t.recorder.cancel(FRAME);
    expect(states(t)).toEqual(['recording', 'idle', 'recording', 'idle']);
  });
});

describe('results', () => {
  it('delivers the dictation to the session frame after freeing the session', async () => {
    const { deps, recorder, tabMessages, id } = setup();
    await recorder.start(A_CHILD);
    await recorder.stop(A_CHILD);
    let sessionAtDelivery = 'unset';
    deps.toTab.mockImplementation(async () => { sessionAtDelivery = recorder.session; return true; });
    await recorder.onDone(done({ captureId: id() }));
    expect(deps.dictate).toHaveBeenCalledWith({ audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 4.2, host: null, incognito: false, editText: null, resumed: false });
    expect(tabMessages()).toEqual([{ endpoint: A_CHILD, action: MSG.DICTATION_RESULT, ...RESULT }]);
    expect(sessionAtDelivery).toBeNull();
    expect(recorder.session).toBeNull();
  });

  it('too-short without a provider call', async () => {
    const { deps, recorder, tabMessages, id } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    await recorder.onDone(done({ durationSec: 0.4, captureId: id() }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(tabMessages()).toEqual([{ endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' }]);
    expect(recorder.session).toBeNull();
  });

  for (const reason of ['maxTime', 'silence', 'ended']) {
    it(`auto-stop reason ${reason} sends RECORDING_STATE processing before the result`, async () => {
      const { deps, recorder, tabMessages, id } = setup();
      await recorder.start(A);
      await recorder.onDone(done({ reason, captureId: id() }));
      expect(tabMessages()).toEqual([
        { endpoint: A, action: MSG.RECORDING_STATE, state: 'processing', reason },
        { endpoint: A, action: MSG.DICTATION_RESULT, ...RESULT },
      ]);
      expect(deps.toTab.mock.invocationCallOrder[0]).toBeLessThan(deps.dictate.mock.invocationCallOrder[0]);
      expect(recorder.session).toBeNull();
    });
  }

  it('an undeliverable auto-stop notice drops the audio without a provider call', async () => {
    const { deps, recorder, id } = setup();
    await recorder.start(A);
    deps.toTab.mockResolvedValueOnce(false);
    await recorder.onDone(done({ reason: 'silence', captureId: id() }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(recorder.session).toBeNull();
  });

  it('ignores a result without a session', async () => {
    const { deps, recorder } = setup();
    await recorder.onDone(done());
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(deps.toTab).not.toHaveBeenCalled();
  });

  it('a throwing dictate still frees the session and reports an error', async () => {
    const { deps, recorder, tabMessages, id } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    deps.dictate.mockRejectedValueOnce(new Error('bug'));
    await recorder.onDone(done({ captureId: id() }));
    expect(tabMessages()).toEqual([{ endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Something went wrong. Try again.', tone: 'error' }]);
    expect(recorder.session).toBeNull();
  });

  it('offscreen error frees the session and tells the frame', async () => {
    const { recorder, tabMessages, id } = setup();
    await recorder.onOffscreenError({ error: 'Recording failed.' });
    expect(tabMessages()).toEqual([]);
    await recorder.start(A);
    await recorder.onOffscreenError({ error: 'Recording failed.', captureId: id() });
    expect(tabMessages()).toEqual([{
      endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    }]);
    expect(recorder.session).toBeNull();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });
});

describe('stale captures', () => {
  it('reports from a cancelled capture while the next session starts are ignored', async () => {
    const pendingB = deferred();
    let calls = 0;
    const { deps, recorder, tabMessages, ids } = setup({ startReply: () => (calls++ === 0 ? { ok: true } : pendingB.promise) });
    await recorder.start(A);
    await recorder.cancel(A);
    const startedB = recorder.start(B);
    await vi.waitFor(() => expect(ids()).toHaveLength(2));
    const [idA] = ids();
    await recorder.onDone(done({ reason: 'silence', audioBase64: 'U1RBTEU=', captureId: idA }));
    await recorder.onOffscreenError({ error: 'Recording failed.', captureId: idA });
    recorder.onLevel(0.5, idA);
    await flush();
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(tabMessages()).toEqual([]);
    expect(recorder.session.state).toBe('starting');
    pendingB.resolve({ ok: true });
    expect(await startedB).toEqual({ ok: true });
    expect(recorder.session).toEqual({ endpoint: B, state: 'recording', modeKey: 'email', minSec: 1 });
  });

  it('a result from a cancelled capture while the next session records is ignored', async () => {
    const { deps, recorder, tabMessages, offscreenMessages, ids } = setup();
    await recorder.start(A);
    await recorder.cancel(A);
    await recorder.start(B);
    const [idA, idB] = ids();
    await recorder.onDone(done({ audioBase64: 'U1RBTEU=', captureId: idA }));
    await recorder.onDone(done({ audioBase64: 'U1RBTEU=' }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(tabMessages()).toEqual([]);
    expect(recorder.session.state).toBe('recording');
    await recorder.stop(B);
    expect(offscreenMessages()).toContainEqual(stopOf(idB));
    await recorder.onDone(done({ captureId: idB }));
    expect(deps.dictate).toHaveBeenCalledTimes(1);
    expect(deps.dictate).toHaveBeenCalledWith(expect.objectContaining({ audioBase64: 'QUJD' }));
    expect(tabMessages()).toEqual([{ endpoint: B, action: MSG.DICTATION_RESULT, ...RESULT }]);
  });

  it('an error or level with a stale or missing id is ignored', async () => {
    const { recorder, tabMessages, ids } = setup();
    await recorder.start(A);
    await recorder.cancel(A);
    await recorder.start(B);
    const [idA, idB] = ids();
    recorder.onLevel(0.7, idA);
    recorder.onLevel(0.7, undefined);
    await recorder.onOffscreenError({ error: 'Recording failed.', captureId: idA });
    await recorder.onOffscreenError({ error: 'Recording failed.' });
    await flush();
    expect(tabMessages()).toEqual([]);
    expect(recorder.session.state).toBe('recording');
    recorder.onLevel(0.3, idB);
    await flush();
    expect(tabMessages()).toEqual([{ endpoint: B, action: MSG.AUDIO_LEVEL, level: 0.3 }]);
  });

  it('an error from the capture that is still starting frees the session and tells its frame', async () => {
    const pending = deferred();
    const { recorder, tabMessages, offscreenMessages, id } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    await recorder.onOffscreenError({ error: 'Recording failed.', captureId: id() });
    expect(recorder.session).toBeNull();
    expect(tabMessages()).toEqual([{
      endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    }]);
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages().at(-1)).toEqual(discardOf(id()));
  });

  it('an auto-stop from the capture that is still starting ends the session without a provider call', async () => {
    const pending = deferred();
    const { deps, recorder, tabMessages, offscreenMessages, id } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    await recorder.onDone(done({ reason: 'ended', durationSec: 0.2, captureId: id() }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(recorder.session).toBeNull();
    expect(tabMessages()).toEqual([
      { endpoint: A, action: MSG.RECORDING_STATE, state: 'processing', reason: 'ended' },
      { endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' },
    ]);
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages().at(-1)).toEqual(discardOf(id()));
  });

  it('an ok start reply for a session replaced meanwhile discards only that capture', async () => {
    const replies = [deferred(), deferred()];
    let calls = 0;
    const { recorder, offscreenMessages, ids } = setup({ startReply: () => replies[calls++].promise });
    const startedA = recorder.start(A);
    await vi.waitFor(() => expect(ids()).toHaveLength(1));
    await recorder.cancel(A);
    const startedB = recorder.start(B);
    await vi.waitFor(() => expect(ids()).toHaveLength(2));
    const [idA] = ids();
    replies[0].resolve({ ok: true });
    expect(await startedA).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_STOP)).toEqual([discardOf(idA), discardOf(idA)]);
    replies[1].resolve({ ok: true });
    expect(await startedB).toEqual({ ok: true });
    expect(recorder.session).toEqual({ endpoint: B, state: 'recording', modeKey: 'email', minSec: 1 });
  });
});

describe('permission and tabs', () => {
  it('permission result delivery', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([]);
    await recorder.start(A_CHILD);
    await recorder.onPermissionResult({ granted: true });
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([{
      endpoint: A_CHILD, action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone allowed. Try again.', tone: 'success' },
    }]);
  });

  it('a refused permission tells the frame', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.start(B);
    await recorder.onPermissionResult({ granted: false });
    expect(tabMessages()).toEqual([{
      endpoint: B, action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone not allowed.', tone: 'error' },
    }]);
  });

  it('tab removed while recording frees the session', async () => {
    const { deps, recorder, offscreenMessages, id } = setup();
    await recorder.start(A);
    await recorder.onTabRemoved(2);
    expect(recorder.session.state).toBe('recording');
    await recorder.onTabRemoved(1);
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toContainEqual(discardOf(id()));
    await recorder.onDone(done({ captureId: id() }));
    expect(deps.dictate).not.toHaveBeenCalled();
    expect(await recorder.start(B)).toEqual({ ok: true });
  });

  it('tab removed while starting stops the capture, again when it comes up late', async () => {
    const pending = deferred();
    const { recorder, offscreenMessages, id } = setup({ startReply: () => pending.promise });
    const started = recorder.start(A);
    await vi.waitFor(() => expect(offscreenMessages()).toHaveLength(1));
    await recorder.onTabRemoved(1);
    expect(recorder.session).toBeNull();
    expect(offscreenMessages()).toEqual([expect.objectContaining({ action: MSG.OFFSCREEN_START }), discardOf(id())]);
    pending.resolve({ ok: true });
    expect(await started).toEqual({ ok: false, reason: 'micError', error: 'Recording cancelled.' });
    expect(offscreenMessages()).toEqual([expect.objectContaining({ action: MSG.OFFSCREEN_START }), discardOf(id()), discardOf(id())]);
    expect(recorder.session).toBeNull();
  });

  it('tab removed while processing lets the dictation finish', async () => {
    const { deps, recorder, id } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    await recorder.onTabRemoved(1);
    expect(recorder.session.state).toBe('processing');
    await recorder.onDone(done({ captureId: id() }));
    expect(deps.dictate).toHaveBeenCalledTimes(1);
  });

  it('tab removed clears a pending permission for that tab', async () => {
    const { recorder, tabMessages } = setup({ startReply: { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' } });
    await recorder.start(A);
    await recorder.onTabRemoved(1);
    await recorder.onPermissionResult({ granted: true });
    expect(tabMessages()).toEqual([]);
  });
});

describe('cues', () => {
  const SOUNDS = { settings: { sounds: true } };
  const FAILED_STATE = {
    endpoint: A, action: MSG.RECORDING_STATE, state: 'idle', reason: 'error', notice: { text: 'Recording failed. Try again.', tone: 'error' },
  };
  const NEEDS = { ok: false, reason: 'needsPermission', error: 'Microphone permission needed.' };

  it('cue row 1: another frame, or processing: busy', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    expect(await t.recorder.start(B)).toEqual(BUSY);
    expect(await t.recorder.start(A_CHILD)).toEqual(IN_OTHER_FIELD);
    await t.recorder.stop(A);
    expect(await t.recorder.start(A)).toEqual(STILL_WORKING);
    expect(await t.recorder.start(A_CHILD)).toEqual(STILL_WORKING);
    await flush();
    expect(t.cues()).toEqual(['start']);
  });

  it('cue row 2: same frame asks again', async () => {
    const t = setup(SOUNDS);
    await Promise.all([t.recorder.start(A), t.recorder.start(A)]);
    expect(await t.recorder.start(A)).toEqual({ ok: true });
    await flush();
    expect(t.cues()).toEqual(['start']);
  });

  it('cue row 3: getSettings failed', async () => {
    const t = setup(SOUNDS);
    t.deps.getSettings.mockRejectedValueOnce(new Error('storage down'));
    await t.recorder.start(A);
    await flush();
    expect(t.cues()).toEqual([]);
  });

  it('cue row 4: freed while reading settings', async () => {
    const t = setup(SOUNDS);
    const pending = deferred();
    t.deps.getSettings.mockImplementationOnce(() => pending.promise);
    const started = t.recorder.start(A);
    await t.recorder.cancel(A);
    pending.resolve(t.settings);
    expect(await started).toEqual(CANCELLED);
    await flush();
    expect(t.cues()).toEqual([]);
  });

  it('cue row 5: no key', async () => {
    const t = setup({ settings: { sounds: true, keys: { openai: '', gemini: '' } } });
    expect((await t.recorder.start(A)).reason).toBe('noKey');
    await flush();
    expect(t.cues()).toEqual([]);
    expect(t.deps.ensureOffscreen).not.toHaveBeenCalled();
  });

  it('cue row 6: ensureOffscreen or OFFSCREEN_START threw', async () => {
    const created = setup(SOUNDS);
    created.deps.ensureOffscreen.mockRejectedValueOnce(new Error('Invalid reason'));
    expect((await created.recorder.start(A)).reason).toBe('micError');
    await flush();
    expect(created.cues()).toEqual(['error']);

    const sent = setup({ ...SOUNDS, startReply: () => { throw new Error('gone'); } });
    expect((await sent.recorder.start(A)).reason).toBe('micError');
    await flush();
    expect(sent.cues()).toEqual(['error']);
  });

  it('cue row 7: freed while starting', async () => {
    for (const reply of [{ ok: true }, NEEDS, { ...CANCELLED, cancelled: true }]) {
      const pending = deferred();
      const t = setup({ ...SOUNDS, startReply: () => pending.promise });
      const started = t.recorder.start(A);
      await vi.waitFor(() => expect(t.ids()).toHaveLength(1));
      await t.recorder.cancel(A);
      pending.resolve(reply);
      expect(await started).toStrictEqual(CANCELLED);
      await flush();
      expect(t.cues()).toEqual([]);
    }
  });

  it('cue row 8: capture live, no stop queued', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await flush();
    expect(t.cues()).toEqual(['start']);
  });

  it('cue row 9: capture live, stop already queued', async () => {
    const pending = deferred();
    const t = setup({ ...SOUNDS, startReply: () => pending.promise });
    const started = t.recorder.start(A);
    await vi.waitFor(() => expect(t.ids()).toHaveLength(1));
    await t.recorder.stop(A);
    pending.resolve({ ok: true });
    await started;
    await flush();
    expect(t.cues()).toEqual([]);
    await t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    expect(t.cues()).toEqual(['stop', 'done']);
  });

  it('cue row 10: needsPermission', async () => {
    const t = setup({ ...SOUNDS, startReply: NEEDS });
    expect(await t.recorder.start(A)).toEqual(NEEDS_PERMISSION);
    await flush();
    expect(t.cues()).toEqual([]);
  });

  it('cue row 11: denied', async () => {
    const t = setup({ ...SOUNDS, startReply: { ok: false, reason: 'denied', error: 'Microphone blocked.' } });
    expect(await t.recorder.start(A)).toEqual(DENIED);
    await flush();
    expect(t.cues()).toEqual(['error']);
  });

  it('cue row 12: micError from the capture', async () => {
    const t = setup({ ...SOUNDS, startReply: { ok: false, reason: 'micError', error: 'No microphone found.' } });
    expect(await t.recorder.start(A)).toEqual({ ok: false, reason: 'micError', error: 'No microphone found.' });
    await flush();
    expect(t.cues()).toEqual(['error']);
  });

  it('cue row 13: micError with cancelled: true from the capture', async () => {
    const t = setup({ ...SOUNDS, startReply: { ...CANCELLED, cancelled: true } });
    expect(await t.recorder.start(A)).toStrictEqual(CANCELLED);
    await flush();
    expect(t.cues()).toEqual([]);
  });

  it('cue row 14: CANCEL_RECORDING', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.cancel(A);
    await flush();
    expect(t.cues()).toEqual(['start']);
  });

  it('cue row 15: no receiver on a level, or the tab closed', async () => {
    const level = setup(SOUNDS);
    await level.recorder.start(A);
    level.deps.toTab.mockResolvedValueOnce(false);
    level.recorder.onLevel(0.2, level.id());
    await vi.waitFor(() => expect(level.recorder.session).toBeNull());
    await flush();
    expect(level.cues()).toEqual(['start']);

    const closed = setup(SOUNDS);
    await closed.recorder.start(A);
    await closed.recorder.onTabRemoved(A.tabId);
    await flush();
    expect(closed.recorder.session).toBeNull();
    expect(closed.cues()).toEqual(['start']);
  });

  it('cue row 16: too short', async () => {
    const t = setup(SOUNDS);
    await dictation(t, { durationSec: 0.4 });
    expect(t.result().error).toBe('Too short, ignored');
    expect(t.cues()).toEqual(['start']);
  });

  it('cue row 17: processing starts (user stop, max time, silence, track ended)', async () => {
    for (const reason of ['user', 'maxTime', 'silence', 'ended']) {
      const t = setup(SOUNDS);
      const pending = deferred();
      t.deps.dictate.mockImplementationOnce(() => pending.promise);
      await t.recorder.start(A);
      if (reason === 'user') await t.recorder.stop(A);
      const finished = t.recorder.onDone(done({ reason, captureId: t.id() }));
      await vi.waitFor(() => expect(t.deps.dictate).toHaveBeenCalled());
      await flush();
      expect(t.cues()).toEqual(['start', 'stop']);
      pending.resolve({ ...DICTATION });
      await finished;
    }
  });

  it('cue row 18: auto-stop with no receiver, or freed meanwhile', async () => {
    const gone = setup(SOUNDS);
    await gone.recorder.start(A);
    gone.deps.toTab.mockResolvedValueOnce(false);
    await gone.recorder.onDone(done({ reason: 'silence', captureId: gone.id() }));
    await flush();
    expect(gone.deps.dictate).not.toHaveBeenCalled();
    expect(gone.cues()).toEqual(['start']);

    const freed = setup(SOUNDS);
    const pending = deferred();
    await freed.recorder.start(A);
    freed.deps.toTab.mockImplementationOnce(() => pending.promise);
    const finished = freed.recorder.onDone(done({ reason: 'silence', captureId: freed.id() }));
    await freed.recorder.cancel(A);
    pending.resolve(true);
    await finished;
    await flush();
    expect(freed.deps.dictate).not.toHaveBeenCalled();
    expect(freed.cues()).toEqual(['start']);
  });

  it('cue row 19: dictate succeeded', async () => {
    const t = setup(SOUNDS);
    await dictation(t);
    expect(t.cues()).toEqual(['start', 'stop', 'done']);
    const delivery = t.deps.toTab.mock.invocationCallOrder.at(-1);
    expect(t.deps.ensureOffscreen.mock.invocationCallOrder.at(-1)).toBeLessThan(delivery);
  });

  it('cue row 20: dictate failed or threw, "No speech detected." included', async () => {
    const failed = setup(SOUNDS);
    failed.deps.dictate.mockResolvedValueOnce({ success: false, error: 'No speech detected.', tone: 'error' });
    await dictation(failed);
    expect(failed.result()).toMatchObject({ success: false, error: 'No speech detected.' });
    expect(failed.cues()).toEqual(['start', 'stop', 'error']);

    const threw = setup(SOUNDS);
    threw.deps.dictate.mockRejectedValueOnce(new Error('bug'));
    await dictation(threw);
    expect(threw.result().success).toBe(false);
    expect(threw.cues()).toEqual(['start', 'stop', 'error']);
  });

  it('cue row 21: freed while dictate ran', async () => {
    for (const [outcome, copied] of [[{ ...DICTATION }, null], [{ success: false, error: 'No speech detected.', tone: 'error' }, undefined]]) {
      const t = setup({ settings: { sounds: true, alwaysCopy: true } });
      const pending = deferred();
      t.deps.dictate.mockImplementationOnce(() => pending.promise);
      await t.recorder.start(A);
      await t.recorder.stop(A);
      const finished = t.recorder.onDone(done({ captureId: t.id() }));
      await vi.waitFor(() => expect(t.deps.dictate).toHaveBeenCalled());
      await t.recorder.cancel(A);
      pending.resolve(outcome);
      await finished;
      await flush();
      expect(t.cues()).toEqual(['start', 'stop']);
      expect(t.copies()).toEqual([]);
      expect(t.result().copied).toBe(copied);
    }
  });

  it('cue row 22: the offscreen stop failed', async () => {
    const t = setup(SOUNDS);
    answer(t.deps, MSG.OFFSCREEN_STOP, async () => { throw new Error('gone'); });
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(t.cues()).toEqual(['start', 'error']);
  });

  it('cue row 23: OFFSCREEN_ERROR', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id() });
    await flush();
    expect(t.cues()).toEqual(['start', 'error']);
  });

  it('cue row 23: an empty capture at or past the minimum', async () => {
    for (const durationSec of [1, 2.5]) {
      const t = setup(SOUNDS);
      await t.recorder.start(A);
      await t.recorder.stop(A);
      await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true, durationSec });
      await flush();
      expect(t.recorder.session).toBeNull();
      expect(t.cues()).toEqual(['start', 'error']);
      expect(t.tabMessages()).toEqual([FAILED_STATE]);
    }
  });

  it('cue row 23: an empty report with no usable duration', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true });
    await flush();
    expect(t.cues()).toEqual(['start', 'error']);
    expect(t.tabMessages()).toEqual([FAILED_STATE]);
  });

  it('cue row 23: an empty capture the user did not stop', async () => {
    // The frame still records, so it would drop a DICTATION_RESULT and keep showing a recording.
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true, durationSec: 0.05 });
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(t.cues()).toEqual(['start', 'error']);
    expect(t.tabMessages()).toEqual([FAILED_STATE]);
  });

  it('cue row 25: empty capture under the minimum', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true, durationSec: 0.05 });
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(t.cues()).toEqual(['start']);
    expect(t.tabMessages()).toEqual([{ endpoint: A, action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' }]);
    expect(t.deps.dictate).not.toHaveBeenCalled();
    expect(await t.recorder.start(A)).toEqual({ ok: true });
  });

  it('cue row 24: permission result', async () => {
    const t = setup({ ...SOUNDS, startReply: NEEDS });
    await t.recorder.start(A);
    await t.recorder.onPermissionResult({ granted: true });
    await t.recorder.start(A);
    await t.recorder.onPermissionResult({ granted: false });
    await flush();
    expect(t.cues()).toEqual([]);
  });

  it('sounds off: no cue message on any path', async () => {
    const t = setup();
    await dictation(t);
    t.deps.dictate.mockRejectedValueOnce(new Error('bug'));
    await dictation(t);
    await dictation(t, { durationSec: 0.4 });
    await t.recorder.start(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id() });
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await t.recorder.onOffscreenError({ error: 'Recording failed.', captureId: t.id(), empty: true, durationSec: 0.05 });
    await flush();
    expect(t.ids()).toHaveLength(5);
    expect(t.tabMessages()).toHaveLength(5);
    expect(t.tabMessages().at(-1).error).toBe('Too short, ignored');
    expect(t.cues()).toEqual([]);
  });

  it('each cue fires once', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    expect(t.cues()).toEqual(['start', 'stop', 'done']);
  });

  it('a cue never delays a start', async () => {
    const t = setup(SOUNDS);
    answer(t.deps, MSG.OFFSCREEN_CUE, () => new Promise(() => {}));
    expect(await t.recorder.start(A)).toEqual({ ok: true });
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.result()).toMatchObject({ success: true, text: 'final' });
  });

  it('a rejected cue is swallowed', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const t = setup(SOUNDS);
      answer(t.deps, MSG.OFFSCREEN_CUE, async () => { throw new Error('no document'); });
      await dictation(t);
      expect(t.cues()).toEqual(['start', 'stop', 'done']);
      expect(t.result()).toMatchObject({ success: true });
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a cue reopens the document', async () => {
    const t = setup(SOUNDS);
    await t.recorder.start(A);
    await flush();
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    const ensures = t.deps.ensureOffscreen.mock.invocationCallOrder.map((order) => ({ order, step: 'ensure' }));
    const sends = t.offscreenMessages().map((m, i) => ({ order: t.deps.toOffscreen.mock.invocationCallOrder[i], step: m.action }));
    const steps = [...ensures, ...sends].sort((a, b) => a.order - b.order).map((entry) => entry.step);
    expect(steps).toEqual([
      'ensure', MSG.OFFSCREEN_START,
      'ensure', MSG.OFFSCREEN_CUE,
      MSG.OFFSCREEN_STOP,
      'ensure', MSG.OFFSCREEN_CUE,
      'ensure', MSG.OFFSCREEN_CUE,
    ]);
  });

  it('settings are fixed at start', async () => {
    const on = setup({ settings: { sounds: true, alwaysCopy: true } });
    await on.recorder.start(A);
    Object.assign(on.settings, { sounds: false, alwaysCopy: false });
    await on.recorder.stop(A);
    await on.recorder.onDone(done({ captureId: on.id() }));
    await flush();
    expect(on.cues()).toEqual(['start', 'stop', 'done']);
    expect(on.result().copied).toBe(true);

    const off = setup();
    await off.recorder.start(A);
    Object.assign(off.settings, { sounds: true, alwaysCopy: true });
    await off.recorder.stop(A);
    await off.recorder.onDone(done({ captureId: off.id() }));
    await flush();
    expect(off.cues()).toEqual([]);
    expect(off.copies()).toEqual([]);
    expect(off.result().copied).toBeNull();
  });

  it('the public session never shows the cue or copy settings', async () => {
    const t = setup({ settings: { sounds: true, alwaysCopy: true } });
    await t.recorder.start(A);
    expect(t.recorder.session).toStrictEqual({ endpoint: A, state: 'recording', modeKey: 'email', minSec: 1 });
  });
});

describe('a result with no receiver', () => {
  /** A dictation whose result finds no frame. */
  async function undelivered(over) {
    const t = setup(over);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.toTab.mockResolvedValue(false);
    await t.recorder.onDone(done({ captureId: t.id() }));
    return t;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is copied, once, with always-copy off', async () => {
    const t = await undelivered();
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
    expect(t.result()).toMatchObject({ success: true, copied: null });
    expect(t.recorder.session).toBeNull();
  });

  it('is copied only after delivery failed', async () => {
    const t = await undelivered();
    const copyAt = t.offscreenMessages().findIndex((m) => m.action === MSG.OFFSCREEN_COPY);
    const deliveryAt = t.deps.toTab.mock.calls.findIndex(([, m]) => m.action === MSG.DICTATION_RESULT);
    expect(t.deps.toTab.mock.invocationCallOrder[deliveryAt]).toBeLessThan(t.deps.toOffscreen.mock.invocationCallOrder[copyAt]);
  });

  it('a receiver gets it and nothing is copied', async () => {
    const t = setup();
    await dictation(t);
    expect(t.copies()).toEqual([]);
  });

  it('always-copy already copied it: no second copy', async () => {
    const t = await undelivered({ settings: { alwaysCopy: true } });
    expect(t.copies()).toHaveLength(1);
  });

  it('an always-copy that failed is tried again', async () => {
    const t = setup({ settings: { alwaysCopy: true } });
    answer(t.deps, MSG.OFFSCREEN_COPY, async () => (t.copies().length === 1 ? { ok: false } : { ok: true }));
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.toTab.mockResolvedValue(false);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.copies()).toHaveLength(2);
  });

  it('a failed result copies nothing', async () => {
    const t = setup();
    t.deps.dictate.mockResolvedValueOnce({ success: false, error: 'No speech detected.', tone: 'warning' });
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.toTab.mockResolvedValue(false);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.copies()).toEqual([]);
  });

  it('a too-short clip copies nothing', async () => {
    const t = setup();
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.toTab.mockResolvedValue(false);
    await t.recorder.onDone(done({ durationSec: 0.1, captureId: t.id() }));
    expect(t.copies()).toEqual([]);
  });

  it('a stuck copy gives up after COPY_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    const t = setup();
    answer(t.deps, MSG.OFFSCREEN_COPY, () => new Promise(() => {}));
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.toTab.mockResolvedValue(false);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await vi.advanceTimersByTimeAsync(COPY_TIMEOUT_MS);
    await finished;
    expect(t.copies()).toHaveLength(1);
  });

  it('a tab closed during processing gets its copy with always-copy off', async () => {
    const t = setup();
    const pending = deferred();
    t.deps.dictate.mockImplementationOnce(() => pending.promise);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await vi.waitFor(() => expect(t.deps.dictate).toHaveBeenCalled());
    await t.recorder.onTabRemoved(A.tabId);
    t.deps.toTab.mockResolvedValue(false);
    pending.resolve({ ...DICTATION });
    await finished;
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
  });
});

describe('always-copy', () => {
  const COPY = { settings: { alwaysCopy: true } };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('both off: no copy, copied is null', async () => {
    const t = setup();
    await dictation(t);
    expect(t.offscreenMessages().map((m) => m.action)).toEqual([MSG.OFFSCREEN_START, MSG.OFFSCREEN_STOP]);
    expect(t.deps.ensureOffscreen).toHaveBeenCalledTimes(1);
    expect(t.result()).toMatchObject({ success: true, copied: null });
  });

  it('the copy goes first', async () => {
    const t = setup(COPY);
    await dictation(t);
    const sendAt = t.offscreenMessages().findIndex((m) => m.action === MSG.OFFSCREEN_COPY);
    const deliveryAt = t.deps.toTab.mock.calls.findIndex(([, m]) => m.action === MSG.DICTATION_RESULT);
    expect(t.offscreenMessages()[sendAt]).toEqual({ action: MSG.OFFSCREEN_COPY, text: 'final' });
    expect(t.deps.toOffscreen.mock.invocationCallOrder[sendAt]).toBeLessThan(t.deps.toTab.mock.invocationCallOrder[deliveryAt]);
    expect(t.result()).toMatchObject({ success: true, copied: true });
  });

  it('a refused copy', async () => {
    for (const reply of [{ ok: false }, undefined]) {
      const t = setup(COPY);
      answer(t.deps, MSG.OFFSCREEN_COPY, async () => reply);
      await dictation(t);
      expect(t.result()).toMatchObject({ success: true, text: 'final', copied: false });
    }
  });

  it('a thrown copy', async () => {
    const t = setup(COPY);
    answer(t.deps, MSG.OFFSCREEN_COPY, async () => { throw new Error('no document'); });
    await dictation(t);
    expect(t.result()).toMatchObject({ success: true, copied: false });
  });

  it('a copy with no document', async () => {
    const t = setup(COPY);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.deps.ensureOffscreen.mockRejectedValueOnce(new Error('Invalid reason'));
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.copies()).toEqual([]);
    expect(t.result()).toMatchObject({ success: true, copied: false });
  });

  it('a stuck copy waits 1 s, then delivers', async () => {
    vi.useFakeTimers();
    const t = setup(COPY);
    answer(t.deps, MSG.OFFSCREEN_COPY, () => new Promise(() => {}));
    await t.recorder.start(A);
    await t.recorder.stop(A);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await vi.advanceTimersByTimeAsync(COPY_TIMEOUT_MS - 1);
    expect(t.copies()).toHaveLength(1);
    expect(t.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await finished;
    expect(t.result()).toMatchObject({ success: true, copied: false });
    expect(COPY_TIMEOUT_MS).toBe(1000);
  });

  it('a finished copy leaves no timer behind', async () => {
    vi.useFakeTimers();
    const t = setup(COPY);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.result().copied).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a closed tab still gets its copy', async () => {
    const t = setup({ settings: { sounds: true, alwaysCopy: true } });
    const pending = deferred();
    t.deps.dictate.mockImplementationOnce(() => pending.promise);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await vi.waitFor(() => expect(t.deps.dictate).toHaveBeenCalled());
    await t.recorder.onTabRemoved(A.tabId);
    t.deps.toTab.mockResolvedValue(false);
    pending.resolve({ ...DICTATION });
    await finished;
    await flush();
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
    expect(t.cues()).toEqual(['start', 'stop', 'done']);
    expect(t.recorder.session).toBeNull();
  });

  it('the session stays busy during the copy', async () => {
    const t = setup(COPY);
    const pending = deferred();
    answer(t.deps, MSG.OFFSCREEN_COPY, () => pending.promise);
    await t.recorder.start(A);
    await t.recorder.stop(A);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await vi.waitFor(() => expect(t.copies()).toHaveLength(1));
    expect(await t.recorder.start(B)).toEqual(BUSY);
    expect(t.recorder.session.state).toBe('processing');
    pending.resolve({ ok: true });
    await finished;
    expect(t.recorder.session).toBeNull();
    expect(t.result().copied).toBe(true);
  });

  it('no copy on failure or too short', async () => {
    const t = setup(COPY);
    t.deps.dictate.mockResolvedValueOnce({ success: false, error: 'No speech detected.', tone: 'error' });
    await dictation(t);
    t.deps.dictate.mockRejectedValueOnce(new Error('bug'));
    await dictation(t);
    await dictation(t, { durationSec: 0.4 });
    expect(t.copies()).toEqual([]);
    const results = t.tabMessages().filter((m) => m.action === MSG.DICTATION_RESULT);
    expect(results).toHaveLength(3);
    for (const message of results) expect(message).not.toHaveProperty('copied');
  });
});

describe('an edit', () => {
  const SELECTED = 'the selected words';
  const TOP = 'https://a.com/page';
  const startEdit = (t, endpoint = A) => t.recorder.start(endpoint, TOP, { host: 'a.com', incognito: false, editText: SELECTED });
  const FAILED = { success: false, error: 'Could not edit the selection. Click here to copy what you said.', tone: 'error', edit: true, instruction: 'raw' };

  it("the session's mode is EDIT_MODE with no rule read", async () => {
    const t = setup({ settings: { activeMode: 'email' } });
    const read = vi.fn(() => ({ 'a.com': { hidePill: false, mode: 'email' } }));
    Object.defineProperty(t.settings, 'siteRules', { get: read });
    expect(await startEdit(t)).toEqual({ ok: true });
    expect(t.recorder.session.modeKey).toBe(EDIT_MODE);
    expect(read).not.toHaveBeenCalled();
  });

  it('hands the text to dictate under EDIT_MODE', async () => {
    const t = setup();
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.deps.dictate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ modeKey: EDIT_MODE, editText: SELECTED, host: 'a.com' }));
  });

  it('a later dictation carries no text from it', async () => {
    const t = setup();
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    await dictation(t);
    expect(t.deps.dictate.mock.calls[1][0]).toMatchObject({ modeKey: 'email', editText: null });
  });

  it('the public session never shows the text', async () => {
    const t = setup();
    await startEdit(t);
    expect(t.recorder.session).toEqual({ endpoint: A, state: 'recording', modeKey: EDIT_MODE, minSec: 1 });
  });

  it('cancel drops the text unsent', async () => {
    const t = setup();
    await startEdit(t);
    await t.recorder.cancel(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.recorder.session).toBeNull();
    expect(t.deps.dictate).not.toHaveBeenCalled();
  });

  it('a closed tab drops the text unsent, even with the audio on its way', async () => {
    const t = setup();
    await startEdit(t);
    await t.recorder.stop(A);
    expect(t.recorder.session.state).toBe('processing');
    await t.recorder.onTabRemoved(A.tabId);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.recorder.session).toBeNull();
    expect(t.deps.dictate).not.toHaveBeenCalled();
  });

  it('a tab closed during the provider call still leaves the replacement on the clipboard', async () => {
    const t = setup();
    const call = deferred();
    t.deps.dictate.mockReturnValueOnce(call.promise);
    t.deps.toTab.mockResolvedValue(false);
    await startEdit(t);
    await t.recorder.stop(A);
    const finished = t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    await t.recorder.onTabRemoved(A.tabId);
    call.resolve({ ...DICTATION, edit: true });
    await finished;
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
  });

  it('a too-short edit makes no provider call', async () => {
    const t = setup();
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id(), durationSec: 0.2 }));
    expect(t.deps.dictate).not.toHaveBeenCalled();
    expect(t.result()).toMatchObject({ success: false, error: 'Too short, ignored', tone: 'warning' });
  });

  it('always-copy copies the replacement', async () => {
    const t = setup({ settings: { alwaysCopy: true } });
    t.deps.dictate.mockResolvedValueOnce({ ...DICTATION, edit: true });
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
    expect(t.result()).toMatchObject({ success: true, text: 'final', edit: true, copied: true });
  });

  it('a failed edit reaches its frame with the instruction, and nothing is copied', async () => {
    const t = setup({ settings: { alwaysCopy: true, sounds: true } });
    t.deps.dictate.mockResolvedValueOnce(FAILED);
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    expect(t.result()).toMatchObject(FAILED);
    expect(t.copies()).toEqual([]);
    expect(t.cues()).toContain('error');
  });

  it('a failed edit with no frame left copies nothing: the instruction is not the result', async () => {
    const t = setup();
    t.deps.dictate.mockResolvedValueOnce(FAILED);
    t.deps.toTab.mockResolvedValue(false);
    await startEdit(t);
    await t.recorder.stop(A);
    await t.recorder.onDone(done({ captureId: t.id() }));
    expect(t.copies()).toEqual([]);
  });
});

describe('a repeated start in the same frame', () => {
  const SELECTED = 'the selected text';
  const STILL = { ok: false, reason: 'busy', error: 'VoiceType is still working on this page. Try again in a moment.' };

  it('of the same kind joins the recording', async () => {
    const t = setup();
    await t.recorder.start(A, undefined, { editText: SELECTED });
    expect(await t.recorder.start(A, undefined, { editText: SELECTED })).toEqual({ ok: true });
  });

  it('an edit never joins a dictation (V44)', async () => {
    const t = setup();
    await t.recorder.start(A);
    expect(await t.recorder.start(A, undefined, { editText: SELECTED })).toEqual(STILL);
    expect(t.recorder.session.state).toBe('recording');
  });

  it('a dictation never joins an edit, nor an edit another selection', async () => {
    const t = setup();
    await t.recorder.start(A, undefined, { editText: SELECTED });
    expect(await t.recorder.start(A)).toEqual(STILL);
    expect(await t.recorder.start(A, undefined, { editText: 'other text' })).toEqual(STILL);
  });

  it('neither joins a start still in flight', async () => {
    const opening = deferred();
    const t = setup({ startReply: () => opening.promise });
    const first = t.recorder.start(A);
    expect(await t.recorder.start(A, undefined, { editText: SELECTED })).toEqual(STILL);
    opening.resolve({ ok: true });
    expect(await first).toEqual({ ok: true });
  });
});

describe('held audio (V51)', () => {
  const finished = (t, over = {}) => t.recorder.onDone(done({ captureId: t.id(), ...over }));
  async function recorded(t, ...args) {
    await t.recorder.start(A, ...args);
    await t.recorder.stop(A);
  }

  afterEach(() => vi.useRealTimers());

  it('onDone saves the record before the provider call', async () => {
    const t = setup({ settings: { sounds: true, alwaysCopy: true } });
    t.deps.dictate.mockImplementation(async () => {
      expect(t.deps.pending.store.record).not.toBeNull();
      return { ...DICTATION };
    });
    const endpoint = { ...A, documentId: 'doc-1' };
    await t.recorder.start(endpoint, undefined, { host: 'example.com', incognito: true, editText: 'old words' });
    await t.recorder.stop(endpoint);
    await finished(t);
    expect(t.deps.pending.save).toHaveBeenCalledTimes(1);
    expect(t.deps.pending.save).toHaveBeenCalledWith({
      captureId: t.id(), endpoint, modeKey: EDIT_MODE, host: 'example.com', incognito: true, sounds: true, alwaysCopy: true,
      audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 4.2, editText: 'old words', bootId: BOOT, at: T0, attempts: 0,
    });
    expect(t.deps.pending.save.mock.invocationCallOrder[0]).toBeLessThan(t.deps.dictate.mock.invocationCallOrder[0]);
  });

  it('a hung or failing save lets the dictation run after 500 ms', async () => {
    expect(PENDING_WRITE_LIMIT_MS).toBe(500);
    vi.useFakeTimers();
    const hung = setup();
    hung.deps.pending.save.mockImplementation(() => new Promise(() => {}));
    await recorded(hung);
    const running = finished(hung);
    await vi.advanceTimersByTimeAsync(PENDING_WRITE_LIMIT_MS - 1);
    expect(hung.deps.dictate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(hung.deps.dictate).toHaveBeenCalledTimes(1);
    expect(hung.result()).toEqual({ endpoint: A, action: MSG.DICTATION_RESULT, ...RESULT });

    const failing = setup();
    failing.deps.pending.save.mockRejectedValue(new Error('Session storage quota bytes exceeded.'));
    await recorded(failing);
    const warn = vi.spyOn(console, 'warn');
    await finished(failing);
    expect(failing.deps.dictate).toHaveBeenCalledTimes(1);
    expect(failing.result()).toEqual({ endpoint: A, action: MSG.DICTATION_RESULT, ...RESULT });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a too-short recording saves nothing', async () => {
    const t = setup({ settings: { minRecordingTime: 2 } });
    await recorded(t);
    await finished(t, { durationSec: 1 });
    expect(t.deps.pending.save).not.toHaveBeenCalled();
    expect(t.deps.dictate).not.toHaveBeenCalled();
  });

  it('the record is cleared after delivery, not before', async () => {
    const t = setup();
    let heldAtDelivery;
    t.deps.toTab.mockImplementation(async (_, message) => {
      if (message.action === MSG.DICTATION_RESULT) heldAtDelivery = t.deps.pending.store.record !== null;
      return true;
    });
    await recorded(t);
    await finished(t);
    await flush();
    expect(heldAtDelivery).toBe(true);
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('the record is cleared after the clipboard fallback', async () => {
    const t = setup();
    t.deps.toTab.mockImplementation(async (_, message) => message.action !== MSG.DICTATION_RESULT);
    await recorded(t);
    let heldAtCopy;
    answer(t.deps, MSG.OFFSCREEN_COPY, () => {
      heldAtCopy = t.deps.pending.store.record !== null;
      return { ok: true };
    });
    await finished(t);
    await flush();
    expect(heldAtCopy).toBe(true);
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('the record is cleared after a failure', async () => {
    const t = setup();
    t.deps.dictate.mockResolvedValue({ success: false, error: 'Network error.', tone: 'error' });
    await recorded(t);
    await finished(t);
    await flush();
    expect(t.deps.pending.store.record).toBeNull();

    const threw = setup();
    threw.deps.dictate.mockRejectedValue(new Error('boom'));
    await recorded(threw);
    await finished(threw);
    await flush();
    expect(threw.deps.pending.store.record).toBeNull();
  });

  it('the record is cleared when the send to the tab throws', async () => {
    const t = setup();
    t.deps.toTab.mockImplementation(async (_, message) => {
      if (message.action === MSG.DICTATION_RESULT) throw new Error('gone');
      return true;
    });
    await recorded(t);
    await expect(finished(t)).rejects.toThrow('gone');
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('a run that ends after a new session started leaves that session alone', async () => {
    const t = setup();
    const landing = deferred();
    t.deps.toTab.mockImplementation(async (endpoint, message) => {
      if (message.action === MSG.DICTATION_RESULT && endpoint.tabId === A.tabId) await landing.promise;
      return true;
    });
    await recorded(t);
    const first = finished(t);
    await flush();
    await t.recorder.start(B);
    await t.recorder.stop(B);
    const second = deferred();
    t.deps.dictate.mockReturnValue(second.promise);
    const running = finished(t, { audioBase64: 'TkVX' });
    await flush();
    landing.resolve(true);
    await first;
    await flush();
    expect(t.deps.pending.store.record).toMatchObject({ audioBase64: 'TkVX' });
    second.resolve({ ...DICTATION });
    await running;
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('cancel clears the record, and a cancel during the write calls no provider', async () => {
    const t = setup();
    const write = deferred();
    t.deps.pending.save.mockImplementation(async (record) => { await write.promise; t.deps.pending.store.record = record; });
    await recorded(t);
    const running = finished(t);
    await flush();
    await t.recorder.cancel(A);
    write.resolve();
    await running;
    await flush();
    expect(t.deps.dictate).not.toHaveBeenCalled();
    // The start's clear, then the cancel's.
    expect(t.deps.pending.clear).toHaveBeenCalledTimes(2);
  });

  it('cancel clears a record whose run is in flight', async () => {
    const t = setup();
    const provider = deferred();
    t.deps.dictate.mockReturnValue(provider.promise);
    await recorded(t);
    const running = finished(t);
    await flush();
    expect(t.deps.pending.store.record).not.toBeNull();
    await t.recorder.cancel(A);
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
    provider.resolve({ ...DICTATION });
    await running;
  });

  it('the tab of an edit closing clears the record (V44)', async () => {
    const t = setup();
    const provider = deferred();
    t.deps.dictate.mockReturnValue(provider.promise);
    await recorded(t, undefined, { editText: 'old words' });
    const running = finished(t);
    await flush();
    await t.recorder.onTabRemoved(A.tabId);
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
    provider.resolve({ ...DICTATION });
    await running;
  });

  it('the tab of a dictation closing keeps the record until its run ends', async () => {
    const t = setup();
    const provider = deferred();
    t.deps.dictate.mockReturnValue(provider.promise);
    await recorded(t);
    const running = finished(t);
    await flush();
    await t.recorder.onTabRemoved(A.tabId);
    await flush();
    expect(t.deps.pending.store.record).not.toBeNull();
    provider.resolve({ ...DICTATION });
    await running;
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
  });
});

describe('ping (V52)', () => {
  const documentA = { ...A, documentId: 'doc-1' };
  const run = (t) => t.deps.dictate.mock.calls;

  it('alive with the session', async () => {
    const t = setup();
    await t.recorder.start(A);
    await t.recorder.stop(A);
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    expect(t.deps.pending.read).not.toHaveBeenCalled();
  });

  it("alive with this worker's record after free", async () => {
    const t = setup();
    const landing = deferred();
    t.deps.toTab.mockImplementation((_, message) => (message.action === MSG.DICTATION_RESULT ? landing.promise : Promise.resolve(true)));
    await t.recorder.start(A);
    await t.recorder.stop(A);
    const running = t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    expect(run(t)).toHaveLength(1);
    landing.resolve(true);
    await running;
  });

  it("with another worker's fresh record resumes once, writes attempts 1 first, and runs dictate with resumed true", async () => {
    const t = setup({ record: leftBehind() });
    t.deps.dictate.mockImplementation(async () => {
      expect(t.deps.pending.store.record).toMatchObject({ attempts: 1, bootId: BOOT });
      return { ...DICTATION };
    });
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    await flush();
    expect(t.deps.pending.save).toHaveBeenCalledWith(leftBehind({ attempts: 1, bootId: BOOT }));
    expect(run(t)).toHaveLength(1);
    expect(run(t)[0][0]).toEqual({
      audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 4.2, host: 'example.com', incognito: false, editText: null, resumed: true,
    });
    expect(t.result()).toEqual({ endpoint: A, action: MSG.DICTATION_RESULT, ...RESULT });
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('a resumed session plays no stop cue, and the last cue as any run', async () => {
    const t = setup({ record: leftBehind() });
    await t.recorder.ping(A);
    await flush();
    expect(t.cues()).toEqual(['done']);
  });

  it('does not wait for the resumed run', async () => {
    const t = setup({ record: leftBehind() });
    t.deps.dictate.mockReturnValue(new Promise(() => {}));
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    expect(t.recorder.session).toEqual({ endpoint: A, state: 'processing', modeKey: 'email', minSec: 0 });
  });

  it('a second ping during that run does not start a third', async () => {
    const t = setup({ record: leftBehind() });
    const provider = deferred();
    t.deps.dictate.mockReturnValue(provider.promise);
    await t.recorder.ping(A);
    await flush();
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    await flush();
    expect(run(t)).toHaveLength(1);
    expect(t.deps.pending.save).toHaveBeenCalledTimes(1);
    provider.resolve({ ...DICTATION });
    await flush();
  });

  it('two pings at once start one run', async () => {
    const t = setup({ record: leftBehind() });
    const replies = await Promise.all([t.recorder.ping(A), t.recorder.ping(A)]);
    await flush();
    expect(replies).toEqual([{ alive: true }, { alive: true }]);
    expect(run(t)).toHaveLength(1);
  });

  it('a ping after the resumed session freed still finds the record its own', async () => {
    const t = setup({ record: leftBehind() });
    const landing = deferred();
    t.deps.toTab.mockImplementation((_, message) => (message.action === MSG.DICTATION_RESULT ? landing.promise : Promise.resolve(true)));
    await t.recorder.ping(A);
    await flush();
    expect(t.recorder.session).toBeNull();
    expect(await t.recorder.ping(A)).toEqual({ alive: true });
    expect(run(t)).toHaveLength(1);
    landing.resolve(true);
    await flush();
  });

  it('a start while attempts 1 is being written is busy, so no second session', async () => {
    const write = deferred();
    const t = setup({ record: leftBehind() });
    t.deps.pending.save.mockImplementation(async (record) => { await write.promise; t.deps.pending.store.record = record; });
    const ping = t.recorder.ping(A);
    await flush();
    expect(await t.recorder.start(B)).toEqual(BUSY);
    write.resolve();
    expect(await ping).toEqual({ alive: true });
    await flush();
    expect(run(t)).toHaveLength(1);
  });

  it('attempts 1 not written runs nothing: a third call must stay impossible', async () => {
    const t = setup({ record: leftBehind() });
    t.deps.pending.save.mockRejectedValue(new Error('quota'));
    expect(await t.recorder.ping(A)).toEqual({ alive: false });
    await flush();
    expect(run(t)).toHaveLength(0);
    expect(t.recorder.session).toBeNull();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('with attempts 1 clears and is not alive', async () => {
    const t = setup({ record: leftBehind({ attempts: 1 }) });
    expect(await t.recorder.ping(A)).toEqual({ alive: false });
    expect(t.deps.pending.store.record).toBeNull();
    expect(run(t)).toHaveLength(0);
  });

  it('past the window clears and is not alive', async () => {
    expect(PENDING_WINDOW_MS).toBe(120_000);
    const fresh = setup({ record: leftBehind({ at: T0 - PENDING_WINDOW_MS + 1 }) });
    expect(await fresh.recorder.ping(A)).toEqual({ alive: true });
    await flush();

    const t = setup({ record: leftBehind({ at: T0 - PENDING_WINDOW_MS }) });
    expect(await t.recorder.ping(A)).toEqual({ alive: false });
    expect(t.deps.pending.store.record).toBeNull();
    expect(run(t)).toHaveLength(0);
  });

  it('for another endpoint leaves the record and is not alive', async () => {
    const t = setup({ record: leftBehind() });
    expect(await t.recorder.ping(B)).toEqual({ alive: false });
    expect(await t.recorder.ping(A_CHILD)).toEqual({ alive: false });
    expect(t.deps.pending.store.record).toEqual(leftBehind());
    expect(run(t)).toHaveLength(0);
  });

  it('from another document of the frame leaves the record and is not alive', async () => {
    const t = setup({ record: leftBehind({ endpoint: documentA }) });
    expect(await t.recorder.ping({ ...A, documentId: 'doc-2' })).toEqual({ alive: false });
    expect(t.deps.pending.store.record).not.toBeNull();
    expect(await t.recorder.ping(documentA)).toEqual({ alive: true });
  });

  it('with no session and no record is not alive', async () => {
    const t = setup();
    expect(await t.recorder.ping(A)).toEqual({ alive: false });
  });

  it("with another frame's session clears this frame's record: the retry gave way (V53)", async () => {
    const t = setup({ record: leftBehind() });
    const reading = deferred();
    t.deps.pending.read.mockReturnValueOnce(reading.promise);
    const ping = t.recorder.ping(A);
    await t.recorder.start(B);
    reading.resolve(leftBehind());
    expect(await ping).toEqual({ alive: false });
    await flush();
    expect(run(t)).toHaveLength(0);
  });

  it('a read that fails rejects, for the router to answer with no verdict', async () => {
    const t = setup();
    t.deps.pending.read.mockRejectedValue(new Error('no storage'));
    await expect(t.recorder.ping(A)).rejects.toThrow('no storage');
  });

  it('a resumed edit sends editText', async () => {
    const t = setup({ record: leftBehind({ editText: 'old words', modeKey: EDIT_MODE }) });
    await t.recorder.ping(A);
    await flush();
    expect(run(t)[0][0]).toMatchObject({ editText: 'old words', modeKey: EDIT_MODE, resumed: true });
  });

  it('a resumed edit whose tab closes clears the record (V44)', async () => {
    const t = setup({ record: leftBehind({ editText: 'old words', modeKey: EDIT_MODE }) });
    const provider = deferred();
    t.deps.dictate.mockReturnValue(provider.promise);
    await t.recorder.ping(A);
    await flush();
    await t.recorder.onTabRemoved(A.tabId);
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
    expect(t.recorder.session).toBeNull();
    provider.resolve({ ...DICTATION });
    await flush();
  });

  it('a subframe record cleared on a ping takes down the mirror its worker left', async () => {
    const t = setup({ record: leftBehind({ endpoint: A_CHILD, attempts: 1 }) });
    expect(await t.recorder.ping(A_CHILD)).toEqual({ alive: false });
    expect(t.tabMessages()).toEqual([{ endpoint: { tabId: 1, frameId: 0 }, action: MSG.RECORDING_MIRROR, state: 'idle', elapsedMs: expect.any(Number) }]);
  });

  it('a frame 0 record cleared on a ping sends no mirror', async () => {
    const t = setup({ record: leftBehind({ attempts: 1 }) });
    await t.recorder.ping(A);
    expect(t.tabMessages()).toEqual([]);
  });

  it("a cleared subframe record leaves the mirror of a session in the same tab", async () => {
    const t = setup({ record: leftBehind({ endpoint: A_CHILD }) });
    const reading = deferred();
    t.deps.pending.read.mockReturnValueOnce(reading.promise);
    const ping = t.recorder.ping(A_CHILD);
    await t.recorder.start({ tabId: 1, frameId: 9 });
    reading.resolve(leftBehind({ endpoint: A_CHILD }));
    expect(await ping).toEqual({ alive: false });
    expect(t.tabMessages().filter((m) => m.action === MSG.RECORDING_MIRROR)).toEqual([]);
  });

  it("a resumed run keeps the record's always-copy", async () => {
    const t = setup({ record: leftBehind({ alwaysCopy: true }) });
    await t.recorder.ping(A);
    await flush();
    expect(t.copies()).toEqual([{ action: MSG.OFFSCREEN_COPY, text: 'final' }]);
  });

  it("a resumed subframe takes frame 0's mirror down with it: nobody else knows it is up", async () => {
    const t = setup({ record: leftBehind({ endpoint: A_CHILD }) });
    await t.recorder.ping(A_CHILD);
    await flush();
    expect(t.tabMessages()).toContainEqual({ endpoint: { tabId: 1, frameId: 0 }, action: MSG.RECORDING_MIRROR, state: 'idle', elapsedMs: expect.any(Number) });
  });

  it('a reply never carries the audio', async () => {
    const t = setup({ record: leftBehind() });
    expect(JSON.stringify(await t.recorder.ping(A))).not.toContain('QUJD');
  });
});

describe('sweep (V53)', () => {
  const at = (t, ms) => t.deps.now.mockReturnValue(ms);

  it('clears a stale record, keeps a fresh one, and a later sweep past the window clears it', async () => {
    const stale = setup({ record: leftBehind({ at: T0 - PENDING_WINDOW_MS }) });
    await stale.recorder.sweep();
    expect(stale.deps.pending.store.record).toBeNull();

    const t = setup({ record: leftBehind({ at: T0 - 1000 }) });
    await t.recorder.sweep();
    expect(t.deps.pending.store.record).not.toBeNull();
    at(t, T0 - 1000 + PENDING_WINDOW_MS - 1);
    await t.recorder.sweep();
    expect(t.deps.pending.store.record).not.toBeNull();
    at(t, T0 - 1000 + PENDING_WINDOW_MS);
    await t.recorder.sweep();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('reads storage only when a fresh record was noted', async () => {
    const t = setup();
    await t.recorder.sweep();
    expect(t.deps.pending.read).toHaveBeenCalledTimes(1);
    await t.recorder.sweep();
    at(t, T0 + PENDING_WINDOW_MS * 2);
    await t.recorder.sweep();
    expect(t.deps.pending.read).toHaveBeenCalledTimes(1);
  });

  it('a read of a fresh record waits for its window', async () => {
    const t = setup({ record: leftBehind({ at: T0 - 1000 }) });
    await t.recorder.sweep();
    await t.recorder.sweep();
    expect(t.deps.pending.read).toHaveBeenCalledTimes(1);
  });

  it("notes this worker's own record too: one still held past the window goes", async () => {
    const t = setup();
    await t.recorder.sweep();
    t.deps.dictate.mockReturnValue(new Promise(() => {}));
    await t.recorder.start(A);
    await t.recorder.stop(A);
    t.recorder.onDone(done({ captureId: t.id() }));
    await flush();
    at(t, T0 + PENDING_WINDOW_MS);
    await t.recorder.sweep();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('a read that fails never rejects, and the next message tries again', async () => {
    const t = setup({ record: leftBehind({ at: T0 - PENDING_WINDOW_MS }) });
    t.deps.pending.read.mockRejectedValueOnce(new Error('no storage'));
    await expect(t.recorder.sweep()).resolves.toBeUndefined();
    await t.recorder.sweep();
    expect(t.deps.pending.store.record).toBeNull();
  });

  it('a clear that fails never rejects', async () => {
    const t = setup({ record: leftBehind({ at: T0 - PENDING_WINDOW_MS }) });
    t.deps.pending.clear.mockRejectedValue(new Error('no storage'));
    await expect(t.recorder.sweep()).resolves.toBeUndefined();
  });
});

describe('a tab closing and a record with no session', () => {
  it('clears the record of that tab: it can never ping for it', async () => {
    const t = setup({ record: leftBehind({ editText: 'old words' }) });
    await t.recorder.sweep();
    await t.recorder.onTabRemoved(A.tabId);
    expect(t.deps.pending.store.record).toBeNull();
  });

  it("leaves another tab's record", async () => {
    const t = setup({ record: leftBehind() });
    await t.recorder.sweep();
    await t.recorder.onTabRemoved(B.tabId);
    expect(t.deps.pending.store.record).not.toBeNull();
  });

  it("finds the record while the worker's first sweep is still reading: that close is what woke it", async () => {
    const t = setup({ record: leftBehind() });
    const reading = deferred();
    t.deps.pending.read.mockReturnValueOnce(reading.promise);
    const sweeping = t.recorder.sweep();
    await t.recorder.onTabRemoved(A.tabId);
    expect(t.deps.pending.store.record).toBeNull();
    reading.resolve(null);
    await sweeping;
  });

  it('reads nothing with no record noted', async () => {
    const t = setup();
    await t.recorder.sweep();
    expect(t.deps.pending.read).toHaveBeenCalledTimes(1);
    await t.recorder.onTabRemoved(A.tabId);
    expect(t.deps.pending.read).toHaveBeenCalledTimes(1);
  });

  it('reads nothing with a session: a start has cleared what there was', async () => {
    const t = setup();
    await t.recorder.start(B);
    await t.recorder.onTabRemoved(A.tabId);
    expect(t.deps.pending.read).not.toHaveBeenCalled();
  });

  it('a read that fails never rejects', async () => {
    const t = setup({ record: leftBehind() });
    await t.recorder.sweep();
    t.deps.pending.read.mockRejectedValue(new Error('no storage'));
    await expect(t.recorder.onTabRemoved(A.tabId)).resolves.toBeUndefined();
  });
});

describe('a start and the record (V53)', () => {
  it('a start that gets a session clears the record', async () => {
    const t = setup({ record: leftBehind() });
    await t.recorder.start(B);
    await flush();
    expect(t.deps.pending.store.record).toBeNull();
    expect(await t.recorder.ping(A)).toEqual({ alive: false });
  });

  it('a refused start leaves it', async () => {
    const t = setup({ record: leftBehind() });
    await t.recorder.start(A);
    await flush();
    t.deps.pending.store.record = leftBehind();
    await t.recorder.start(B);
    await flush();
    expect(t.deps.pending.store.record).not.toBeNull();
  });
});
