// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createController, FOCUS_OUT_MS, PROCESSING_TIMEOUT_MS, PROCESSING_CEILING_MS, PING_MS } from '../../../src/content/controller.js';
import { isValidInput, deepActiveElement } from '../../../src/content/fields.js';
import { markInsertion, replaceInsertion } from '../../../src/content/insert.js';
import { MSG } from '../../../src/shared/messages.js';
import { MAX_EDIT_CHARS } from '../../../src/shared/defaults.js';
import { Pill, STATUS_MS } from '../../../src/content/pill.js';

const RECT = { top: 100, left: 400, width: 300, height: 30 };
const ORPHAN = 'VoiceType was turned off or updated. Reload this page.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';

/** Records every call the controller makes on the pill; tracks visibility like the real one. */
function fakePill() {
  const pill = {
    host: document.createElement('voicetype-host'),
    visible: false,
    show: vi.fn(() => { pill.visible = true; }),
    reposition: vi.fn(),
    hide: vi.fn(() => { pill.visible = false; }),
    setStyle: vi.fn(),
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

function setup({ replies = {}, insert = 'inserted', copy = true, activeElement = () => deepActiveElement(document), rectOf = (el) => (el?.isConnected ? { ...RECT } : null) } = {}) {
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
    markInsertion,
    // The real offset check, over this file's insertText.
    replaceInsertion: (el, mark, text, raw) => replaceInsertion(el, mark, text, raw, { insertText: (...args) => deps.insertText(...args.slice(0, 2)) }),
    isValidInput,
    deepActiveElement: activeElement,
    rectOf,
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
    const permission = 'Allow the microphone in the VoiceType tab that just opened, then try again.';
    let reply = { ok: false, reason: 'needsPermission', error: permission };
    const t = setup({ replies: { [MSG.START_RECORDING]: () => reply } });
    $('a').focus();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    expect(lastStatus(t.pill)).toEqual([permission, { tone: 'info', sticky: true, clickable: false }]);

    reply = { ok: false, reason: 'noKey', error: 'Add an API key in VoiceType settings.' };
    await t.controller.toggle();
    expect(lastStatus(t.pill)).toEqual(['Add an API key in VoiceType settings.', { tone: 'error', sticky: false, clickable: false }]);

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

describe('password fields', () => {
  const NOTICE = ['VoiceType does not record in password fields.', { tone: 'info', sticky: false, clickable: false }];

  /** @param {Record<string, string>} attributes */
  function focusInput(attributes) {
    const input = document.createElement('input');
    for (const [name, value] of Object.entries(attributes)) input.setAttribute(name, value);
    document.body.append(input);
    input.focus();
    return input;
  }

  it('hotkey in a password field never starts a recording', async () => {
    const t = setup();
    const input = focusInput({ type: 'password' });
    t.controller.focusIn(input);
    await t.controller.press();
    await t.controller.release({ held: true });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(NOTICE);
    // The pill never showed at the password field, so the notice sits at the corner.
    expect(t.pill.show).toHaveBeenCalledTimes(1);
    expect(t.pill.show).toHaveBeenLastCalledWith(null, { gap: 8 });
    expect(t.deps.watchAnchor).not.toHaveBeenCalled();
  });

  it('a revealed password field (autocomplete current-password) is refused too, from the hotkey and from REC', async () => {
    const t = setup();
    focusInput({ type: 'text', autocomplete: 'current-password' });
    await t.controller.press();
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.setStatus.mock.calls).toEqual([NOTICE, NOTICE]);
  });

  it('the notice goes away and the next press in a text field records', async () => {
    const t = setup();
    focusInput({ type: 'password' });
    await t.controller.press();
    vi.advanceTimersByTime(2500);
    expect(t.pill.hide).toHaveBeenCalledTimes(1);
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.press();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    expect(t.controller.state).toBe('recording');
  });
});

describe('a frame without keyboard focus', () => {
  const NO_FOCUS = ['Click into the field you want to dictate into, then try again.', { tone: 'info', sticky: false, clickable: false }];

  it('REC while another frame or window has the focus sends nothing and says where to click', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    // A REC click on this frame's pill leaves the focus in the other frame.
    t.deps.hasFocus.mockReturnValue(false);
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(NO_FOCUS);
  });

  it.each(['iframe', 'frame'])('REC while a child %s has the focus sends nothing and shows the notice at the corner', async (tag) => {
    const child = document.createElement(tag);
    const t = setup({ activeElement: () => child });
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(NO_FOCUS);
    expect(t.pill.show).toHaveBeenLastCalledWith(null, { gap: 8 });
    expect(t.deps.watchAnchor).not.toHaveBeenCalled();
  });

  it('the hotkey in the frame that has the focus still records', async () => {
    const t = setup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.press();
    await t.controller.release({ held: true });
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    expect(t.controller.state).toBe('processing');
  });
});

describe('a recording started before any focusIn', () => {
  it('holds its result as a field focused through focusIn would', async () => {
    const t = setup();
    // At boot focus events are ignored until the first settings answer.
    $('a').focus();
    await t.controller.press();
    await t.controller.toggle();
    // Chromium blanks a frame's activeElement when another frame takes the focus.
    $('a').blur();
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
    await flush();
    expect(lastStatus(t.pill)[0]).toBe('Return to the field to insert, or click here to copy.');
    expect(t.deps.copyText).not.toHaveBeenCalled();
  });
});

describe('a pending click-to-copy status', () => {
  const COPY_STATUS = [CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }];
  const COPY_FAILED = ['Copy failed. Click here to try again.', { tone: 'error', sticky: true, clickable: true }];

  function focusPasswordField() {
    const input = document.createElement('input');
    input.type = 'password';
    document.body.append(input);
    input.focus();
  }

  /** Records, fails to insert, and leaves the click-to-copy status up. */
  async function strandResult(t) {
    await recordAndStop(t);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
    await flush();
    expect(lastStatus(t.pill)).toEqual(COPY_STATUS);
    t.send.mockClear();
  }

  it.each([
    ['a press', (t) => t.controller.press()],
    ['a REC click', (t) => t.controller.toggle()],
  ])('%s copies it and starts nothing, and the next press records', async (_name, act) => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    await act(t);
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
    await t.controller.press();
    expect(t.send).toHaveBeenCalledWith({ action: MSG.START_RECORDING });
    expect(t.controller.state).toBe('recording');
    expect(t.deps.copyText).toHaveBeenCalledTimes(1);
  });

  it('the release of the press that copied stops no recording started since', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    await t.controller.press();
    await t.controller.toggle();
    expect(t.controller.state).toBe('recording');
    await t.controller.release({ held: true });
    expect(t.controller.state).toBe('recording');
  });

  it('a press that could not copy leaves the status clickable, and the next press records', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.press();
    expect(t.send).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual(COPY_FAILED);
    const clears = t.pill.clearStatus.mock.calls.length;
    await t.controller.press();
    expect(t.deps.copyText).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith({ action: MSG.START_RECORDING });
    expect(t.controller.state).toBe('recording');
    expect(t.pill.clearStatus).toHaveBeenCalledTimes(clears + 1);
  });

  it('a click on the status still retries after a press could not copy, and the press after it records', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.press();
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.copyLast();
    expect(lastStatus(t.pill)).toEqual(COPY_FAILED);
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenCalledTimes(3);
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
    expect(t.send).not.toHaveBeenCalled();
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it('a click that copied after a failed press lets the next stranded result copy on the press', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.press();
    await t.controller.copyLast();
    await strandResult(t);
    await t.controller.press();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledTimes(3);
  });

  it('a new result after a failed press is offered to the press again', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.press();
    await t.controller.toggle();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'next', raw: 'next', cost: 0, warning: null });
    await flush();
    expect(lastStatus(t.pill)).toEqual(COPY_STATUS);
    t.send.mockClear();
    await t.controller.press();
    expect(t.deps.copyText).toHaveBeenLastCalledWith('next');
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  });

  it('the status stays when the press after a failed copy is refused', async () => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    t.deps.copyText.mockResolvedValueOnce(false);
    await t.controller.press();
    focusPasswordField();
    await t.controller.press();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(COPY_FAILED);
  });

  it.each([
    ['a password field has the focus', 'VoiceType does not record in password fields.', () => focusPasswordField()],
    ['another frame or window has the focus', 'Click into the field you want to dictate into, then try again.', (t) => t.deps.hasFocus.mockReturnValue(false)],
  ])('a press settles it even when a start would be refused because %s', async (_name, notice, refuse) => {
    const t = setup({ insert: 'failed' });
    await strandResult(t);
    refuse(t);
    await t.controller.press();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(t.pill.clearStatus).toHaveBeenCalledTimes(1);
    expect(lastStatus(t.pill)).toEqual(['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }]);
    // Copied: nothing is pending any more, so the next refusal says why.
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(lastStatus(t.pill)).toEqual([notice, { tone: 'info', sticky: false, clickable: false }]);
  });

  const HOLD_STATUS = ['Return to the field to insert, or click here to copy.', { tone: 'info', sticky: true, clickable: true }];
  const ORPHAN_STATUS = [ORPHAN, { tone: 'error', sticky: true, terminal: true }];
  const COPIED = ['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }];
  const REFUSED = { [MSG.UPDATE_SETTINGS]: { success: false, error: 'Invalid settings.' } };

  /** Records and leaves the result held, because another frame or window has the focus. */
  async function holdResult(t) {
    await recordAndStop(t);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
    await flush();
    expect(lastStatus(t.pill)).toEqual(HOLD_STATUS);
    t.send.mockClear();
  }

  describe('and a failed menu save (V35)', () => {
    it.each([
      ['refused', REFUSED],
      ['unanswered', { [MSG.UPDATE_SETTINGS]: null }],
    ])('a failed menu save leaves a click-to-copy status up when %s', async (_name, replies) => {
      const t = setup({ insert: 'failed', replies });
      await strandResult(t);
      const statuses = t.pill.setStatus.mock.calls.length;
      await t.controller.choose({ provider: 'gemini' });
      expect(t.send).toHaveBeenCalledTimes(1);
      expect(t.pill.setStatus).toHaveBeenCalledTimes(statuses);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
      expect(lastStatus(t.pill)).toEqual(COPIED);
    });

    it('a failed menu save leaves a held-result status up', async () => {
      const t = setup({ replies: REFUSED });
      await holdResult(t);
      const statuses = t.pill.setStatus.mock.calls.length;
      await t.controller.choose({ provider: 'gemini' });
      expect(t.pill.setStatus).toHaveBeenCalledTimes(statuses);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    });

    it('a failed menu save still reports with no copy pending', async () => {
      const t = setup({ insert: 'failed', replies: REFUSED });
      await strandResult(t);
      await t.controller.copyLast();
      await t.controller.choose({ provider: 'gemini' });
      expect(lastStatus(t.pill)).toEqual(['Invalid settings.', { tone: 'error', sticky: false, clickable: false }]);
    });
  });

  describe('on a page orphaned under it (V35)', () => {
    it('an orphaned page keeps a click-to-copy status, and its click copies', async () => {
      const t = setup({ insert: 'failed' });
      await strandResult(t);
      const statuses = t.pill.setStatus.mock.calls.length;
      t.pill.clearStatus.mockClear();
      t.controller.orphaned();
      expect(t.pill.setStatus).toHaveBeenCalledTimes(statuses);
      expect(t.pill.clearStatus).not.toHaveBeenCalled();
      expect(t.pill.hide).not.toHaveBeenCalled();
      expect(await t.controller.copyLast()).toBe(true);
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    });

    it('the orphan notice follows that click', async () => {
      const t = setup({ insert: 'failed' });
      await strandResult(t);
      t.controller.orphaned();
      expect(lastStatus(t.pill)).toEqual(COPY_STATUS);
      await t.controller.copyLast();
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
      vi.advanceTimersByTime(60000);
      await flush();
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
      expect(t.pill.hide).not.toHaveBeenCalled();
    });

    it('an orphaned page with a held result offers the same', async () => {
      const t = setup();
      await holdResult(t);
      const statuses = t.pill.setStatus.mock.calls.length;
      t.controller.orphaned();
      expect(t.pill.setStatus).toHaveBeenCalledTimes(statuses);
      await t.controller.onWindowFocus();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
    });

    it('a copy that fails on an orphaned page can be clicked again', async () => {
      const t = setup({ insert: 'failed' });
      await strandResult(t);
      t.controller.orphaned();
      t.deps.copyText.mockResolvedValueOnce(false);
      expect(await t.controller.copyLast()).toBe(false);
      expect(lastStatus(t.pill)).toEqual(COPY_FAILED);
      expect(await t.controller.copyLast()).toBe(true);
      expect(t.deps.copyText).toHaveBeenCalledTimes(2);
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
    });

    it('a copy running when the page is orphaned brings the notice', async () => {
      const t = setup({ insert: 'failed' });
      await strandResult(t);
      const pending = deferred();
      t.deps.copyText.mockImplementationOnce(() => pending.promise);
      const click = t.controller.copyLast();
      await flush();
      t.controller.orphaned();
      pending.resolve(true);
      await click;
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
    });

    it.each([
      ['copied', true],
      ['failed', false],
    ])('on the real pill the notice stands when a second click running behind the first %s', async (_name, secondCopied) => {
      const t = setup({ insert: 'failed' });
      const pill = new Pill({}, { shadowMode: 'open' });
      const controller = createController({ ...t.deps, pill });
      const status = () => pill.root.querySelector('[role="status"]');
      try {
        await recordAndStop({ controller });
        controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
        await flush();
        controller.orphaned();
        expect(status().textContent).toBe(CLICK_TO_COPY);
        const first = deferred();
        const second = deferred();
        t.deps.copyText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
        const clicks = [controller.copyLast(), controller.copyLast()];
        await flush();
        first.resolve(true);
        await clicks[0];
        expect(status().textContent).toBe(ORPHAN);
        second.resolve(secondCopied);
        await clicks[1];
        vi.advanceTimersByTime(60000);
        await flush();
        expect(status().textContent).toBe(ORPHAN);
        expect(status().hasAttribute('data-clickable')).toBe(false);
      } finally {
        pill.destroy();
      }
    });

    it('nothing else works: a press, a REC click or a menu choice starts nothing', async () => {
      const t = setup({ insert: 'failed' });
      await strandResult(t);
      t.controller.orphaned();
      const statuses = t.pill.setStatus.mock.calls.length;
      await t.controller.press();
      await t.controller.toggle();
      await t.controller.choose({ provider: 'gemini' });
      expect(t.send).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.controller.state).toBe('idle');
      expect(t.pill.setStatus).toHaveBeenCalledTimes(statuses);
    });

    it('a result already placed gives the notice at once', async () => {
      const t = setup();
      await recordAndStop(t);
      t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null });
      await flush();
      t.controller.orphaned();
      expect(lastStatus(t.pill)).toEqual(ORPHAN_STATUS);
    });
  });
});

