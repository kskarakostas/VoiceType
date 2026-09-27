import { describe, it, expect, vi } from 'vitest';
import { createRecorder } from '../../../src/background/recorder.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

const A = { tabId: 1, frameId: 0 };
const A_CHILD = { tabId: 1, frameId: 5 };
const B = { tabId: 2, frameId: 0 };

const BUSY = { ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' };
const NEEDS_PERMISSION = { ok: false, reason: 'needsPermission', error: 'Allow the microphone in the VoiceType tab that just opened, then press REC again.' };
const DENIED = { ok: false, reason: 'denied', error: 'Microphone blocked for VoiceType. Allow it at chrome://settings/content/microphone.' };
const DICTATION = { success: true, text: 'final', raw: 'raw', cost: 0.001, warning: null };
const stopOf = (captureId) => ({ action: MSG.OFFSCREEN_STOP, discard: false, captureId });
const discardOf = (captureId) => ({ action: MSG.OFFSCREEN_STOP, discard: true, captureId });
const done = (over = {}) => ({ audioBase64: 'QUJD', mimeType: 'audio/webm', durationSec: 4.2, reason: 'user', ...over });

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Recorder over fake deps. `startReply` answers OFFSCREEN_START (a value, or a function returning one). */
function setup({ startReply = { ok: true }, settings: patch = {} } = {}) {
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
  };
  const recorder = createRecorder(deps);
  const offscreenMessages = () => deps.toOffscreen.mock.calls.map(([message]) => message);
  const tabMessages = () => deps.toTab.mock.calls.map(([endpoint, message]) => ({ endpoint, ...message }));
  /** Capture ids of the offscreen starts so far; id() is the latest. */
  const ids = () => offscreenMessages().filter((m) => m.action === MSG.OFFSCREEN_START).map((m) => m.captureId);
  const id = () => ids().at(-1);
  return { deps, recorder, settings, offscreenMessages, tabMessages, ids, id };
}

describe('start', () => {
  it('starts the offscreen capture with the recording limits and records the session', async () => {
    const { deps, recorder } = setup();
    expect(await recorder.start(A)).toEqual({ ok: true });
    expect(deps.ensureOffscreen.mock.invocationCallOrder[0]).toBeLessThan(deps.toOffscreen.mock.invocationCallOrder[0]);
    expect(deps.toOffscreen).toHaveBeenCalledWith({ action: MSG.OFFSCREEN_START, maxSec: 120, silenceSec: 3, captureId: expect.any(String) });
    expect(recorder.session).toEqual({ endpoint: A, state: 'recording', modeKey: 'email', minSec: 1 });
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
    expect(await recorder.start(A_CHILD)).toEqual(BUSY);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
    expect(recorder.session.endpoint).toEqual(A);
  });

  it('concurrent starts from two tabs: one records, the other is busy', async () => {
    const { deps, recorder } = setup();
    expect(await Promise.all([recorder.start(A), recorder.start(B)])).toEqual([{ ok: true }, BUSY]);
    expect(deps.toOffscreen).toHaveBeenCalledTimes(1);
  });

  it('busy while processing, even for the frame that recorded', async () => {
    const { recorder } = setup();
    await recorder.start(A);
    await recorder.stop(A);
    expect(await recorder.start(A)).toEqual(BUSY);
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
    expect(await recorder.start(A)).toEqual({ ok: false, reason: 'noKey', error: 'Add an API key in the VoiceType popup.' });
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

describe('results', () => {
  it('delivers the dictation to the session frame after freeing the session', async () => {
    const { deps, recorder, tabMessages, id } = setup();
    await recorder.start(A_CHILD);
    await recorder.stop(A_CHILD);
    let sessionAtDelivery = 'unset';
    deps.toTab.mockImplementation(async () => { sessionAtDelivery = recorder.session; return true; });
    await recorder.onDone(done({ captureId: id() }));
    expect(deps.dictate).toHaveBeenCalledWith({ audioBase64: 'QUJD', mimeType: 'audio/webm', modeKey: 'email', durationSec: 4.2 });
    expect(tabMessages()).toEqual([{ endpoint: A_CHILD, action: MSG.DICTATION_RESULT, ...DICTATION }]);
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
        { endpoint: A, action: MSG.DICTATION_RESULT, ...DICTATION },
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
    expect(tabMessages()).toEqual([{ endpoint: B, action: MSG.DICTATION_RESULT, ...DICTATION }]);
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
      notice: { text: 'Microphone allowed. Press REC again.', tone: 'success' },
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
