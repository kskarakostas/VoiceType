// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createController, FOCUS_OUT_MS, PROCESSING_TIMEOUT_MS } from '../../../src/content/controller.js';
import { isValidInput, deepActiveElement } from '../../../src/content/fields.js';
import { MSG } from '../../../src/shared/messages.js';

const RECT = { top: 100, left: 400, width: 300, height: 30 };
const ORPHAN = 'VoiceType was updated. Reload this page.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';

/** Records every call the controller makes on the pill; tracks visibility like the real one. */
function fakePill() {
  const pill = {
    host: document.createElement('voicetype-host'),
    visible: false,
    show: vi.fn(() => { pill.visible = true; }),
    reposition: vi.fn(),
    hide: vi.fn(() => { pill.visible = false; }),
    setState: vi.fn(),
    setLevel: vi.fn(),
    setStatus: vi.fn(),
    clearStatus: vi.fn(),
    renderMenu: vi.fn(),
    destroy: vi.fn(() => { pill.visible = false; }),
  };
  return pill;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function setup({ replies = {}, insert = 'inserted', copy = true, activeElement = () => deepActiveElement(document) } = {}) {
  const pill = fakePill();
  const sent = [];
  const table = {
    [MSG.START_RECORDING]: { ok: true },
    [MSG.STOP_RECORDING]: { ok: true },
    [MSG.CANCEL_RECORDING]: { ok: true },
    [MSG.UPDATE_SETTINGS]: { success: true },
    ...replies,
  };
  const send = vi.fn(async (message) => {
    sent.push(message);
    const reply = table[message.action];
    return typeof reply === 'function' ? reply(message) : (reply ?? null);
  });
  const unwatch = vi.fn();
  const deps = {
    pill,
    send,
    insertText: vi.fn(async () => insert),
    copyText: vi.fn(async () => copy),
    isValidInput,
    deepActiveElement: activeElement,
    rectOf: (el) => (el?.isConnected ? { ...RECT } : null),
    watchAnchor: vi.fn(() => unwatch),
    hasFocus: vi.fn(() => true),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  const controller = createController(deps);
  return { controller, pill, send, deps, unwatch, actions: () => sent.map((m) => m.action), sent };
}

/** Let pending promise chains (send, insertText, copyText) settle under fake timers. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const $ = (id) => document.getElementById(id);
const lastStatus = (pill) => pill.setStatus.mock.calls.at(-1);

function settings(overrides = {}) {
  return {
    provider: 'openai',
    hasKey: { openai: true, gemini: false },
    activeMode: 'default',
    pillGap: 12,
    modes: { default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true } },
    ...overrides,
  };
}

/** Focus field a, start, and stop: the controller is processing with a bound to it. */
async function recordAndStop(t, id = 'a') {
  $(id).focus();
  t.controller.focusIn($(id));
  await t.controller.toggle();
  await t.controller.toggle();
  expect(t.controller.state).toBe('processing');
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<textarea id="a"></textarea><textarea id="b"></textarea><button id="plain">x</button>';
});

afterEach(() => {
  document.activeElement?.blur?.();
  vi.useRealTimers();
});

describe('toggle', () => {
  it('tap start and stop', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenLastCalledWith(RECT, { gap: 8 });
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));

    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
    expect(t.pill.clearStatus).toHaveBeenCalled();

    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setState).toHaveBeenLastCalledWith('processing');
  });

  it('stop queued while starting', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.toggle();
    expect(t.controller.state).toBe('starting');
    await t.controller.toggle();
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    start.resolve({ ok: true });
    await pending;
    await flush();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('drops a start reply that arrives after a reset', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
    start.resolve({ ok: true });
    await pending;
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).not.toHaveBeenCalledWith('recording');
  });

  it('start failure tones (needsPermission sticky info)', async () => {
    const permission = 'Allow the microphone in the VoiceType tab that just opened, then press REC again.';
    let reply = { ok: false, reason: 'needsPermission', error: permission };
    const t = setup({ replies: { [MSG.START_RECORDING]: () => reply } });
    $('a').focus();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    expect(lastStatus(t.pill)).toEqual([permission, { tone: 'info', sticky: true, clickable: false }]);

    reply = { ok: false, reason: 'noKey', error: 'Add an API key in the VoiceType popup.' };
    await t.controller.toggle();
    expect(lastStatus(t.pill)).toEqual(['Add an API key in the VoiceType popup.', { tone: 'error', sticky: false, clickable: false }]);

    reply = { ok: false, reason: 'busy', error: 'VoiceType is busy in another tab. Try again in a moment.' };
    await t.controller.toggle();
    expect(lastStatus(t.pill)[1].tone).toBe('error');
    expect(t.controller.state).toBe('idle');
  });

  it('a start without a reply reports the background service', async () => {
    const t = setup({ replies: { [MSG.START_RECORDING]: null } });
    $('a').focus();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)[0]).toBe('VoiceType could not reach its background service. Try again.');
  });

  it('"Still processing" during processing', async () => {
    const t = setup();
    await recordAndStop(t);
    t.send.mockClear();
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(['Still processing', { tone: 'info', sticky: false, clickable: false }]);
    expect(t.controller.state).toBe('processing');
  });

  it('a refused stop returns to idle instead of hanging in processing', async () => {
    const t = setup({ replies: { [MSG.STOP_RECORDING]: { ok: false } } });
    $('a').focus();
    await t.controller.toggle();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'late', raw: 'late', cost: 0, warning: null });
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'late');
  });

  it('no-target start shows the pill at the corner and copies the result', async () => {
    const t = setup();
    await t.controller.toggle();
    expect(t.pill.show).toHaveBeenLastCalledWith(null, { gap: 8 });
    expect(t.deps.watchAnchor).not.toHaveBeenCalled();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0.01, warning: null });
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'info', sticky: false, clickable: false }]);
    expect(t.controller.state).toBe('idle');
    vi.advanceTimersByTime(2499);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalled();
  });
});