describe('a press while a result is still landing', () => {
  const STILL = ['Still processing', { tone: 'info', sticky: false, clickable: false }];
  const COPIED = ['Copied to clipboard.', { tone: 'success', sticky: false, clickable: false }];
  const CLICK = [CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }];
  const result = (text = 'hello') => ({ action: MSG.DICTATION_RESULT, success: true, text, raw: text, cost: 0, warning: null });

  /** A stopped recording whose result sits in a pending step. */
  async function landing(t, step) {
    const pending = deferred();
    t.deps[step].mockImplementationOnce(() => pending.promise);
    await recordAndStop(t);
    if (step === 'copyText') $('a').blur();
    t.controller.handleMessage(result());
    await flush();
    expect(t.deps[step]).toHaveBeenCalledTimes(1);
    expect(t.controller.state).toBe('idle');
    t.send.mockClear();
    return pending;
  }

  /** A press and its release, both inside the landing. */
  async function tap(t) {
    await t.controller.press();
    await t.controller.release({ held: false });
  }

  /** Neither way in starts anything, and each says so. */
  async function expectRefused(t) {
    for (const act of [() => tap(t), () => t.controller.toggle()]) {
      t.pill.setStatus.mockClear();
      await act();
      expect(lastStatus(t.pill)).toEqual(STILL);
    }
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  }

  it.each([
    ['inserted', 'done', (status) => expect(status[0]).toMatch(/^Done /)],
    ['failed', 'error', (status) => expect(status).toEqual(CLICK)],
  ])('during insertText: nothing starts, and the outcome %s stands', async (outcome, shown, expectStatus) => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await expectRefused(t);
    pending.resolve(outcome);
    await flush();
    expect(t.pill.setState).toHaveBeenLastCalledWith(shown);
    expectStatus(lastStatus(t.pill));
    expect(t.send).not.toHaveBeenCalled();
  });

  it('records on the next press once insertText is done', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await tap(t);
    pending.resolve('inserted');
    await flush();
    await t.controller.press();
    expect(t.send).toHaveBeenCalledWith({ action: MSG.START_RECORDING });
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
  });

  it('keeps a transcript that failed to insert: the next press copies that text', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await tap(t);
    pending.resolve('failed');
    await flush();
    await t.controller.press();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(t.send).not.toHaveBeenCalled();
  });

  it('during copyText in place: nothing starts, the outcome stands, and the next press records', async () => {
    const t = setup();
    const pending = await landing(t, 'copyText');
    await expectRefused(t);
    pending.resolve(true);
    await flush();
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it('a failed copyText in place leaves the click-to-copy over the refusal', async () => {
    const t = setup();
    const pending = await landing(t, 'copyText');
    await tap(t);
    pending.resolve(false);
    await flush();
    expect(lastStatus(t.pill)).toEqual(CLICK);
  });

  it('during copyLast from a click: nothing starts, the outcome stands, and the next press records', async () => {
    const t = setup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    t.send.mockClear();
    const pending = deferred();
    t.deps.copyText.mockImplementationOnce(() => pending.promise);
    const clicked = t.controller.copyLast();
    await flush();
    await expectRefused(t);
    pending.resolve(true);
    await clicked;
    expect(lastStatus(t.pill)).toEqual(COPIED);
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
  });

  it('during the copy of a press: a second press is refused and copies nothing more', async () => {
    const t = setup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    t.send.mockClear();
    const pending = deferred();
    t.deps.copyText.mockImplementationOnce(() => pending.promise);
    const first = t.controller.press();
    await flush();
    await expectRefused(t);
    expect(t.deps.copyText).toHaveBeenCalledTimes(1);
    pending.resolve(true);
    await first;
    expect(lastStatus(t.pill)).toEqual(COPIED);
  });

  it('two copies at once: the guard holds until the last one is done', async () => {
    const t = setup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    t.send.mockClear();
    const first = deferred();
    const second = deferred();
    t.deps.copyText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const clicks = [t.controller.copyLast(), t.controller.copyLast()];
    await flush();
    first.resolve(true);
    await clicks[0];
    await expectRefused(t);
    second.resolve(true);
    await clicks[1];
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it.each([
    ['the press that settles it', (t) => t.controller.press()],
    ['the window regaining focus', (t) => t.controller.onWindowFocus()],
  ])('a held result delivered by %s is guarded too', async (_name, settle) => {
    const t = setup();
    await recordAndStop(t);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage(result());
    await flush();
    expect(lastStatus(t.pill)[0]).toBe('Return to the field to insert, or click here to copy.');
    t.deps.hasFocus.mockReturnValue(true);
    t.send.mockClear();
    const pending = deferred();
    t.deps.insertText.mockImplementationOnce(() => pending.promise);
    settle(t);
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    await expectRefused(t);
    pending.resolve('inserted');
    await flush();
    expect(lastStatus(t.pill)[0]).toMatch(/^Done /);
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it('a throw from insertText leaves presses working', async () => {
    const t = setup();
    t.deps.insertText.mockRejectedValueOnce(new Error('page broke it'));
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    expect(lastStatus(t.pill)).toEqual(CLICK);
    await t.controller.press();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it('a throw from copyText in copyLast leaves presses working', async () => {
    const t = setup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    t.deps.copyText.mockRejectedValueOnce(new Error('no clipboard'));
    await expect(t.controller.copyLast()).rejects.toThrow('no clipboard');
    t.send.mockClear();
    await t.controller.press();
    expect(lastStatus(t.pill)).toEqual(COPIED);
    await t.controller.press();
    expect(t.controller.state).toBe('recording');
  });

  it('a press dropped by its release leaves no hold to stop the next recording', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await tap(t);
    pending.resolve('inserted');
    await flush();
    await t.controller.toggle();
    await t.controller.release({ held: true });
    expect(t.controller.state).toBe('recording');
  });

  it('a press during a landing starts when the landing ends with the chord down', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    expect(lastStatus(t.pill)).toEqual(STILL);
    expect(t.send).not.toHaveBeenCalled();
    pending.resolve('inserted');
    await flush();
    expect(t.send.mock.calls).toEqual([[{ action: MSG.START_RECORDING }]]);
    expect(t.controller.state).toBe('recording');
    expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
  });

  it.each([[false], [true]])('a release during the landing drops it (held %s)', async (held) => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    await t.controller.release({ held });
    pending.resolve('inserted');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  });

  it('a kept press stops on release like any hold', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    pending.resolve('inserted');
    await flush();
    await t.controller.release({ held: true });
    expect(t.controller.state).toBe('processing');
    expect(t.send).toHaveBeenLastCalledWith({ action: MSG.STOP_RECORDING });
  });

  it('a kept press released as a tap keeps recording, like any tap', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    pending.resolve('inserted');
    await flush();
    await t.controller.release({ held: false });
    expect(t.controller.state).toBe('recording');
  });

  it('a kept press on a pending click-to-copy copies, as any press', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    pending.resolve('failed');
    await flush();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(COPIED);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
  });

  it('a kept press binds the field focused when it starts, not the one the result landed in', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    $('b').focus();
    pending.resolve('inserted');
    await flush();
    expect(t.controller.state).toBe('recording');
    t.deps.insertText.mockClear();
    await t.controller.release({ held: true });
    t.controller.handleMessage(result('next'));
    await flush();
    expect(t.deps.insertText).toHaveBeenCalledWith($('b'), 'next');
  });

  it('a kept press waits for the last of two landings', async () => {
    const t = setup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(result());
    await flush();
    t.send.mockClear();
    const first = deferred();
    const second = deferred();
    t.deps.copyText.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    t.controller.copyLast();
    t.controller.copyLast();
    await flush();
    await t.controller.press();
    first.resolve(true);
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    second.resolve(true);
    await flush();
    expect(t.send.mock.calls).toEqual([[{ action: MSG.START_RECORDING }]]);
  });

  it('a REC click during a landing keeps nothing', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.toggle();
    pending.resolve('inserted');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('a landing that ends with the state no longer idle drops the kept press', async () => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing' });
    pending.resolve('inserted');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('processing');
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
    t.deps.insertText.mockResolvedValueOnce('inserted');
    t.controller.handleMessage(result());
    await flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it.each([
    ['orphaned', (t) => t.controller.orphaned()],
    ['torn down', (t) => t.controller.teardown()],
  ])('a kept press does not start on a controller %s during the landing', async (_, end) => {
    const t = setup();
    const pending = await landing(t, 'insertText');
    await t.controller.press();
    end(t);
    t.send.mockClear();
    pending.resolve('inserted');
    await flush();
    expect(t.send).not.toHaveBeenCalled();
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
      notice: { text: 'Microphone allowed. Try again.', tone: 'success' },
    });
    expect(lastStatus(t.pill)).toEqual(['Microphone allowed. Try again.', { tone: 'success', sticky: true, clickable: false }]);
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
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null, null);
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
    expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, { todayCost: 0.01, todaySessions: 2, totalCost: 0.5 }, null);
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

  it('copied false appends Not copied to Done', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage(result({ copied: false }));
    await flush();
    expect(lastStatus(t.pill)).toEqual(['Done $0.01 Not copied.', { tone: 'success', sticky: false, clickable: false }]);
    expect(t.pill.setState).toHaveBeenLastCalledWith('done');
  });

  it('copied true and copied null add nothing', async () => {
    for (const copied of [true, null]) {
      const t = setup();
      await recordAndStop(t);
      t.controller.handleMessage(result({ copied }));
      await flush();
      expect(lastStatus(t.pill)).toEqual(['Done $0.01', { tone: 'success', sticky: false, clickable: false }]);
    }
  });

  it('a warning result with copied false keeps the warning and adds Not copied', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage(result({ warning: 'Text model failed. Inserted the raw transcript.', copied: false }));
    await flush();
    expect(lastStatus(t.pill)).toEqual([
      'Text model failed. Inserted the raw transcript. Not copied.',
      { tone: 'warning', sticky: false, clickable: false },
    ]);
    expect(t.pill.setState).toHaveBeenLastCalledWith('done');
  });

  it.each([
    ['unverified', 'Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning', sticky: false, clickable: false }],
    ['clipboard', 'Copied to clipboard. The field could not be edited.', { tone: 'warning', sticky: false, clickable: false }],
    ['failed', CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }],
  ])('other outcomes never add it: %s', async (outcome, text, options) => {
    const t = setup({ insert: outcome });
    await recordAndStop(t);
    t.controller.handleMessage(result({ copied: false }));
    await flush();
    expect(lastStatus(t.pill)).toEqual([text, options]);
  });

  it('other outcomes never add it: the field lost focus', async () => {
    const t = setup();
    await recordAndStop(t, 'a');
    $('b').focus();
    t.controller.handleMessage(result({ copied: false }));
    await flush();
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
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

  it('a stop queued while starting ends idle with the too short status, before the stop reply', async () => {
    for (const queue of [(t) => t.controller.toggle(), (t) => t.controller.release({ held: true })]) {
      const start = deferred();
      const stopped = deferred();
      const t = setup({ replies: { [MSG.START_RECORDING]: () => start.promise, [MSG.STOP_RECORDING]: () => stopped.promise } });
      $('a').focus();
      t.controller.focusIn($('a'));
      const pending = t.controller.press();
      await queue(t);
      start.resolve({ ok: true });
      await flush();
      expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
      expect(t.controller.state).toBe('processing');
      t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'Too short, ignored', tone: 'warning' });
      await flush();
      expect(lastStatus(t.pill)).toEqual(['Too short, ignored', { tone: 'warning', sticky: false, clickable: false }]);
      expect(t.controller.state).toBe('idle');
      stopped.resolve({ ok: true });
      await pending;
      await flush();
      expect(t.controller.state).toBe('idle');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      vi.advanceTimersByTime(STATUS_MS.warning);
      expect(t.pill.setState).toHaveBeenLastCalledWith('idle');
    }
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

  it('refreshAnchor re-reads the field box', async () => {
    const moved = { ...RECT, top: 300, left: 800 };
    const rectOf = vi.fn(() => ({ ...RECT }));
    const t = setup({ rectOf });
    await recordAndStop(t, 'a');
    rectOf.mockClear().mockReturnValue(moved);
    t.controller.refreshAnchor();
    expect(rectOf).toHaveBeenCalledWith($('a'));
    expect(t.pill.reposition).toHaveBeenCalledWith(moved);
  });

  it('refreshAnchor does nothing with no field, or torn down', async () => {
    const t = setup();
    t.controller.refreshAnchor();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.controller.teardown();
    t.controller.refreshAnchor();
    expect(t.pill.reposition).not.toHaveBeenCalled();
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

  it('a held result keeps copied', async () => {
    const t = setup();
    await recordAndStop(t);
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage({ ...RESULT, copied: false });
    await flush();
    expect(lastStatus(t.pill)).toEqual(HOLD);
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'hello');
    expect(lastStatus(t.pill)).toEqual(['Done $0.01 Not copied.', { tone: 'success', sticky: false, clickable: false }]);
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
    t.deps.hasFocus.mockReturnValue(true);
    await t.controller.toggle();
    expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING, MSG.START_RECORDING]);
    await t.controller.onWindowFocus();
    expect(t.deps.insertText).not.toHaveBeenCalled();
  });

  it('a REC click here while a password field in another frame has the focus delivers the held result, then refuses', async () => {
    const t = setup();
    await holdResult(t);
    t.send.mockClear();
    await t.controller.toggle();
    expect(t.deps.insertText).not.toHaveBeenCalled();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)).toEqual(['The field lost focus. Text copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }]);
    // This frame cannot see the password field, only that it does not have the focus.
    await t.controller.toggle();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(['Click into the field you want to dictate into, then try again.', { tone: 'info', sticky: false, clickable: false }]);
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
    expect(t.actions().filter((action) => action !== MSG.PROCESSING_PING)).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING, MSG.START_RECORDING]);
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

describe('the processing ping (V52)', () => {
  const LOST = ['VoiceType restarted. Check the clipboard, or try again.', { tone: 'error', sticky: false, clickable: false }];
  const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0.012, warning: null };
  const pings = (t) => t.actions().filter((action) => action === MSG.PROCESSING_PING).length;
  const alive = (value) => ({ replies: { [MSG.PROCESSING_PING]: { alive: value } } });
  /** Pings keep coming for as long as the test waits: none means they stopped. */
  async function expectNoMorePings(t) {
    const before = pings(t);
    await vi.advanceTimersByTimeAsync(PING_MS * 20);
    expect(pings(t)).toBe(before);
  }

  it('pings every 5 s while processing and stops on every exit', async () => {
    expect(PING_MS).toBe(5000);
    const t = setup();
    await recordAndStop(t);
    expect(pings(t)).toBe(0);
    await vi.advanceTimersByTimeAsync(PING_MS - 1);
    expect(pings(t)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings(t)).toBe(1);
    await vi.advanceTimersByTimeAsync(PING_MS * 2);
    expect(pings(t)).toBe(3);

    t.controller.handleMessage(RESULT);
    await flush();
    await expectNoMorePings(t);
  });

  it('an auto-stop pings too', async () => {
    const t = setup();
    $('a').focus();
    await t.controller.toggle();
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing', reason: 'silence' });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(pings(t)).toBe(1);
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
    await expectNoMorePings(t);
  });

  it('a repeated processing state keeps one chain of pings', async () => {
    const t = setup();
    await recordAndStop(t);
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing' });
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(pings(t)).toBe(1);
  });

  it('a ping whose reply never comes does not stop the next', async () => {
    const t = setup({ replies: { [MSG.PROCESSING_PING]: () => new Promise(() => {}) } });
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS * 3);
    expect(pings(t)).toBe(3);
  });

  it.each([
    ['a stop with no session', (t) => t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' })],
    ['the orphan notice', (t) => t.controller.orphaned()],
    ['teardown', (t) => t.controller.teardown()],
    ['a failed result', (t) => t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'No.' })],
  ])('stops on %s', async (_, exit) => {
    const t = setup();
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS);
    exit(t);
    await flush();
    await expectNoMorePings(t);
  });

  it('stops when the watchdog gives up', async () => {
    const t = setup();
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS);
    expect(t.controller.state).toBe('idle');
    await expectNoMorePings(t);
  });

  it('stops when a stop finds no session in the worker', async () => {
    const t = setup({ replies: { [MSG.STOP_RECORDING]: { ok: false } } });
    $('a').focus();
    await t.controller.toggle();
    await t.controller.toggle();
    expect(t.controller.state).toBe('idle');
    await expectNoMorePings(t);
  });

  it('an alive reply re-arms the watchdog', async () => {
    const t = setup(alive(true));
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS * 3);
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setStatus).not.toHaveBeenCalled();
  });

  it('a not alive reply shows "VoiceType restarted. Check the clipboard, or try again."', async () => {
    const t = setup(alive(false));
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)).toEqual(LOST);
    await expectNoMorePings(t);
    // Nothing is left of the session: the next press records.
    await t.controller.toggle();
    expect(t.controller.state).toBe('recording');
  });

  it('alive replies stop holding processing at the ceiling, and the No response path runs', async () => {
    expect(PROCESSING_CEILING_MS).toBe(PROCESSING_TIMEOUT_MS + 120_000);
    const t = setup(alive(true));
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_CEILING_MS);
    expect(t.controller.state).toBe('processing');
    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS);
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)[0]).toBe('No response from VoiceType. Try again.');
    await expectNoMorePings(t);
  });

  it('a repeated processing state does not move the ceiling', async () => {
    const t = setup(alive(true));
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_CEILING_MS - PING_MS);
    t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'processing' });
    await vi.advanceTimersByTimeAsync(PING_MS + PROCESSING_TIMEOUT_MS);
    expect(t.controller.state).toBe('idle');
  });

  it('the next processing has a ceiling of its own', async () => {
    const t = setup(alive(true));
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_CEILING_MS);
    t.controller.handleMessage(RESULT);
    await flush();
    await vi.advanceTimersByTimeAsync(STATUS_MS.success);
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PROCESSING_CEILING_MS - PING_MS);
    expect(t.controller.state).toBe('processing');
  });

  it('a null reply changes nothing', async () => {
    const t = setup();
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS * 2);
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PROCESSING_TIMEOUT_MS - PING_MS * 2);
    expect(t.controller.state).toBe('idle');
    expect(lastStatus(t.pill)[0]).toBe('No response from VoiceType. Try again.');
  });

  it('a reply with no verdict changes nothing', async () => {
    const t = setup({ replies: { [MSG.PROCESSING_PING]: { success: false, error: 'Something went wrong. Try again.' } } });
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS);
    expect(t.controller.state).toBe('processing');
    expect(t.pill.setStatus).not.toHaveBeenCalled();
  });

  it('a reply after the exit changes nothing', async () => {
    const reply = deferred();
    const t = setup({ replies: { [MSG.PROCESSING_PING]: () => reply.promise } });
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS);
    t.controller.handleMessage(RESULT);
    await flush();
    reply.resolve({ alive: false });
    await flush();
    expect(t.pill.setStatus.mock.calls.map(([text]) => text)).not.toContain(LOST[0]);
  });

  it('a reply about the last run does not reach the next', async () => {
    const reply = deferred();
    const t = setup({ replies: { [MSG.PROCESSING_PING]: () => reply.promise } });
    await recordAndStop(t);
    await vi.advanceTimersByTimeAsync(PING_MS);
    t.controller.handleMessage(RESULT);
    await flush();
    await vi.advanceTimersByTimeAsync(STATUS_MS.success);
    await recordAndStop(t);
    reply.resolve({ alive: false });
    await flush();
    expect(t.controller.state).toBe('processing');
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

describe('hidden site', () => {
  const hidden = () => settings({ site: { hidePill: true, mode: null } });
  const shown = () => settings({ site: { hidePill: false, mode: null } });
  const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null };

  function hiddenSetup(options) {
    const t = setup(options);
    t.controller.setSettings(hidden());
    // The first answer settles once, with nothing shown yet.
    t.pill.hide.mockClear();
    return t;
  }

  it('no idle pill on focus', () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.show).not.toHaveBeenCalled();
  });

  it('the hotkey still records with the pill shown', async () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.press();
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 12 });
    expect(t.pill.visible).toBe(true);
    expect(t.pill.setState).toHaveBeenCalledWith('recording');
  });

  it('records from a page with no field, at the corner', async () => {
    const t = hiddenSetup();
    await t.controller.press();
    expect(t.pill.show).toHaveBeenCalledWith(null, { gap: 12 });
    expect(t.pill.setState).toHaveBeenCalledWith('recording');
  });

  it('a focus change while recording keeps the pill', async () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.press();
    $('plain').focus();
    t.controller.focusOut();
    vi.advanceTimersByTime(FOCUS_OUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.visible).toBe(true);
  });

  it('the pill goes away after the result', async () => {
    const t = hiddenSetup();
    await recordAndStop(t);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(t.pill)[0]).toBe('Done $0.00');
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STATUS_MS.success);
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.pill.visible).toBe(false);
    expect(document.activeElement).toBe($('a'));
  });

  it('statuses still show', async () => {
    const t = hiddenSetup();
    document.body.insertAdjacentHTML('beforeend', '<input id="secret" type="password">');
    $('secret').focus();
    await t.controller.press();
    expect(t.pill.show).toHaveBeenCalled();
    expect(lastStatus(t.pill)[0]).toBe('VoiceType does not record in password fields.');
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STATUS_MS.info);
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.pill.visible).toBe(false);
  });

  it('a sticky click-to-copy stays', async () => {
    const t = hiddenSetup({ insert: 'failed' });
    await recordAndStop(t);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(t.pill)[0]).toBe(CLICK_TO_COPY);
    t.controller.focusOut();
    vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
    expect(t.pill.hide).not.toHaveBeenCalled();
    await t.controller.copyLast();
    vi.advanceTimersByTime(STATUS_MS.success);
    expect(t.pill.hide).toHaveBeenCalled();
  });

  it('hiding while the idle pill shows removes it', () => {
    const t = setup();
    t.controller.setSettings(shown());
    $('a').focus();
    t.controller.focusIn($('a'));
    expect(t.pill.visible).toBe(true);
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: hidden() });
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.pill.visible).toBe(false);
  });

  it('unhiding shows the pill at the focused field', () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: shown() });
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 12 });
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));
  });

  it('a change that leaves the rule as it is does nothing', () => {
    const t = setup();
    t.controller.setSettings(shown());
    $('a').focus();
    t.controller.focusIn($('a'));
    t.pill.show.mockClear();
    $('plain').focus();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: shown() });
    expect(t.pill.hide).not.toHaveBeenCalled();
    expect(t.pill.show).not.toHaveBeenCalled();
  });

  it('a change while recording waits', async () => {
    const t = setup();
    t.controller.setSettings(shown());
    await recordAndStop(t);
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: hidden() });
    expect(t.pill.hide).not.toHaveBeenCalled();
    t.controller.handleMessage(RESULT);
    await flush();
    expect(t.pill.hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STATUS_MS.success);
    expect(t.pill.hide).toHaveBeenCalled();
  });

  it('a status moves with focus on a hidden site', async () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    t.deps.hasFocus.mockReturnValue(false);
    await t.controller.press();
    t.deps.hasFocus.mockReturnValue(true);
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));
    $('b').focus();
    t.controller.focusIn($('b'));
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('b'), expect.any(Function));
  });

  describe('a field scrolled out of view', () => {
    const OFFSCREEN = { ...RECT, top: -500 };
    const noop = () => {};

    /** The real pill: only it tells a pill shown offscreen from one that is hidden. */
    function withRealPill() {
      const t = setup();
      let box = RECT;
      let onChange = null;
      const pill = new Pill({
        onRec: noop, onStatusClick: noop, onMenuOpen: noop, onMode: noop, onUseActive: noop, onProvider: noop, onTargetLang: noop,
      }, { shadowMode: 'open' });
      const controller = createController({
        ...t.deps,
        pill,
        rectOf: () => ({ ...box }),
        watchAnchor: (_, fn) => {
          onChange = fn;
          return () => { onChange = null; };
        },
      });
      const scroll = (next) => {
        box = next;
        onChange?.();
      };
      return { controller, pill, scroll, watching: () => onChange !== null };
    }

    afterEach(() => {
      document.querySelectorAll('voicetype-host').forEach((el) => el.remove());
    });

    it('does not bring the pill back after the status ended', async () => {
      const t = withRealPill();
      t.controller.setSettings(hidden());
      await recordAndStop(t);
      t.controller.handleMessage(RESULT);
      await flush();
      t.scroll(OFFSCREEN);
      vi.advanceTimersByTime(STATUS_MS.success);
      expect(t.watching()).toBe(false);
      t.scroll(RECT);
      expect(t.pill.visible).toBe(false);
    });

    it('does not bring back an idle pill that a hide push found offscreen', () => {
      const t = withRealPill();
      t.controller.setSettings(shown());
      $('a').focus();
      t.controller.focusIn($('a'));
      t.scroll(OFFSCREEN);
      expect(t.pill.visible).toBe(false);
      t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: hidden() });
      t.scroll(RECT);
      expect(t.pill.visible).toBe(false);
    });

    it('leaving Minimal with the focus elsewhere shows no pill at the old field', () => {
      const t = withRealPill();
      t.controller.setSettings(settings({ pillStyle: 'minimal' }));
      $('a').focus();
      t.controller.focusIn($('a'));
      $('plain').focus();
      t.controller.focusOut();
      vi.advanceTimersByTime(FOCUS_OUT_MS);
      t.controller.setSettings(settings({ pillStyle: 'dot' }));
      expect(t.pill.visible).toBe(false);
      expect(t.watching()).toBe(false);
    });

    it('a status carried out of Minimal does not leave a watcher on the old field', async () => {
      const t = withRealPill();
      t.controller.setSettings(settings({ pillStyle: 'minimal' }));
      await recordAndStop(t);
      t.controller.handleMessage(RESULT);
      await flush();
      $('plain').focus();
      t.scroll(OFFSCREEN);
      t.controller.setSettings(settings({ pillStyle: 'dot' }));
      vi.advanceTimersByTime(STATUS_MS.success);
      expect(t.watching()).toBe(false);
      t.scroll(RECT);
      expect(t.pill.visible).toBe(false);
    });
  });

  it('keeps the field focused last for delivery across frames', async () => {
    const t = hiddenSetup();
    $('a').focus();
    t.controller.focusIn($('a'));
    await t.controller.press();
    await t.controller.toggle();
    // Chromium blanks a frame's activeElement when another frame takes the focus.
    $('a').blur();
    t.deps.hasFocus.mockReturnValue(false);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(t.pill)[0]).toBe('Return to the field to insert, or click here to copy.');
  });
});