describe('hotkey', () => {
  it('hold-to-talk press and release', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
    await t.controller.release({ held: true });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('a tap keeps recording and the next press stops', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.press();
    await t.controller.release({ held: false });
    expect(t.controller.state).toBe('recording');
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    await t.controller.press();
    await t.controller.release({ held: false });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });

  it('press while recording stops', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    await t.controller.press();
    await t.controller.release({ held: true });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('a held release while starting queues the stop', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    $('a').focus();
    const pending = t.controller.press();
    await t.controller.release({ held: true });
    start.resolve({ ok: true });
    await pending;
    await flush();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('press during processing shows "Still processing"', async () => {
    const t = setup();
    await recordAndStop(t);
    await t.controller.press();
    expect(lastStatus(t.pill)[0]).toBe('Still processing');
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });
});

describe('service worker messages', () => {
  it.each([
    ['maxTime', 'Max time reached', 'info'],
    ['silence', 'Stopped after silence', 'info'],
    ['ended', 'Microphone disconnected', 'warning'],
  ])('RECORDING_STATE auto-stop messages: %s', async (reason, text, tone) => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing', reason });
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setState).toHaveBeenLastCalledWith('processing');
    expect(lastStatus(t.pill)).toEqual([text, { tone, sticky: false, clickable: false }]);
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
  });

  it('RECORDING_STATE idle returns to idle and shows the notice', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({
      action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    });
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(['Recording failed. Try again.', { tone: 'error', sticky: false, clickable: false }]);
  });

  it('keeps a permission notice until the next REC and ignores it while recording', async () => {
    const t = setup();
    t.controller.handleMessage({
      action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission',
      notice: { text: 'Microphone allowed. Press REC again.', tone: 'success' },
    });
    expect(lastStatus(t.pill)).toEqual(['Microphone allowed. Press REC again.', { tone: 'success', sticky: true, clickable: false }]);
    $('a').focus();
    await t.controller.toggle();
    const calls = t.pill.setStatus.mock.calls.length;
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle', reason: 'permission', notice: { text: 'late', tone: 'success' } });
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setStatus.mock.calls).toHaveLength(calls);
  });

  it('ignores a result, and a processing notice while starting, from an earlier recording', async () => {
    const start = deferred();
    const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise } });
    const stale = { action: MSG.DICTATION_RESULT, success: true, text: 'stale', raw: 'stale', cost: 0, warning: null };
    $('a').focus();
    t.controller.focusIn($('a'));
    const pending = t.controller.toggle();
    expect(t.controller.state).toBe('starting');
    t.controller.handleMessage(stale);
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing', reason: 'silence' });
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('starting');
    start.resolve({ ok: true });
    await pending;
    expect(t.controller.state).toBe('recording');
    t.controller.handleMessage(stale);
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(t.pill.setStatus).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('recording');
  });

  it('passes AUDIO_LEVEL to the pill only while recording', async () => {
    const t = setup();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 0.4 });
    expect(t.pill.setLevel).not.toHaveBeenCalled();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 0.4 });
    expect(t.pill.setLevel).toHaveBeenCalledWith(0.4);
  });

  it('settings updates ignored when not objects', () => {
    const t = setup();
    for (const bad of [null, undefined, 'x', 42, [], {}, { modes: null }, { modes: 'x' }]) {
      t.controller.setSettings(bad);
      t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: bad });
    }
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
    const good = settings();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: good });
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null);
    t.controller.setSettings('still not settings');
    expect(t.pill.renderMenu).toHaveBeenCalledTimes(1);
  });

  it('maps the usage summary for the menu', () => {
    const t = setup();
    t.controller.setUsage({ today: { sessions: 2, estimatedCost: 0.01 }, total: { sessions: 9, estimatedCost: 0.5 } });
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
    const good = settings();
    t.controller.setSettings(good);
    t.controller.setUsage({ today: { sessions: 2, estimatedCost: 0.01 }, last7Days: {}, total: { sessions: 9, estimatedCost: 0.5 } });
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, { todayCost: 0.01, todaySessions: 2, totalCost: 0.5 });
    t.controller.setUsage(null);
    t.controller.setUsage({ today: 1 });
    expect(t.pill.renderMenu).toHaveBeenCalledTimes(2);
  });

  it('uses the settings pill gap', () => {
    const t = setup();
    t.controller.setSettings(settings({ pillGap: 12 }));
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenLastCalledWith(RECT, { gap: 12 });
  });
});