describe('presentation', () => {
  const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null };
  const PASSWORD_NOTICE = 'VoiceType does not record in password fields.';
  const minimal = () => settings({ pillStyle: 'minimal' });
  const dot = () => settings({ pillStyle: 'dot' });

  function focusField(t, id = 'a') {
    $(id).focus();
    t.controller.focusIn($(id));
  }

  it('applies the stored style', () => {
    const t = setup();
    t.controller.setSettings(settings({ pillStyle: 'pill' }));
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('pill');
  });

  it.each(['pill', 'dot', 'minimal'])('a hidden site is Minimal whatever the style (%s)', (pillStyle) => {
    const t = setup();
    t.controller.setSettings(settings({ pillStyle, site: { hidePill: true, mode: null } }));
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('minimal');
  });

  it('a site without the rule keeps the stored style', () => {
    const t = setup();
    t.controller.setSettings(settings({ pillStyle: 'pill', site: { hidePill: false, mode: null } }));
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('pill');
  });

  it('a missing style falls back to dot', () => {
    const t = setup();
    t.controller.setSettings(settings());
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('dot');
  });

  it('settings that are refused set no style', () => {
    const t = setup();
    t.controller.setSettings({ pillStyle: 'pill' });
    expect(t.pill.setStyle).not.toHaveBeenCalled();
  });

  it('Minimal shows no idle pill', () => {
    const t = setup();
    t.controller.setSettings(minimal());
    focusField(t);
    expect(t.pill.show).not.toHaveBeenCalled();
  });

  it('Minimal still records', async () => {
    const t = setup();
    t.controller.setSettings(minimal());
    focusField(t);
    await t.controller.press();
    expect(t.actions()).toEqual([MSG.START_RECORDING]);
    expect(t.pill.setState).toHaveBeenCalledWith('recording');
    expect(t.pill.show).toHaveBeenCalled();
  });

  it('Minimal shows a refusal', async () => {
    const t = setup();
    t.controller.setSettings(minimal());
    document.body.insertAdjacentHTML('beforeend', '<input id="secret" type="password">');
    $('secret').focus();
    await t.controller.press();
    expect(lastStatus(t.pill)[0]).toBe(PASSWORD_NOTICE);
    expect(t.actions()).toEqual([]);
  });

  it('switching to Minimal hides an idle pill', () => {
    const t = setup();
    t.controller.setSettings(dot());
    focusField(t);
    expect(t.pill.visible).toBe(true);
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: minimal() });
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('minimal');
    expect(t.pill.hide).toHaveBeenCalled();
    expect(t.pill.visible).toBe(false);
  });

  it('switching back shows it at the focused field', () => {
    const t = setup();
    t.controller.setSettings(minimal());
    focusField(t);
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: dot() });
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('dot');
    expect(t.pill.show).toHaveBeenCalledWith(RECT, { gap: 12 });
    expect(t.deps.watchAnchor).toHaveBeenCalledWith($('a'), expect.any(Function));
  });

  it('a switch between the visible styles leaves the pill where it is', () => {
    const t = setup();
    t.controller.setSettings(dot());
    focusField(t);
    t.pill.show.mockClear();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: settings({ pillStyle: 'pill' }) });
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('pill');
    expect(t.pill.show).not.toHaveBeenCalled();
    expect(t.pill.hide).not.toHaveBeenCalled();
  });

  it('a style change while recording keeps the state', async () => {
    const t = setup();
    t.controller.setSettings(dot());
    focusField(t);
    await t.controller.press();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: minimal() });
    expect(t.pill.setStyle).toHaveBeenLastCalledWith('minimal');
    expect(t.controller.state).toBe('recording');
    expect(t.pill.hide).not.toHaveBeenCalled();
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: dot() });
    expect(t.controller.state).toBe('recording');
    expect(t.pill.hide).not.toHaveBeenCalled();
  });

  it('a pinned click-to-copy survives a switch to Minimal', async () => {
    const t = setup({ insert: 'failed' });
    t.controller.setSettings(dot());
    await recordAndStop(t);
    t.controller.handleMessage(RESULT);
    await flush();
    expect(lastStatus(t.pill)[0]).toBe(CLICK_TO_COPY);
    t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: minimal() });
    expect(t.pill.hide).not.toHaveBeenCalled();
    await t.controller.copyLast();
    expect(t.deps.copyText).toHaveBeenCalledWith('hello');
    expect(lastStatus(t.pill)[0]).toBe('Copied to clipboard.');
  });

  describe('settle hides a pill whose field scrolled out', () => {
    it.each([
      ['the focus moved off the field', () => $('plain').focus()],
      ['another frame has the focus', (t) => t.deps.hasFocus.mockReturnValue(false)],
    ])('%s', (_, moveFocus) => {
      const t = setup();
      t.controller.setSettings(dot());
      focusField(t);
      const onChange = t.deps.watchAnchor.mock.calls[0][1];
      t.pill.visible = false;
      moveFocus(t);
      t.controller.focusOut();
      vi.advanceTimersByTime(FOCUS_OUT_MS);
      expect(t.pill.hide).toHaveBeenCalled();
      expect(t.unwatch).toHaveBeenCalled();
      onChange();
      expect(t.pill.reposition).not.toHaveBeenCalled();
    });
  });
});