describe('delivery', () => {
  const result = (extra = {}) => ({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello raw', cost: 0.012, warning: null, ...extra });

  it.each([
    ['inserted', 'Done $0.01', { tone: 'success', sticky: false, clickable: false }, 'done'],
    ['unverified', 'Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning', sticky: false, clickable: false }, 'done'],
    ['clipboard', 'Copied to clipboard. The field could not be edited.', { tone: 'warning', sticky: false, clickable: false }, 'done'],
    ['failed', CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }, 'error'],
  ])('DICTATION_RESULT for each insert outcome: %s', async (outcome, text, options, pillState) => {
    const t = setup({ insert: outcome });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual([text, options]);
    expect(t.pill.setState).toHaveBeenLastCalledWith(pillState);
    expect(t.controller.state).toBe('idle');
  });

  it('warning shown 6 s', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage(result({ warning: 'Text model failed. Inserted the raw transcript.' }));
    await flush();
    expect(lastStatus(t.pill)).toEqual(['Text model failed. Inserted the raw transcript.', { tone: 'warning', sticky: false, clickable: false }]);
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(6000 - FOCUS_OUT_MS - 1);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
  });

  it('shows a failed result with its tone and touches no field', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' });
    await flush();
    expect(lastStatus(t.pill)).toEqual(['Too short, ignored', { tone: 'warning', sticky: false, clickable: false }]);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'Invalid API key.', tone: 'error' });
    await flush();
    expect(lastStatus(t.pill)[1].tone).toBe('error');
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  });

  it('focus moved: clipboard, not the focused field', async () => {
    const t = setup();
    await recordAndStop(t, 'a');
    $('b').focus();
    t.controller.focusIn($('b'));
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect($('b').value).toBe('');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
  });

  it('removed target and failed copy: click-to-copy', async () => {
    const t = setup({ copy: false });
    await recordAndStop(t, 'a');
    $('a').remove();
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual([CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }]);
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();

    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.copyLast();
    expect(lastStatus(t.pill)).toEqual(['Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true }]);
    t.deps.copyText.mockResolvedValueOnce(true);
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenLastCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
  });

  it('copyLast does nothing before a result', async () => {
    const t = setup();
    await t.controller.copyLast();
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });

  it('a sticky status stays at the corner when its field leaves the page', async () => {
    const t = setup({ copy: false });
    await recordAndStop(t, 'a');
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    $('a').remove();
    t.controller.handleMessage(result());
    await flush();
    expect(lastStatus(t.pill)).toEqual([CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }]);
    const clears = t.pill.clearStatus.mock.calls.length;
    onChange();
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.reposition).toHaveBeenLastCalledWith(null);
    expect(t.pill.visible).toBe(true);
    expect(t.pill.clearStatus.mock.calls).toHaveLength(clears);
    expect(lastStatus(t.pill)[0]).toBe(CLICK_TO_COPY);
  });

  it('shows a never-shown pill before a result status', async () => {
    const t = setup();
    t.controller.handleMessage(result());
    await flush();
    expect(t.pill.show).toHaveBeenCalledWith(null, { gap: 8 });
    expect(t.pill.show.mock.invocationCallOrder[0]).toBeLessThan(t.pill.setStatus.mock.invocationCallOrder[0]);
    expect(t.pill.visible).toBe(true);
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'info', sticky: false, clickable: false }]);
  });

  it('shows a hidden pill at the focused field before a notice', () => {
    const t = setup();
    $('a').focus();
    t.controller.handleMessage({
      action: MSG.RECORDING_STATE, state: 'idle', reason: 'error',
      notice: { text: 'Recording failed. Try again.', tone: 'error' },
    });
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 8 });
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));
    expect(t.pill.show.mock.invocationCallOrder[0]).toBeLessThan(t.pill.setStatus.mock.invocationCallOrder[0]);
    expect(t.pill.visible).toBe(true);
  });

  it('an insert that throws leaves the click-to-copy status', async () => {
    const t = setup();
    await recordAndStop(t);
    t.deps.insertText.mockRejectedValueOnce(new Error('boom'));
    t.controller.handleMessage(result());
    await flush();
    expect(lastStatus(t.pill)).toEqual([CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }]);
    expect(t.pill.setState).toHaveBeenLastCalledWith('error');
    expect(t.controller.state).toBe('idle');
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenLastCalledWith('hello');
  });
});