describe('menu choices', () => {
  const siteRule = (site) => settings({ site });
  const SAVED = { [MSG.SET_SITE_MODE]: { success: true } };

  it('chooseMode changes the active mode with no site', async () => {
    const t = setup();
    t.controller.setSettings(settings());
    await t.controller.chooseMode('email');
    expect(t.sent).toEqual([{ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } }]);
  });

  it('chooseMode changes the active mode with a hide-only rule (V9)', async () => {
    const t = setup();
    t.controller.setSettings(siteRule({ hidePill: true, mode: null }));
    await t.controller.chooseMode('email');
    expect(t.sent).toEqual([{ action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } }]);
  });

  it('chooseMode updates the rule on a site with a mode rule', async () => {
    const t = setup({ replies: SAVED });
    t.controller.setSettings(siteRule({ hidePill: false, mode: 'email' }));
    await t.controller.chooseMode('default');
    expect(t.sent).toEqual([{ action: MSG.SET_SITE_MODE, mode: 'default' }]);
    expect(t.pill.setStatus).not.toHaveBeenCalled();
  });

  it('useActiveMode clears the rule mode', async () => {
    const t = setup({ replies: SAVED });
    t.controller.setSettings(siteRule({ hidePill: false, mode: 'email' }));
    await t.controller.useActiveMode();
    expect(t.sent).toEqual([{ action: MSG.SET_SITE_MODE, mode: null }]);
  });

  it('a refused site mode shows the error', async () => {
    const t = setup({ replies: { [MSG.SET_SITE_MODE]: { success: false, error: 'Not available on this page.' } } });
    t.controller.setSettings(siteRule({ hidePill: false, mode: 'email' }));
    await t.controller.chooseMode('default');
    expect(lastStatus(t.pill)).toEqual(['Not available on this page.', { tone: 'error', sticky: false, clickable: false }]);
    t.pill.setStatus.mockClear();
    await t.controller.useActiveMode();
    expect(lastStatus(t.pill)[0]).toBe('Not available on this page.');
  });

  it('a site mode with no reply says so', async () => {
    const t = setup();
    t.controller.setSettings(siteRule({ hidePill: false, mode: 'email' }));
    await t.controller.useActiveMode();
    expect(lastStatus(t.pill)).toEqual(['VoiceType could not reach its background service. Try again.', { tone: 'error', sticky: false, clickable: false }]);
  });

  it('an orphaned or removed instance sends nothing', async () => {
    const t = setup();
    t.controller.setSettings(siteRule({ hidePill: false, mode: 'email' }));
    t.controller.orphaned();
    await t.controller.chooseMode('default');
    await t.controller.useActiveMode();
    expect(t.sent).toEqual([]);
  });

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