describe('another frame or window has focus', () => {
  const HOLD = ['Return to the field to insert, or click here to copy.', { tone: 'info', sticky: true, clickable: true }];
  const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello raw', cost: 0.012, warning: null };

  /** The bound field keeps this frame's focus, but the frame itself does not have it. */
  async function holdResult(t) {
    await recordAndStop(t);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage(RESULT);
    await flush();
  }

  it('holds the result instead of inserting it', async () => {
    const t = setup();
    await holdResult(t);
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(HOLD);
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    expect(t.pill.visible).toBe(true);
    expect(t.controller.state).toBe('idle');
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.deps.insertText).not.toHaveBeenCalled();
  });

  it('inserts on the next window focus, once', async () => {
    const t = setup();
    await holdResult(t);
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(lastStatus(t.pill)).toEqual(['Done $0.01', { tone: 'success', sticky: false, clickable: false }]);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });

  it.each([
    ['focus moved to another field', () => $('b').focus()],
    ['the field left the page', () => $('a').remove()],
  ])('takes the clipboard on focus when %s', async (_name, change) => {
    const t = setup();
    await holdResult(t);
    change();
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect($('b').value).toBe('');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
  });

  it('a status click copies and drops the hold', async () => {
    const t = setup();
    await holdResult(t);
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledTimes(1);
  });

  it('REC while a result is held settles it before any new recording', async () => {
    const t = setup();
    await holdResult(t);
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING, MSG.START_RECORDING]);
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).not.toHaveBeenCalled();
  });

  /**
   * Another frame took the focus: Chromium resets this frame's activeElement to its body, so
   * the bound field is no longer active although it was the last field focused here.
   */
  async function holdAfterReset(t) {
    await recordAndStop(t);
    $('a').blur();
    t.controller.focusOut();
    t.deps.hasFocus.mockReturnValue(false);
    expect(document.activeElement).toBe(document.body);
    t.controller.handleMessage(RESULT);
    await flush();
  }

  it('focus moved to another frame holds even when activeElement reset to body', async () => {
    const t = setup();
    await holdAfterReset(t);
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(HOLD);
    expect(t.controller.state).toBe('idle');
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();
  });

  it.each([
    ['null', () => null],
    ['the document element', () => document.documentElement],
  ])('a blank activeElement (%s) also holds for the field focused last', async (_name, blank) => {
    let reset = false;
    const t = setup({ activeElement: () => (reset ? blank() : deepActiveElement(document)) });
    await recordAndStop(t);
    reset = true;
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(t.pill)).toEqual(HOLD);
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });

  it('focus moved to another field of this frame first takes the clipboard, not the hold', async () => {
    const t = setup();
    await recordAndStop(t);
    $('b').focus();
    t.controller.focusIn($('b'));
    $('b').blur();
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
  });

  it('after a hold, a window focus with the field active and focused inserts once', async () => {
    const t = setup();
    await holdAfterReset(t);
    $('a').focus();
    t.controller.focusIn($('a'));
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(lastStatus(t.pill)).toEqual(['Done $0.01', { tone: 'success', sticky: false, clickable: false }]);
    await t.controller.onWindowFocus();
    vi.advanceTimersByTime(0);
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });

  it('a window focus that lands before the field\'s own focus waits one task for it', async () => {
    const t = setup();
    await holdAfterReset(t);
    // Chromium focuses the frame's window first, while its activeElement is still the body.
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).not.toHaveBeenCalled();
    $('a').focus();
    t.controller.focusIn($('a'));
    vi.advanceTimersByTime(0);
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });

  it('returning to the frame but not to the field takes the clipboard', async () => {
    const t = setup();
    await holdAfterReset(t);
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    vi.advanceTimersByTime(0);
    await flush();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
  });
});

describe('processing watchdog', () => {
  const NO_RESPONSE = ['No response from VoiceType. Try again.', { tone: 'error', sticky: false, clickable: false }];
  const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0.012, warning: null };
  const DONE = ['Done $0.01', { tone: 'success', sticky: false, clickable: false }];
  const texts = (t) => t.pill.setStatus.mock.calls.map(([text]) => text);

  it('returns to idle with a notice after 75 s without a reply', async () => {
    const t = setup();
    await recordAndStop(t);
    expect(PROCESSING_TIMEOUT_MS).toBe(75_000);
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    expect(t.controller.state).toBe('processing');
    vi.advanceTimersByTime(1);
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('error');
    expect(lastStatus(t.pill)).toEqual(NO_RESPONSE);
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING, MSG.START_RECORDING]);
  });

  it('an auto-stop enters processing with the watchdog, and every RECORDING_STATE re-arms it', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing', reason: 'silence' });
    vi.advanceTimersByTime(70_000);
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing' });
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS - 1);
    expect(t.controller.state).toBe('processing');
    expect(texts(t)).not.toContain(NO_RESPONSE[0]);
    vi.advanceTimersByTime(1);
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(NO_RESPONSE);
  });

  it('a result, an idle state, teardown or the orphan notice clears it', async () => {
    const byResult = setup();
    await recordAndStop(byResult);
    vi.advanceTimersByTime(70_000);
    byResult.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(byResult.pill)).toEqual(DONE);

    const byIdle = setup();
    await recordAndStop(byIdle);
    byIdle.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });

    const byTeardown = setup();
    await recordAndStop(byTeardown);
    byTeardown.controller.teardown();

    const byOrphan = setup();
    await recordAndStop(byOrphan);
    byOrphan.controller.orphaned();

    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS * 2);
    for (const t of [byResult, byIdle, byTeardown, byOrphan]) {
      expect(texts(t)).not.toContain(NO_RESPONSE[0]);
      expect(t.pill.setState).not.toHaveBeenCalledWith('error');
    }
  });

  it('a late result after expiry still goes into the bound field while it has focus', async () => {
    const t = setup();
    await recordAndStop(t);
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    expect(t.controller.state).toBe('idle');
    t.controller.handleMessage(RESULT);
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(t.deps.copyText).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(DONE);
  });
});