describe('Last dictation', () => {
  const ENTRY = { raw: 'raw words', text: 'refined words' };
  const STILL = ['Still processing', { tone: 'info', sticky: false, clickable: false }];
  const INSERTED = ['Inserted.', { tone: 'success', sticky: false, clickable: false }];
  const COPIED = ['Copied to clipboard.', { tone: 'info', sticky: false, clickable: false }];
  const RESTORED = ['Original text restored.', { tone: 'success', sticky: false, clickable: false }];
  const ORIGINAL = ['Original text copied.', { tone: 'info', sticky: false, clickable: false }];
  const CLICK = [CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }];
  const refined = (over = {}) => ({ action: MSG.DICTATION_RESULT, success: true, ...ENTRY, cost: 0.01, warning: null, ...over });

  /** insertText as the ladder ends for a field: over the selection, caret after it. */
  function writing(t, outcome = 'inserted') {
    t.deps.insertText.mockImplementation(async (el, text) => {
      if (outcome === 'inserted') el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
      return outcome;
    });
  }

  /** A refined dictation landed in field `id`, with `recent` as the menu would load it. */
  async function dictated(t, id = 'a') {
    writing(t);
    await recordAndStop(t, id);
    t.controller.handleMessage(refined());
    await flush();
    expect($(id).value).toContain(ENTRY.text);
    t.controller.setRecent(ENTRY);
    t.deps.insertText.mockClear();
    t.deps.copyText.mockClear();
    t.pill.setStatus.mockClear();
  }

  describe('setRecent', () => {
    it('tells the menu whether a mode changed the text, and no text', () => {
      const t = setup();
      const good = settings();
      t.controller.setSettings(good);
      t.controller.setRecent(ENTRY);
      expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null, { refined: true });
      t.controller.setRecent({ raw: 'same', text: 'same' });
      expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null, { refined: false });
      t.controller.setRecent(null);
      expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null, null);
    });

    it.each([
      ['a space', 'hello  world', 'hello world'],
      ['a line break', 'hello\nworld', 'hello world'],
      ['a no-break space', 'hello\u00A0world', 'hello world'],
      ['a trailing newline', 'hello world', 'hello world\n'],
    ])('offers no Undo when the edit only changed whitespace: %s', (_, raw, text) => {
      const t = setup();
      const good = settings();
      t.controller.setSettings(good);
      t.controller.setRecent({ raw, text });
      expect(t.pill.renderMenu).toHaveBeenLastCalledWith(good, null, { refined: false });
    });

    it('a null entry makes every action inert, as after a Clear', async () => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      t.controller.setRecent(null);
      $('a').focus();
      for (const action of ['insert', 'copy', 'undo']) await t.controller.historyAction(action);
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('survives a settings push', () => {
      const t = setup();
      t.controller.setSettings(settings());
      t.controller.setRecent(ENTRY);
      const next = settings({ provider: 'gemini' });
      t.controller.handleMessage({ action: MSG.SETTINGS_CHANGED, settings: next });
      expect(t.pill.renderMenu).toHaveBeenLastCalledWith(next, null, { refined: true });
    });

    it.each([
      ['undefined', undefined], ['a string', 'text'], ['a number', 1], ['an array', []],
      ['no raw', { text: 'x' }], ['no text', { raw: 'x' }], ['raw not a string', { raw: 1, text: 'x' }],
      ['text not a string', { raw: 'x', text: {} }], ['empty text', { raw: 'x', text: '' }],
    ])('ignores a malformed recent entry: %s', async (_, bad) => {
      const t = setup();
      t.controller.setSettings(settings());
      t.controller.setRecent(ENTRY);
      t.controller.setRecent(bad);
      expect(t.pill.renderMenu.mock.lastCall[2]).toBeNull();
      await t.controller.historyAction('copy');
      expect(t.deps.copyText).not.toHaveBeenCalled();
    });
  });

  describe('Insert', () => {
    it('goes to the field focused now, not the one the dictation went to', async () => {
      const t = setup();
      await dictated(t, 'a');
      writing(t);
      $('b').focus();
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect(t.deps.insertText).toHaveBeenCalledWith($('b'), ENTRY.text);
      expect($('b').value).toBe(ENTRY.text);
      expect($('a').value).toBe(ENTRY.text);
    });

    it('reads "Inserted." and no cost', async () => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('insert');
      expect(lastStatus(t.pill)).toEqual(INSERTED);
      expect(t.pill.setState).toHaveBeenLastCalledWith('done');
    });

    it('copies with a password field focused', async () => {
      document.body.innerHTML = '<input id="pw" type="password"><input id="revealed" type="text" autocomplete="new-password">';
      for (const id of ['pw', 'revealed']) {
        const t = setup();
        t.controller.setRecent(ENTRY);
        $(id).focus();
        await t.controller.historyAction('insert');
        expect(t.deps.insertText).not.toHaveBeenCalled();
        expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.text);
        expect(lastStatus(t.pill)).toEqual(COPIED);
        expect($(id).value).toBe('');
      }
    });

    it('copies with nothing focused', async () => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.text);
      expect(lastStatus(t.pill)).toEqual(COPIED);
    });

    it('copies with a read-only field focused', async () => {
      document.body.innerHTML = '<textarea id="ro" readonly></textarea>';
      const t = setup();
      t.controller.setRecent(ENTRY);
      $('ro').focus();
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(COPIED);
    });

    it.each([
      ['unverified', 'Could not confirm the insert. The text is also on the clipboard.', 'warning'],
      ['clipboard', 'Copied to clipboard. The field could not be edited.', 'warning'],
    ])('an %s outcome reports as for a dictation', async (outcome, text, tone) => {
      const t = setup({ insert: outcome });
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('insert');
      expect(lastStatus(t.pill)).toEqual([text, { tone, sticky: false, clickable: false }]);
    });

    it('a failed insert offers click-to-copy with this text', async () => {
      const t = setup({ insert: 'failed' });
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('insert');
      expect(lastStatus(t.pill)).toEqual(CLICK);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.text);
    });

    it('a throwing insert offers click-to-copy too', async () => {
      const t = setup();
      t.deps.insertText.mockRejectedValue(new Error('boom'));
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('insert');
      expect(lastStatus(t.pill)).toEqual(CLICK);
    });
  });

  describe('Copy', () => {
    it('copies and says so', async () => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('copy');
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.text);
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(COPIED);
    });

    it('a failed Copy offers click-to-copy with that text', async () => {
      const t = setup({ copy: false });
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('copy');
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.deps.copyText.mockClear();
      t.deps.copyText.mockResolvedValue(true);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.text);
    });

    it('leaves the mark, so Undo still works in place', async () => {
      const t = setup();
      await dictated(t);
      await t.controller.historyAction('copy');
      writing(t);
      await t.controller.historyAction('undo');
      expect($('a').value).toBe(ENTRY.raw);
    });
  });

  describe('Undo AI edit', () => {
    it('replaces in place when the mark holds', async () => {
      const t = setup();
      await dictated(t);
      writing(t);
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect(t.deps.insertText).toHaveBeenCalledWith($('a'), ENTRY.raw);
      expect($('a').value).toBe(ENTRY.raw);
      expect(lastStatus(t.pill)).toEqual(RESTORED);
      expect(t.deps.copyText).not.toHaveBeenCalled();
    });

    it('keeps what is around the text', async () => {
      const t = setup();
      $('a').value = 'before  after';
      $('a').setSelectionRange(7, 7);
      await dictated(t);
      writing(t);
      await t.controller.historyAction('undo');
      expect($('a').value).toBe(`before ${ENTRY.raw} after`);
    });

    it('copies raw when the mark no longer holds', async () => {
      const t = setup();
      await dictated(t);
      $('a').value = `typed ${ENTRY.text}`;
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect($('a').value).toBe(`typed ${ENTRY.text}`);
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.raw);
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when the same text was typed before it, so the offsets still read true', async () => {
      const t = setup();
      writing(t);
      await recordAndStop(t);
      t.controller.handleMessage(refined({ text: 'OK.', raw: 'okay' }));
      await flush();
      t.controller.setRecent({ text: 'OK.', raw: 'okay' });
      t.deps.insertText.mockClear();
      t.deps.copyText.mockClear();
      expect($('a').value).toBe('OK.');
      $('a').value = 'OK.OK.';
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect($('a').value).toBe('OK.OK.');
      expect(t.deps.copyText).toHaveBeenCalledWith('okay');
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw after a reload, with no mark', async () => {
      const t = setup();
      $('a').value = ENTRY.text;
      $('a').focus();
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect($('a').value).toBe(ENTRY.text);
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.raw);
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when another field has focus', async () => {
      const t = setup();
      await dictated(t);
      $('b').focus();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.raw);
      expect($('a').value).toBe(ENTRY.text);
      expect($('b').value).toBe('');
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when nothing has focus', async () => {
      const t = setup();
      await dictated(t);
      $('a').blur();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when another frame or window has the focus', async () => {
      const t = setup();
      await dictated(t);
      t.deps.hasFocus.mockReturnValue(false);
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when the field left the document', async () => {
      // Still the active element as this frame last saw it, so only the connection check can tell.
      let gone = null;
      const t = setup({ activeElement: () => gone ?? deepActiveElement(document) });
      await dictated(t);
      gone = $('a');
      gone.remove();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('copies raw when the field turned into a password field or read-only', async () => {
      for (const change of [(el) => { el.type = 'password'; }, (el) => { el.readOnly = true; }]) {
        document.body.innerHTML = '<input id="a" type="text">';
        const t = setup();
        await dictated(t);
        change($('a'));
        await t.controller.historyAction('undo');
        expect(t.deps.insertText).not.toHaveBeenCalled();
        expect(lastStatus(t.pill)).toEqual(ORIGINAL);
      }
    });

    it('copies raw when the entry is not the one inserted here', async () => {
      const t = setup();
      await dictated(t);
      // The same site in another tab dictated since: this field holds an older result.
      t.controller.setRecent({ raw: 'other raw', text: 'other text' });
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith('other raw');
    });

    it('copies raw when only the text of the entry matches', async () => {
      const t = setup();
      await dictated(t);
      t.controller.setRecent({ raw: 'other raw', text: ENTRY.text });
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith('other raw');
    });

    it('copies raw with no mark for an email input, which has no offsets', async () => {
      document.body.innerHTML = '<input id="a" type="email">';
      const t = setup();
      t.deps.insertText.mockImplementation(async (el, text) => { el.value = text; return 'inserted'; });
      await recordAndStop(t);
      t.controller.handleMessage(refined());
      await flush();
      t.controller.setRecent(ENTRY);
      t.deps.insertText.mockClear();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenLastCalledWith(ENTRY.raw);
    });

    it('a field whose value cannot be read after a good insert keeps the status, with no mark', async () => {
      const t = setup();
      $('a').value = ENTRY.text;
      $('a').setSelectionRange(ENTRY.text.length, ENTRY.text.length);
      await recordAndStop(t);
      const el = $('a');
      t.deps.insertText.mockImplementation(async () => {
        Object.defineProperty(el, 'value', { get: () => 42, configurable: true });
        return 'inserted';
      });
      t.controller.handleMessage(refined());
      await flush();
      expect(t.pill.setState).toHaveBeenLastCalledWith('done');
      expect(lastStatus(t.pill)[0]).toMatch(/^Done /);
      delete el.value;
      t.controller.setRecent(ENTRY);
      t.deps.insertText.mockClear();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenLastCalledWith(ENTRY.raw);
    });

    it('marks text the menu inserted too', async () => {
      const t = setup();
      writing(t);
      t.controller.setRecent(ENTRY);
      $('a').focus();
      await t.controller.historyAction('insert');
      await t.controller.historyAction('undo');
      expect($('a').value).toBe(ENTRY.raw);
      expect(lastStatus(t.pill)).toEqual(RESTORED);
    });

    it('a second Undo copies: the mark goes with the first, even when Ctrl+Z put the text back', async () => {
      const t = setup();
      await dictated(t);
      writing(t);
      await t.controller.historyAction('undo');
      $('a').value = ENTRY.text;
      $('a').setSelectionRange(ENTRY.text.length, ENTRY.text.length);
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect($('a').value).toBe(ENTRY.text);
      expect(lastStatus(t.pill)).toEqual(ORIGINAL);
    });

    it('a new result clears the mark, even one that does not land in a field', async () => {
      const t = setup();
      await dictated(t);
      $('a').blur();
      t.controller.handleMessage(refined({ text: 'next', raw: 'next raw' }));
      await flush();
      $('a').focus();
      t.controller.setRecent(ENTRY);
      t.deps.insertText.mockClear();
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
    });

    it('a failed result keeps the mark: the field did not change', async () => {
      const t = setup();
      await dictated(t);
      t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'No' });
      await flush();
      writing(t);
      await t.controller.historyAction('undo');
      expect($('a').value).toBe(ENTRY.raw);
    });

    it.each([
      ['unverified', 'Could not confirm the insert. The text is also on the clipboard.', 'warning'],
      ['clipboard', 'Copied to clipboard. The field could not be edited.', 'warning'],
    ])('an %s outcome reports as for a dictation', async (outcome, text, tone) => {
      const t = setup();
      await dictated(t);
      writing(t, outcome);
      await t.controller.historyAction('undo');
      expect(lastStatus(t.pill)).toEqual([text, { tone, sticky: false, clickable: false }]);
    });

    it('a failed copy of raw offers click-to-copy holding raw', async () => {
      const t = setup();
      await dictated(t);
      $('a').blur();
      t.deps.copyText.mockResolvedValueOnce(false);
      await t.controller.historyAction('undo');
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.deps.copyText.mockClear();
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith(ENTRY.raw);
    });

    it('a failed replace offers click-to-copy holding raw', async () => {
      const t = setup();
      await dictated(t);
      writing(t, 'failed');
      await t.controller.historyAction('undo');
      expect(lastStatus(t.pill)).toEqual(CLICK);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenLastCalledWith(ENTRY.raw);
    });

    it('a throwing replace offers click-to-copy holding raw', async () => {
      const t = setup();
      await dictated(t);
      t.deps.insertText.mockRejectedValueOnce(new Error('boom'));
      await t.controller.historyAction('undo');
      expect(lastStatus(t.pill)).toEqual(CLICK);
    });

    it('never writes in place while it lands: a second action waits', async () => {
      const t = setup();
      await dictated(t);
      const pending = deferred();
      t.deps.insertText.mockImplementationOnce(() => pending.promise);
      const undo = t.controller.historyAction('undo');
      await flush();
      await t.controller.historyAction('undo');
      expect(lastStatus(t.pill)).toEqual(STILL);
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      pending.resolve('inserted');
      await undo;
    });

    it('a press during the undo is kept and starts after it', async () => {
      const t = setup();
      await dictated(t);
      const pending = deferred();
      t.deps.insertText.mockImplementationOnce(() => pending.promise);
      const undo = t.controller.historyAction('undo');
      await flush();
      await t.controller.press();
      const started = t.actions().filter((a) => a === MSG.START_RECORDING).length;
      pending.resolve('inserted');
      await undo;
      await flush();
      expect(t.actions().filter((a) => a === MSG.START_RECORDING)).toHaveLength(started + 1);
    });
  });

  describe('while not idle', () => {
    it.each(['insert', 'copy', 'undo'])('%s while recording reads "Still processing"', async (action) => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      $('a').focus();
      t.controller.focusIn($('a'));
      await t.controller.toggle();
      expect(t.controller.state).toBe('recording');
      await t.controller.historyAction(action);
      expect(lastStatus(t.pill)).toEqual(STILL);
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.controller.state).toBe('recording');
    });

    it('reads "Still processing" while processing and while a result lands', async () => {
      const t = setup();
      t.controller.setRecent(ENTRY);
      await recordAndStop(t);
      await t.controller.historyAction('copy');
      expect(lastStatus(t.pill)).toEqual(STILL);
      const pending = deferred();
      t.deps.insertText.mockImplementationOnce(() => pending.promise);
      t.controller.handleMessage(refined());
      await flush();
      expect(t.controller.state).toBe('idle');
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('insert');
      expect(lastStatus(t.pill)).toEqual(STILL);
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect(t.deps.copyText).not.toHaveBeenCalled();
      pending.resolve('inserted');
      await flush();
    });
  });

  describe('a transcript waiting on a click (V35)', () => {
    it('a click-to-copy status is settled first, as REC does: the action does not replace its text', async () => {
      const t = setup({ insert: 'failed' });
      await recordAndStop(t);
      t.controller.handleMessage(refined({ text: 'paid', raw: 'paid' }));
      await flush();
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.controller.setRecent(ENTRY);
      t.deps.insertText.mockClear();
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledTimes(1);
      expect(t.deps.copyText).toHaveBeenCalledWith('paid');
    });

    it('a dead clipboard offers the transcript once, and then Insert is reachable', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await recordAndStop(t);
      t.controller.handleMessage(refined({ text: 'paid', raw: 'paid' }));
      await flush();
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.controller.setRecent({ raw: 'paid', text: 'paid' });
      writing(t);
      t.deps.copyText.mockClear();

      await t.controller.historyAction('insert');
      expect(t.deps.copyText).toHaveBeenCalledWith('paid');
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);

      await t.controller.historyAction('insert');
      expect(t.deps.insertText).toHaveBeenCalledTimes(2);
      expect(t.deps.insertText).toHaveBeenLastCalledWith($('a'), 'paid');
      expect(lastStatus(t.pill)).toEqual(INSERTED);
    });

    /** A paid transcript on click-to-copy, offered once, with the clipboard dead. */
    async function copyFailed(t, recent) {
      await recordAndStop(t);
      t.controller.handleMessage(refined({ text: 'paid', raw: 'paid raw' }));
      await flush();
      t.controller.setRecent(recent);
      await t.controller.historyAction('copy');
      t.deps.insertText.mockClear();
      t.deps.copyText.mockClear();
      t.pill.setStatus.mockClear();
    }

    it.each(['insert', 'copy', 'undo'])('after a failed copy, %s of another text does nothing, and the transcript stays', async (action) => {
      const t = setup({ insert: 'failed', copy: false });
      await copyFailed(t, ENTRY);
      await t.controller.historyAction(action);
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.pill.setStatus).not.toHaveBeenCalled();

      t.deps.copyText.mockResolvedValue(true);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('paid');
    });

    it('after a failed copy, Undo of the same text does nothing: it would replace the text with raw', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await copyFailed(t, { raw: 'paid raw', text: 'paid' });
      await t.controller.historyAction('undo');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('after a failed copy, Insert of the same text goes ahead: it is a way out', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await copyFailed(t, { raw: 'paid raw', text: 'paid' });
      writing(t);
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).toHaveBeenCalledExactlyOnceWith($('a'), 'paid');
      expect(lastStatus(t.pill)).toEqual(INSERTED);
    });

    it('a copy that works goes back to offering the next pending one', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await recordAndStop(t);
      t.controller.handleMessage(refined({ text: 'paid', raw: 'paid' }));
      await flush();
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('copy');
      t.deps.copyText.mockClear();
      t.deps.copyText.mockResolvedValue(true);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('paid');
      await recordAndStop(t);
      t.deps.copyText.mockResolvedValueOnce(false);
      t.controller.handleMessage(refined({ text: 'paid again', raw: 'paid again' }));
      await flush();
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.controller.setRecent(ENTRY);
      t.deps.copyText.mockClear();
      await t.controller.historyAction('insert');
      expect(t.deps.copyText).toHaveBeenCalledWith('paid again');
    });

    it('a held result lands first: the action neither replaces it nor doubles it', async () => {
      const t = setup();
      writing(t);
      await recordAndStop(t);
      t.deps.hasFocus.mockReturnValue(false);
      t.controller.handleMessage(refined({ text: 'paid', raw: 'paid' }));
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      t.deps.hasFocus.mockReturnValue(true);
      t.controller.setRecent(ENTRY);
      await t.controller.historyAction('insert');
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect(t.deps.insertText).toHaveBeenCalledWith($('a'), 'paid');
      await t.controller.onWindowFocus();
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
    });
  });

  describe('a result while the menu is open', () => {
    const shown = (t) => t.pill.renderMenu.mock.lastCall[2];

    it('a result takes the older entry away, and its actions with it', async () => {
      const t = setup({ insert: 'inserted' });
      t.controller.setSettings(settings());
      await recordAndStop(t);
      t.controller.setRecent(ENTRY);
      expect(shown(t)).toEqual({ refined: true });

      t.controller.handleMessage(refined({ text: 'newer', raw: 'newer raw' }));
      await flush();
      expect(shown(t)).toBeNull();

      t.deps.insertText.mockClear();
      t.deps.copyText.mockClear();
      t.pill.setStatus.mockClear();
      for (const action of ['insert', 'copy', 'undo']) await t.controller.historyAction(action);
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('so does a result that waits to be held or copied', async () => {
      const t = setup();
      t.controller.setSettings(settings());
      await recordAndStop(t);
      t.controller.setRecent(ENTRY);
      t.deps.hasFocus.mockReturnValue(false);
      t.controller.handleMessage(refined({ text: 'newer', raw: 'newer raw' }));
      await flush();
      expect(shown(t)).toBeNull();
    });

    it('a failed result adds no entry, so the section stays', async () => {
      const t = setup();
      t.controller.setSettings(settings());
      await recordAndStop(t);
      t.controller.setRecent(ENTRY);
      t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'No' });
      await flush();
      expect(shown(t)).toEqual({ refined: true });
    });
  });

  it('does nothing with no entry, orphaned or torn down', async () => {
    const none = setup();
    await none.controller.historyAction('copy');
    expect(none.deps.copyText).not.toHaveBeenCalled();
    expect(none.pill.setStatus).not.toHaveBeenCalled();

    const orphan = setup();
    orphan.controller.setRecent(ENTRY);
    orphan.controller.orphaned();
    await orphan.controller.historyAction('copy');
    expect(orphan.deps.copyText).not.toHaveBeenCalled();

    const dead = setup();
    dead.controller.setRecent(ENTRY);
    dead.controller.teardown();
    await dead.controller.historyAction('copy');
    expect(dead.deps.copyText).not.toHaveBeenCalled();
  });
});