describe('focus', () => {
  it('focusIn shows the pill at a valid field and follows it', () => {
    const t = setup();
    t.controller.focusIn($('plain'));
    t.controller.focusIn(null);
    expect(t.pill.show).not.toHaveBeenCalled();
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 8 });
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    onChange();
    expect(t.pill.reposition).toHaveBeenCalledWith(RECT);
    t.controller.focusIn($('b'));
    expect(t.unwatch).toHaveBeenCalledTimes(1);
    expect(t.deps.watchAnchor).toHaveBeenLastCalledWith($('b'), expect.any(Function));
  });

  it('hides an idle pill whose field left the page', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    $('a').remove();
    onChange();
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.unwatch).toHaveBeenCalled();
  });

  it('keeps a recording pill at the corner when its field leaves the page', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    const onChange = t.deps.watchAnchor.mock.calls[0][1];
    $('a').remove();
    onChange();
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.reposition).toHaveBeenLastCalledWith(null);
  });

  it('does not move the pill while recording', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    const shows = t.pill.show.mock.calls.length;
    $('b').focus();
    t.controller.focusIn($('b'));
    expect(t.pill.show.mock.calls).toHaveLength(shows);
  });

  it('focusOut hides only when idle', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS - 1);
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
    expect(t.unwatch).toHaveBeenCalledTimes(1);

    // Focus moved to another valid field: stay.
    $('a').focus();
    t.controller.focusIn($('a'));
    $('b').focus();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);

    // Recording: stay.
    await t.controller.toggle();
    $('b').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);

    // Processing: stay.
    await t.controller.toggle();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
  });

  it('focusOut keeps the pill while a sticky status shows', async () => {
    const t = setup({ replies: { [MSG.START_RECORDING]: { ok: false, reason: 'needsPermission', error: 'Allow the microphone.' } } });
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    $('a').blur();
    t.controller.focusOut();
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();
  });

  it('focusOut hides an idle pill once another frame or window has the focus, and focusIn brings it back', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.visible).toBe(true);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(document.activeElement).toBe($('a'));
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
    expect(t.pill.visible).toBe(false);
    t.deps.hasFocus.mockReturnValue(true);
    t.controller.focusIn($('a'));
    expect(t.pill.visible).toBe(true);
    expect(t.pill.show).toHaveBeenLastCalledWith(RECT, { gap: 8 });
  });

  it('a held result keeps its pill when the frame loses focus', async () => {
    const t = setup();
    await recordAndStop(t);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
    await flush();
    expect(lastStatus(t.pill)[0]).toBe('Return to the field to insert, or click here to copy.');
    t.controller.focusOut();
    vi.advanceTimersByTime(60_000);
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.visible).toBe(true);
  });

  it('focusOut keeps the pill while focus is inside it', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.pill.host.tabIndex = 0;
    document.body.append(t.pill.host);
    t.pill.host.focus();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
  });
});

describe('menu choices', () => {
  it('sends a whitelisted patch and shows a refusal', async () => {
    const t = setup({ replies: { [MSG.UPDATE_SETTINGS]: { success: false, error: 'Invalid settings.' } } });
    await t.controller.choose({ activeMode: 'email' });
    expect(t.sent.at(-1)).toEqual({ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } });
    expect(lastStatus(t.pill)).toEqual(['Invalid settings.', { tone: 'error', sticky: false, clickable: false }]);
  });

  it('shows nothing when the save succeeds', async () => {
    const t = setup();
    await t.controller.choose({ provider: 'gemini' });
    expect(t.sent.at(-1)).toEqual({ action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } });
    expect(t.pill.setStatus).not.toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('orphan notice is terminal', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    t.controller.orphaned();
    expect(lastStatus(t.pill)).toEqual([ORPHAN, { tone: 'error', sticky: true, terminal: true }]);
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    const statuses = t.pill.setStatus.mock.calls.length;
    t.send.mockClear();

    t.controller.orphaned();
    await t.controller.toggle();
    await t.controller.press();
    await t.controller.release({ held: true });
    await t.controller.choose({ provider: 'gemini' });
    await t.controller.copyLast();
    await t.controller.onWindowFocus();
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'late', tone: 'error' });
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle', notice: { text: 'late', tone: 'info' } });
    t.controller.setSettings(settings());
    t.controller.focusIn($('b'));
    t.controller.focusOut();
    vi.advanceTimersByTime(60000);
    await flush();

    expect(t.send).not.toHaveBeenCalled();
    expect(t.pill.setStatus.mock.calls).toHaveLength(statuses);
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.renderMenu).not.toHaveBeenCalled();
  });

  it('shows the orphan notice at the corner when the pill was hidden', () => {
    const t = setup();
    t.controller.orphaned();
    expect(t.pill.show).toHaveBeenCalledWith(null, { gap: 8 });
    expect(lastStatus(t.pill)[0]).toBe(ORPHAN);
  });

  it('teardown removes the pill and listeners', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.toggle();
    t.controller.focusOut();
    t.controller.teardown();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.CANCEL_RECORDING]);
    expect(t.unwatch).toHaveBeenCalledTimes(1);
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
    // The pending focus-out timer is cleared: nothing hides a destroyed pill later.
    vi.advanceTimersByTime(60000);
    expect(t.pill.hide).not.toHaveBeenCalled();

    t.controller.teardown();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.AUDIO_LEVEL, level: 1 });
    t.controller.orphaned();
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
    expect(t.pill.setLevel).not.toHaveBeenCalled();
    expect(t.pill.setStatus).not.toHaveBeenCalled();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.CANCEL_RECORDING]);
  });

  it('teardown when idle sends nothing, and still works after orphaned', () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.controller.orphaned();
    t.controller.teardown();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.pill.destroy).toHaveBeenCalledTimes(1);
  });
});