describe('edit', () => {
  const SAY = ['Say how to change the selection.', { tone: 'info', sticky: false, clickable: false }];
  const SELECT_FIRST = ['Select the text to edit first.', { tone: 'info', sticky: false, clickable: false }];
  const TOO_LONG = ['Selection too long to edit (10,000 characters at most).', { tone: 'info', sticky: false, clickable: false }];
  const CHANGED = ['Selection changed. Result copied to clipboard.', { tone: 'warning', sticky: false, clickable: false }];
  const FAILED_TEXT = 'Could not edit the selection. Click here to copy what you said.';
  const FAILED = [FAILED_TEXT, { tone: 'error', sticky: false, clickable: true }];
  const PASSWORD = ['VoiceType does not record in password fields.', { tone: 'info', sticky: false, clickable: false }];
  const CLICK = [CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true }];
  const REPLACED = 'edited words';
  const edited = (over = {}) => ({ action: MSG.DICTATION_RESULT, success: true, text: REPLACED, raw: 'make it shorter', cost: 0.01, warning: null, edit: true, ...over });
  const dictated = (text = 'hello') => ({ action: MSG.DICTATION_RESULT, success: true, text, raw: text, cost: 0, warning: null });
  const failedEdit = (over = {}) => ({ action: MSG.DICTATION_RESULT, success: false, error: FAILED_TEXT, tone: 'error', edit: true, instruction: 'make it shorter', ...over });
  const sentStarts = (t) => t.sent.filter((m) => m.action === MSG.START_RECORDING);

  /** Text in a field with its second word selected, and the field focused. */
  function selected(value = 'hello world', start = 6, end = 11, id = 'a') {
    $(id).value = value;
    $(id).focus();
    $(id).setSelectionRange(start, end);
    return $(id);
  }

  /** An edit press on field a that got as far as recording. */
  async function recordingEdit(t) {
    selected();
    t.controller.focusIn($('a'));
    expect(t.controller.editPress()).toBe(true);
    await flush();
    expect(t.controller.state).toBe('recording');
  }

  /** The same, stopped by a second press: the frame waits for the result. */
  async function processingEdit(t) {
    await recordingEdit(t);
    expect(t.controller.editPress()).toBe(true);
    await flush();
    expect(t.controller.state).toBe('processing');
  }

  describe('a press', () => {
    it('an edit press with a selection starts with edit text and the start status "Say how to change the selection."', async () => {
      const t = setup();
      selected();
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.sent).toEqual([{ action: MSG.START_RECORDING, edit: { text: 'world' } }]);
      expect(t.controller.state).toBe('recording');
      expect(t.pill.setState).toHaveBeenLastCalledWith('recording');
      expect(lastStatus(t.pill)).toEqual(SAY);
    });

    it('a dictation omits the edit field, over a selection too', async () => {
      const t = setup();
      selected();
      await t.controller.press();
      expect(t.sent).toEqual([{ action: MSG.START_RECORDING }]);
      expect(Object.hasOwn(t.sent[0], 'edit')).toBe(false);
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('decides and reads the selection in the same task as the keydown', () => {
      const t = setup();
      selected();
      expect(t.controller.editPress()).toBe(true);
      expect(t.controller.state).toBe('starting');
      expect(sentStarts(t)).toEqual([{ action: MSG.START_RECORDING, edit: { text: 'world' } }]);
    });

    it('no selection in a field: unclaimed, "Select the text to edit first."', async () => {
      const t = setup();
      selected('hello', 2, 2);
      expect(t.controller.editPress()).toBe(false);
      await flush();
      expect(lastStatus(t.pill)).toEqual(SELECT_FIRST);
      expect(t.sent).toEqual([]);
      expect(t.controller.state).toBe('idle');
    });

    it('outside a field: unclaimed, silent', async () => {
      const t = setup();
      $('plain').focus();
      expect(t.controller.editPress()).toBe(false);
      document.activeElement.blur();
      expect(t.controller.editPress()).toBe(false);
      await flush();
      expect(t.pill.setStatus).not.toHaveBeenCalled();
      expect(t.sent).toEqual([]);
    });

    it('over the cap: claimed, the notice, no start', async () => {
      const t = setup();
      selected('x'.repeat(MAX_EDIT_CHARS + 1), 0, MAX_EDIT_CHARS + 1);
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(lastStatus(t.pill)).toEqual(TOO_LONG);
      expect(TOO_LONG[0]).toContain(MAX_EDIT_CHARS.toLocaleString('en-US'));
      expect(t.sent).toEqual([]);
      expect(t.controller.state).toBe('idle');
    });

    it('at the cap: starts', async () => {
      const t = setup();
      selected('x'.repeat(MAX_EDIT_CHARS), 0, MAX_EDIT_CHARS);
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(sentStarts(t)).toHaveLength(1);
    });

    it('a password field refuses as the dictation chord does', async () => {
      const t = setup();
      document.body.insertAdjacentHTML('beforeend', '<input id="pw" type="password" value="secret">');
      $('pw').focus();
      $('pw').setSelectionRange(0, 6);
      expect(t.controller.editPress()).toBe(false);
      await flush();
      expect(lastStatus(t.pill)).toEqual(PASSWORD);
      expect(t.sent).toEqual([]);
    });

    it('a field that is not a valid input: unclaimed, silent', () => {
      const t = setup();
      document.body.insertAdjacentHTML('beforeend', '<textarea id="ro" readonly>hello</textarea>');
      $('ro').focus();
      $('ro').setSelectionRange(0, 5);
      expect(t.controller.editPress()).toBe(false);
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('a refused start leaves the frame idle and forgets the selection', async () => {
      const t = setup({ replies: { [MSG.START_RECORDING]: { ok: false, reason: 'badEdit', error: 'Could not read the selection.' } } });
      selected();
      t.controller.editPress();
      await flush();
      expect(t.controller.state).toBe('idle');
      expect(lastStatus(t.pill)).toEqual(['Could not read the selection.', { tone: 'error', sticky: false, clickable: false }]);
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('a tap stops on its second press, and a hold stops on release', async () => {
      const tap = setup();
      await recordingEdit(tap);
      await tap.controller.release({ held: false });
      expect(tap.controller.state).toBe('recording');
      tap.controller.editPress();
      await flush();
      expect(tap.controller.state).toBe('processing');

      const hold = setup();
      selected();
      hold.controller.editPress();
      await flush();
      await hold.controller.release({ held: true });
      expect(hold.controller.state).toBe('processing');
    });

    it('a stop takes the start status down', async () => {
      const t = setup();
      await recordingEdit(t);
      t.controller.editPress();
      await flush();
      expect(t.pill.clearStatus).toHaveBeenCalled();
    });

    it('a stop of a dictation leaves a status alone, as in 3.1', async () => {
      const t = setup();
      await recordAndStop(t);
      expect(t.pill.clearStatus.mock.calls).toHaveLength(1);
    });

    it('on an orphaned frame nothing is claimed', () => {
      const t = setup();
      selected();
      t.controller.orphaned();
      expect(t.controller.editPress()).toBe(false);
      expect(t.sent).toEqual([]);
    });
  });

  describe('in any other state it does what the dictation chord does (V43)', () => {
    it('while recording the chord stops', async () => {
      const t = setup();
      await recordingEdit(t);
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.controller.state).toBe('processing');
      expect(t.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    });

    it('while starting the stop is queued, and the start status is skipped', async () => {
      const pending = deferred();
      const t = setup({ replies: { [MSG.START_RECORDING]: () => pending.promise } });
      selected();
      t.controller.editPress();
      expect(t.controller.editPress()).toBe(true);
      pending.resolve({ ok: true });
      await flush();
      expect(t.controller.state).toBe('processing');
      expect(t.pill.setStatus).not.toHaveBeenCalled();
    });

    it('while processing it says so', async () => {
      const t = setup();
      await processingEdit(t);
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(lastStatus(t.pill)[0]).toBe('Still processing');
    });

    it('no START_RECORDING is sent while this frame has a session, so an edit never joins a dictation', async () => {
      const pending = deferred();
      const t = setup({ replies: { [MSG.START_RECORDING]: () => pending.promise } });
      selected();
      t.controller.press();
      expect(t.controller.state).toBe('starting');
      t.controller.editPress();
      await flush();
      expect(sentStarts(t)).toHaveLength(1);

      pending.resolve({ ok: true });
      await flush();
      expect(t.controller.state).toBe('processing');
      t.controller.editPress();
      await flush();
      expect(sentStarts(t)).toEqual([{ action: MSG.START_RECORDING }]);

      const recording = setup();
      selected();
      await recording.controller.press();
      expect(recording.controller.state).toBe('recording');
      recording.controller.editPress();
      await flush();
      expect(sentStarts(recording)).toEqual([{ action: MSG.START_RECORDING }]);
      expect(recording.actions()).toEqual([MSG.START_RECORDING, MSG.STOP_RECORDING]);
    });

    it('a held result lands first and nothing records', async () => {
      const t = setup();
      await processingEdit(t);
      t.deps.hasFocus.mockReturnValue(false);
      t.controller.handleMessage(edited());
      await flush();
      expect(lastStatus(t.pill)[0]).toBe('Return to the field to insert, or click here to copy.');
      t.deps.hasFocus.mockReturnValue(true);
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.deps.insertText).toHaveBeenCalledTimes(1);
      expect(sentStarts(t)).toHaveLength(1);
    });

    it('a pending click-to-copy copies first, and nothing records', async () => {
      const t = setup({ insert: 'failed' });
      await recordAndStop(t);
      t.controller.handleMessage(dictated());
      await flush();
      expect(lastStatus(t.pill)).toEqual(CLICK);
      selected();
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
      expect(sentStarts(t)).toHaveLength(1);
    });

    it('the press after a copy that failed records an edit, not a dictation', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await recordAndStop(t);
      t.controller.handleMessage(dictated());
      await flush();
      selected();
      t.controller.editPress();
      await flush();
      expect(sentStarts(t)).toHaveLength(1);
      t.controller.editPress();
      await flush();
      expect(sentStarts(t).at(-1)).toEqual({ action: MSG.START_RECORDING, edit: { text: 'world' } });
    });

    it('with no selection after a failed copy the click-to-copy status stays', async () => {
      const t = setup({ insert: 'failed', copy: false });
      await recordAndStop(t);
      t.controller.handleMessage(dictated());
      await flush();
      selected('hello', 2, 2);
      t.controller.editPress();
      await flush();
      const shown = lastStatus(t.pill);
      expect(t.controller.editPress()).toBe(false);
      await flush();
      expect(lastStatus(t.pill)).toEqual(shown);
    });

    it('a press kept through a landing starts as an edit when the landing ends', async () => {
      const pending = deferred();
      const t = setup();
      t.deps.insertText.mockImplementationOnce(() => pending.promise);
      await recordAndStop(t);
      t.controller.handleMessage(dictated());
      await flush();
      selected();
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(lastStatus(t.pill)[0]).toBe('Still processing');
      pending.resolve('inserted');
      await flush();
      expect(sentStarts(t).at(-1)).toEqual({ action: MSG.START_RECORDING, edit: { text: 'world' } });
    });

    it('a kept press with the chord up by then starts nothing', async () => {
      const pending = deferred();
      const t = setup();
      t.deps.insertText.mockImplementationOnce(() => pending.promise);
      await recordAndStop(t);
      t.controller.handleMessage(dictated());
      await flush();
      selected();
      t.controller.editPress();
      await t.controller.release({ held: false });
      pending.resolve('inserted');
      await flush();
      expect(sentStarts(t)).toHaveLength(1);
    });
  });

  describe('a result', () => {
    it('a delivered edit with the selection intact calls insertText', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).toHaveBeenCalledWith($('a'), REPLACED, { replacing: true });
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)[0]).toMatch(/^Done /);
    });

    it('a dictation still calls insertText with the field and the text alone', async () => {
      const t = setup();
      selected();
      await t.controller.press();
      await t.controller.press();
      t.controller.handleMessage(dictated());
      await flush();
      expect(t.deps.insertText.mock.calls[0]).toEqual([$('a'), 'hello']);
    });

    it('a moved selection copies with "Selection changed. Result copied to clipboard."', async () => {
      const t = setup();
      await processingEdit(t);
      $('a').setSelectionRange(0, 5);
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith(REPLACED);
      expect(lastStatus(t.pill)).toEqual(CHANGED);
      expect(t.pill.setState).toHaveBeenLastCalledWith('done');
    });

    it('text the page rewrote at the same offsets copies, and the field stays as the page left it', async () => {
      const t = setup();
      await processingEdit(t);
      $('a').value = 'hello there';
      $('a').setSelectionRange(6, 11);
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect($('a').value).toBe('hello there');
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('the focus in another field copies, with the same words', async () => {
      const t = setup();
      await processingEdit(t);
      $('b').focus();
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('a field gone from the page copies, with the same words', async () => {
      const t = setup();
      await processingEdit(t);
      $('a').remove();
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('a copy that fails keeps the replacement on a click-to-copy status', async () => {
      const t = setup({ copy: false });
      await processingEdit(t);
      $('a').setSelectionRange(0, 5);
      t.controller.handleMessage(edited());
      await flush();
      expect(lastStatus(t.pill)).toEqual(CLICK);
      t.deps.copyText.mockResolvedValue(true);
      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenLastCalledWith(REPLACED);
    });

    it('an edit result with no selection snapshot in this frame is never inserted', async () => {
      const t = setup();
      await recordingEdit(t);
      // A cancel leaves the frame idle with nothing bound, and the session may still deliver.
      t.controller.handleMessage({ action: MSG.RECORDING_STATE, state: 'idle' });
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith(REPLACED);
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('a result with no edit mark on an edit session never lands on the selection', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(dictated());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).toHaveBeenCalledWith('hello');
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('an edit result reaching a frame that recorded none is copied', async () => {
      const t = setup();
      selected();
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)).toEqual(CHANGED);
    });

    it('a dictation after an edit is a dictation: no snapshot is left over', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(edited());
      await flush();
      t.deps.insertText.mockClear();
      await t.controller.press();
      await t.controller.press();
      t.controller.handleMessage(dictated());
      await flush();
      expect(t.deps.insertText.mock.calls[0]).toEqual([$('a'), 'hello']);
    });

    it('a watchdog that gave up keeps the snapshot: a late edit is still checked and placed', async () => {
      const t = setup();
      await processingEdit(t);
      vi.advanceTimersByTime(PROCESSING_TIMEOUT_MS);
      expect(t.controller.state).toBe('idle');
      t.controller.handleMessage(edited());
      await flush();
      expect(t.deps.insertText).toHaveBeenCalledWith($('a'), REPLACED, { replacing: true });
    });

    describe('a held edit is checked when it lands', () => {
      async function heldEdit(t) {
        await processingEdit(t);
        t.deps.hasFocus.mockReturnValue(false);
        t.controller.handleMessage(edited());
        await flush();
        expect(t.deps.insertText).not.toHaveBeenCalled();
        expect(t.deps.copyText).not.toHaveBeenCalled();
      }

      it('intact: into the field', async () => {
        const t = setup();
        await heldEdit(t);
        t.deps.hasFocus.mockReturnValue(true);
        await t.controller.onWindowFocus();
        await flush();
        expect(t.deps.insertText).toHaveBeenCalledWith($('a'), REPLACED, { replacing: true });
      });

      it('moved meanwhile: copied', async () => {
        const t = setup();
        await heldEdit(t);
        $('a').setSelectionRange(0, 5);
        t.deps.hasFocus.mockReturnValue(true);
        await t.controller.onWindowFocus();
        await flush();
        expect(t.deps.insertText).not.toHaveBeenCalled();
        expect(t.deps.copyText).toHaveBeenCalledWith(REPLACED);
        expect(lastStatus(t.pill)).toEqual(CHANGED);
      });

      it('a click on its status copies the replacement', async () => {
        const t = setup();
        await heldEdit(t);
        await t.controller.copyLast();
        expect(t.deps.copyText).toHaveBeenCalledWith(REPLACED);
      });
    });

    /** insertText as the ladder ends for a field: over the selection, caret after it. */
    function writing(t) {
      t.deps.insertText.mockImplementation(async (el, text) => {
        el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
        return 'inserted';
      });
    }

    async function undoCopies(t, entry) {
      t.deps.insertText.mockClear();
      t.controller.setRecent(entry);
      await t.controller.historyAction('undo');
      await flush();
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(lastStatus(t.pill)[0]).toBe('Original text copied.');
    }

    it('no mark is taken for an edit', async () => {
      const t = setup();
      writing(t);
      await processingEdit(t);
      t.controller.handleMessage(edited());
      await flush();
      expect($('a').value).toBe(`hello ${REPLACED}`);
      await undoCopies(t, { raw: 'make it shorter', text: REPLACED });
      expect($('a').value).toBe(`hello ${REPLACED}`);
    });

    it('an edit drops the mark of the dictation before it', async () => {
      const t = setup();
      writing(t);
      await recordAndStop(t);
      t.controller.handleMessage({ ...dictated('refined'), raw: 'raw' });
      await flush();
      await processingEdit(t);
      t.controller.handleMessage(edited({ text: 'hello world' }));
      await flush();
      await undoCopies(t, { raw: 'raw', text: 'refined' });
    });

    it('recent with edit: true has refined false', () => {
      const t = setup();
      t.controller.setSettings(settings());
      t.controller.setRecent({ raw: 'make it shorter', text: REPLACED, edit: true });
      expect(t.pill.renderMenu.mock.calls.at(-1)[2]).toEqual({ refined: false });
      t.controller.setRecent({ raw: 'make it shorter', text: REPLACED, edit: false });
      expect(t.pill.renderMenu.mock.calls.at(-1)[2]).toEqual({ refined: true });
    });
  });

  describe('a failure', () => {
    it('a failed edit shows a clickable, not sticky status whose click copies the instruction, and the next press records', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(failedEdit());
      await flush();
      expect(lastStatus(t.pill)).toEqual(FAILED);
      expect(t.pill.setState).toHaveBeenLastCalledWith('error');
      expect(t.deps.insertText).not.toHaveBeenCalled();
      expect(t.deps.copyText).not.toHaveBeenCalled();

      await t.controller.copyLast();
      expect(t.deps.copyText).toHaveBeenCalledWith('make it shorter');
      expect(lastStatus(t.pill)[0]).toBe('Copied to clipboard.');

      t.sent.length = 0;
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.sent).toEqual([{ action: MSG.START_RECORDING, edit: { text: 'world' } }]);
    });

    it('with the failure still showing, the next press records and copies nothing', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(failedEdit());
      await flush();
      expect(t.controller.editPress()).toBe(true);
      await flush();
      expect(t.deps.copyText).not.toHaveBeenCalled();
      expect(t.controller.state).toBe('recording');
    });

    it('the dictation chord records too with the failure showing', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(failedEdit());
      await flush();
      await t.controller.press();
      expect(t.controller.state).toBe('recording');
    });

    it('it picks the clickable status from instruction: a plain failure on an edit is plain', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage({ action: MSG.DICTATION_RESULT, success: false, error: 'No speech detected.', tone: 'warning' });
      await flush();
      expect(lastStatus(t.pill)).toEqual(['No speech detected.', { tone: 'warning', sticky: false, clickable: false }]);
    });

    it('an empty instruction has nothing to copy', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(failedEdit({ instruction: '' }));
      await flush();
      expect(lastStatus(t.pill)[1].clickable).toBe(false);
    });

    it('a failed edit leaves the field and its selection', async () => {
      const t = setup();
      await processingEdit(t);
      t.controller.handleMessage(failedEdit());
      await flush();
      expect($('a').value).toBe('hello world');
      expect([$('a').selectionStart, $('a').selectionEnd]).toEqual([6, 11]);
    });
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
