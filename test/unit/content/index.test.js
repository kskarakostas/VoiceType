// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MSG } from '../../../src/shared/messages.js';
import { FOCUS_OUT_MS } from '../../../src/content/controller.js';

// A path, not a URL literal: jsdom replaces the global URL, and the web transform rewrites
// `new URL('<literal>', import.meta.url)` into a dev-server address.
const fromHere = (relative) => fileURLToPath(new URL(relative, import.meta.url).href);
const CONTENT_DIR = fromHere('../../../src/content/');
const readContent = (name) => readFileSync(`${CONTENT_DIR}${name}`, 'utf8');

const SETTINGS = {
  settingsVersion: 2,
  provider: 'openai',
  hasKey: { openai: true, gemini: false },
  activeMode: 'default',
  translateTargetLang: 'English',
  pillGap: 8,
  hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
  modes: {
    default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
    email: { name: 'Email', icon: '📧', prompt: 'p', builtIn: true },
  },
};
const USAGE = {
  today: { sessions: 2, audioSeconds: 20, estimatedCost: 0.012 },
  last7Days: { sessions: 5, audioSeconds: 50, estimatedCost: 0.03 },
  total: { sessions: 9, audioSeconds: 90, estimatedCost: 0.5 },
};

function reply(message) {
  switch (message.action) {
    case MSG.GET_SETTINGS: return structuredClone(SETTINGS);
    case MSG.GET_USAGE: return structuredClone(USAGE);
    case MSG.UPDATE_SETTINGS: return { success: true };
    default: return { ok: true };
  }
}

/** A fake `chrome` with only what a content script may use; any chrome.storage access is recorded. */
function installChrome(respond = reply) {
  const listeners = new Set();
  const storageAccess = [];
  const chrome = {
    runtime: {
      id: 'voicetype-test',
      sendMessage: vi.fn(async (message) => respond(message)),
      onMessage: {
        addListener: vi.fn((fn) => listeners.add(fn)),
        removeListener: vi.fn((fn) => listeners.delete(fn)),
      },
    },
  };
  Object.defineProperty(chrome, 'storage', {
    get() {
      storageAccess.push('chrome.storage');
      return undefined;
    },
  });
  globalThis.chrome = chrome;
  return { chrome, listeners, storageAccess, sent: () => chrome.runtime.sendMessage.mock.calls.map(([m]) => m.action) };
}

/**
 * Evaluate a fresh copy of the content script, as Chrome does when it injects content.js again.
 * Events a test dispatches are untrusted, so the instance is booted to accept them; the page
 * isolation tests load the real entry, which does not.
 * @param {{ isAlive?: () => boolean }} [options] more boot options
 */
async function loadInstance(options = {}) {
  vi.resetModules();
  const { boot } = await import('../../../src/content/boot.js');
  boot({ isTrusted: () => true, ...options });
  await flush();
}

/** Load the production entry, which boots with the real isTrusted check. */
async function loadEntry() {
  vi.resetModules();
  await import('../../../src/content/index.js');
  await flush();
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const hosts = () => document.documentElement.querySelectorAll('voicetype-host');
const shadow = () => hosts()[0].shadowRoot;
const statusText = () => shadow().querySelector('[role="status"]').textContent;
const HOLD = 'Return to the field to insert, or click here to copy.';
const ORPHAN = 'VoiceType was turned off or updated. Reload this page.';
const RESULT = { action: MSG.DICTATION_RESULT, success: true, text: 'hello', raw: 'hello', cost: 0, warning: null };

/** REC, then REC again: the instance waits for the result of a session bound to the focused field. */
async function recordAndStop() {
  shadow().querySelector('.rec').click();
  await flush();
  shadow().querySelector('.rec').click();
  await flush();
  expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Start recording');
}
const hotkey = (type, extra = {}) => new KeyboardEvent(type, {
  code: 'Space', key: ' ', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...extra,
});

const attachShadow = Element.prototype.attachShadow;

beforeEach(() => {
  // Open roots so the test can look inside the pill; production uses closed ones.
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function attachOpen(init) {
    return attachShadow.call(this, { ...init, mode: 'open' });
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  document.body.innerHTML = '<textarea id="field"></textarea><input id="other">';
  // jsdom has no layout; an all-zero box counts as offscreen and would hide the pill.
  for (const el of document.querySelectorAll('#field, #other')) {
    el.getBoundingClientRect = () => ({ top: 100, left: 400, width: 300, height: 30, right: 700, bottom: 130, x: 400, y: 100 });
  }
});

afterEach(() => {
  document.dispatchEvent(new CustomEvent('voicetype:teardown'));
  hosts().forEach((el) => el.remove());
  document.activeElement?.blur?.();
  vi.restoreAllMocks();
  delete globalThis.chrome;
});

describe('teardown handshake', () => {
  it('a new instance removes the old host, listeners and hotkey', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    const first = hosts()[0];
    expect(first).toBeDefined();
    expect(t.listeners.size).toBe(1);
    const [firstListener] = t.listeners;

    await loadInstance();
    expect(first.isConnected).toBe(false);
    expect(hosts()).toHaveLength(1);
    expect(hosts()[0]).not.toBe(first);
    expect(t.chrome.runtime.onMessage.removeListener).toHaveBeenCalledWith(firstListener);
    expect(t.listeners.size).toBe(1);
    expect(t.listeners.has(firstListener)).toBe(false);

    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
  });

  it('the old instance cancels its recording when it is replaced', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.rec').click();
    await flush();
    await loadInstance();
    expect(t.sent()).toContain(MSG.CANCEL_RECORDING);
  });
});

describe('upgrade from 2.0', () => {
  it('removes a leftover v2.0 pill when the entry boots', async () => {
    installChrome();
    const old = document.createElement('div');
    old.id = 'voicetype-pill';
    document.body.append(old);
    await loadEntry();
    expect(old.isConnected).toBe(false);
    expect(document.getElementById('voicetype-pill')).toBeNull();
  });
});

describe('orphan detection', () => {
  it('an "Extension context invalidated" rejection shows the terminal notice', async () => {
    const t = installChrome((message) => {
      if (message.action === MSG.START_RECORDING) throw new Error('Extension context invalidated.');
      return reply(message);
    });
    document.getElementById('field').focus();
    await loadInstance();
    const root = shadow();
    root.querySelector('.rec').click();
    await flush();
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was turned off or updated. Reload this page.');
    expect(console.warn).not.toHaveBeenCalled();

    root.querySelector('.rec').click();
    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was turned off or updated. Reload this page.');
  });

  it('a synchronous throw is treated the same way', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    t.chrome.runtime.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    shadow().querySelector('.rec').click();
    await flush();
    expect(shadow().querySelector('[role="status"]').textContent).toBe('VoiceType was turned off or updated. Reload this page.');
  });

  it('other errors are logged and are not terminal', async () => {
    let fail = true;
    const t = installChrome((message) => {
      if (message.action === MSG.START_RECORDING && fail) throw new Error('Could not establish connection. Receiving end does not exist.');
      return reply(message);
    });
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.rec').click();
    await flush();
    expect(console.warn).toHaveBeenCalledWith('VoiceType: Could not establish connection. Receiving end does not exist.');
    expect(shadow().querySelector('[role="status"]').textContent).toBe('VoiceType could not reach its background service. Try again.');
    fail = false;
    shadow().querySelector('.rec').click();
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(2);
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Stop recording');
  });

  it('an orphaned instance lets the hotkey through', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    // Disabling or reloading the extension leaves this copy running without a runtime id.
    delete t.chrome.runtime.id;
    const page = vi.fn();
    document.addEventListener('keydown', page);

    const first = hotkey('keydown');
    field.dispatchEvent(first);
    field.dispatchEvent(hotkey('keyup'));
    await flush();
    expect(first.defaultPrevented).toBe(false);
    expect(statusText()).toBe(ORPHAN);

    const second = hotkey('keydown');
    field.dispatchEvent(second);
    await flush();
    expect(second.defaultPrevented).toBe(false);
    expect(page).toHaveBeenCalledTimes(2);
    expect(t.sent()).toEqual([MSG.GET_SETTINGS]);
    document.removeEventListener('keydown', page);
  });

  it('a dead instance shows the notice for the chord only and never consumes a key', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    let alive = true;
    await loadInstance({ isAlive: () => alive });
    alive = false;

    const typed = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true });
    field.dispatchEvent(typed);
    await flush();
    expect(typed.defaultPrevented).toBe(false);
    expect(statusText()).not.toBe(ORPHAN);

    const chord = hotkey('keydown');
    field.dispatchEvent(chord);
    await flush();
    expect(chord.defaultPrevented).toBe(false);
    expect(statusText()).toBe(ORPHAN);
    expect(t.sent()).toEqual([MSG.GET_SETTINGS]);
  });

  it('an instance orphaned through a failed send also stops preventing the chord afterwards', async () => {
    const t = installChrome((message) => {
      if (message.action === MSG.START_RECORDING) throw new Error('Extension context invalidated.');
      return reply(message);
    });
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();

    // The runtime id is still there, so this press is consumed and goes to the service worker.
    const first = hotkey('keydown');
    field.dispatchEvent(first);
    field.dispatchEvent(hotkey('keyup'));
    await flush();
    expect(first.defaultPrevented).toBe(true);
    expect(statusText()).toBe(ORPHAN);

    const second = hotkey('keydown');
    field.dispatchEvent(second);
    field.dispatchEvent(hotkey('keyup'));
    await flush();
    expect(second.defaultPrevented).toBe(false);
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
  });
});

describe('wiring', () => {
  it('loads settings at start and refetches settings and usage when the menu opens', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS]);
    expect(shadow().querySelector('.mode-icon').textContent).toBe('🎤');
    shadow().querySelector('.more').click();
    await flush();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.GET_SETTINGS, MSG.GET_USAGE]);
    expect(shadow().querySelector('.usage').textContent).toBe('Today $0.01 (2), all time $0.50');
  });

  it('shows the pill when a field gains focus, using the composed path', async () => {
    installChrome();
    await loadInstance();
    expect(hosts()).toHaveLength(0);
    document.getElementById('field').focus();
    expect(hosts()).toHaveLength(1);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('consumes the hotkey press and its repeats, and nothing else', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    const down = hotkey('keydown');
    field.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await flush();
    const repeat = hotkey('keydown', { repeat: true });
    field.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true });
    field.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
  });

  it('a window blur during a hold ends the press', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    window.dispatchEvent(new Event('blur'));
    await flush();
    // A tap (released at once) keeps recording; nothing else is sent.
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.START_RECORDING]);
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS, MSG.START_RECORDING, MSG.STOP_RECORDING]);
  });

  it('a window blur hides the idle pill once another frame has the focus', async () => {
    installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    expect(shadow().querySelector('.vt').hidden).toBe(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    await vi.waitFor(() => expect(shadow().querySelector('.vt').hidden).toBe(true));
    expect(document.activeElement).toBe(field);
  });

  it('pagehide while recording cancels the session', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.sent()).not.toContain(MSG.CANCEL_RECORDING);
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    window.dispatchEvent(new Event('pagehide'));
    expect(t.sent()).toContain(MSG.CANCEL_RECORDING);
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Start recording');
  });

  it('forwards runtime messages to the controller and returns false', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    const [listener] = t.listeners;
    const next = { ...structuredClone(SETTINGS), activeMode: 'email', hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false } };
    expect(listener({ action: MSG.SETTINGS_CHANGED, settings: next }, {}, () => {})).toBe(false);
    expect(shadow().querySelector('.mode-icon').textContent).toBe('📧');

    // The pushed hotkey replaces the default chord.
    const field = document.getElementById('field');
    const oldChord = hotkey('keydown');
    field.dispatchEvent(oldChord);
    expect(oldChord.defaultPrevented).toBe(false);
    const newChord = new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', altKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(newChord);
    expect(newChord.defaultPrevented).toBe(true);
  });

  it('holds a result while the page lacks focus and inserts it when the window regains focus', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    await recordAndStop();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const [listener] = t.listeners;
    listener(RESULT, {}, () => {});
    await flush();
    expect(statusText()).toBe(HOLD);
    expect(field.value).toBe('');
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    // The insert reports only once its read-back has settled (a macrotask, a frame, then polling).
    await vi.waitFor(() => expect(statusText()).toBe('Done $0.00'));
    expect(field.value).toBe('hello');
  });

  it('menu choices send a whitelisted patch', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    await flush();
    shadow().querySelector('[data-provider="gemini"]').click();
    shadow().querySelector('[data-mode="email"]').click();
    await flush();
    const patches = t.chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.action === MSG.UPDATE_SETTINGS);
    expect(patches).toEqual([
      { action: MSG.UPDATE_SETTINGS, patch: { provider: 'gemini' } },
      { action: MSG.UPDATE_SETTINGS, patch: { activeMode: 'email' } },
    ]);
  });
});

describe('a frame out of sight', () => {
  /** @type {{ callback: (entries: object[]) => void, targets: Element[] }[]} */
  let observers;

  class FakeObserver {
    targets = [];
    disconnect = vi.fn();

    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    observe(el) {
      this.targets.push(el);
    }
  }

  const deliver = (t, message) => [...t.listeners].forEach((fn) => fn(message));
  const mirrorMessage = (state, elapsedMs = 5000) => ({ action: MSG.RECORDING_MIRROR, state, elapsedMs });
  const miniOf = (host) => host.shadowRoot.querySelector('.mini');

  async function record() {
    document.getElementById('field').focus();
    await flush();
    shadow().querySelector('.rec').click();
    await flush();
  }

  beforeEach(() => {
    observers = [];
    window.IntersectionObserver = FakeObserver;
  });

  afterEach(() => {
    delete window.IntersectionObserver;
    delete HTMLElement.prototype.hidePopover;
    delete HTMLElement.prototype.showPopover;
    vi.unstubAllGlobals();
  });

  it('a subframe reports its sight to the service worker', async () => {
    vi.stubGlobal('top', {});
    const t = installChrome();
    await loadInstance();
    await record();
    expect(observers).toHaveLength(1);
    observers[0].callback([{ isIntersecting: false }]);
    await flush();
    expect(t.chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: MSG.FRAME_SIGHT, seen: false });
  });

  it('the top frame watches nothing', async () => {
    installChrome();
    await loadInstance();
    await record();
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Stop recording');
    expect(observers).toEqual([]);
  });

  it('a mirror message shows Minimal in a host of its own and idle removes it', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    expect(hosts()).toHaveLength(1);
    deliver(t, mirrorMessage('recording', 65000));
    expect(hosts()).toHaveLength(2);
    const mini = miniOf(hosts()[1]);
    expect(hosts()[1].shadowRoot.querySelector('.vt').dataset.style).toBe('minimal');
    expect(mini.dataset.state).toBe('recording');
    expect(mini.querySelector('.mini-time').textContent).toBe('01:05');
    expect(hosts()[0].shadowRoot.querySelector('.vt').hidden).toBe(false);
    deliver(t, mirrorMessage('processing'));
    expect(mini.dataset.state).toBe('processing');
    deliver(t, mirrorMessage('idle'));
    expect(hosts()).toHaveLength(1);
  });

  it('a level reaches the mirror', async () => {
    const t = installChrome();
    await loadInstance();
    deliver(t, mirrorMessage('recording'));
    deliver(t, { action: MSG.AUDIO_LEVEL, level: 0.5 });
    expect(miniOf(hosts()[1]).style.getPropertyValue('--vt-level')).toBe('0.5');
  });

  it('a level still reaches the frame that records', async () => {
    const t = installChrome();
    await loadInstance();
    await record();
    deliver(t, { action: MSG.AUDIO_LEVEL, level: 0.5 });
    expect(shadow().querySelector('.pill').style.getPropertyValue('--vt-level')).toBe('0.5');
  });

  it('teardown removes the mirror', async () => {
    const t = installChrome();
    await loadInstance();
    deliver(t, mirrorMessage('recording'));
    expect(hosts()).toHaveLength(2);
    document.dispatchEvent(new CustomEvent('voicetype:teardown'));
    expect(hosts()).toHaveLength(0);
  });

  it('the extension going away removes the mirror and leaves the notice', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadInstance();
    deliver(t, mirrorMessage('recording'));
    expect(hosts()).toHaveLength(2);
    delete t.chrome.runtime.id;
    field.dispatchEvent(hotkey('keydown'));
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(statusText()).toBe(ORPHAN);
  });

  it('pagehide removes the mirror, so the back-forward cache keeps no false recording', async () => {
    const t = installChrome();
    await loadInstance();
    deliver(t, mirrorMessage('recording'));
    expect(hosts()).toHaveLength(2);
    window.dispatchEvent(new Event('pagehide'));
    expect(hosts()).toHaveLength(1);
    expect(miniOf(hosts()[0]).dataset.state).toBe('idle');
    expect(t.sent()).not.toContain(MSG.CANCEL_RECORDING);
    deliver(t, { action: MSG.AUDIO_LEVEL, level: 0.5 });
    expect(hosts()).toHaveLength(1);
  });

  it('a frame 0 status shown after the mirror leaves the mirror host last, so it paints on top', async () => {
    const busy = (message) => (message.action === MSG.START_RECORDING
      ? { ok: false, reason: 'busy', error: 'Busy' }
      : reply(message));
    const t = installChrome(busy);
    await loadInstance();
    deliver(t, mirrorMessage('recording'));

    document.getElementById('field').focus();
    await flush();
    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();

    expect(hosts()).toHaveLength(2);
    expect(hosts()[0].shadowRoot.querySelector('[role="status"]').textContent).toBe('Busy');
    expect(miniOf(hosts()[1]).dataset.state).toBe('recording');
  });

  it('a frame 0 raise raises the mirror right after it, so no status covers the mirror', async () => {
    const shown = [];
    // jsdom has no popover API.
    HTMLElement.prototype.hidePopover = () => {};
    HTMLElement.prototype.showPopover = function record() { shown.push(this); };
    const busy = (message) => (message.action === MSG.START_RECORDING
      ? { ok: false, reason: 'busy', error: 'Busy' }
      : reply(message));
    const t = installChrome(busy);
    await loadInstance();
    deliver(t, mirrorMessage('recording'));
    document.getElementById('field').focus();
    await flush();
    shown.length = 0;

    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();

    expect(shown).toContain(hosts()[0]);
    expect(shown[shown.indexOf(hosts()[0]) + 1]).toBe(hosts()[1]);
  });
});

describe('first settings answer', () => {
  const site = (hidePill, mode = null) => ({ ...structuredClone(SETTINGS), site: { hidePill, mode } });
  const field = () => document.getElementById('field');
  const other = () => document.getElementById('other');
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  /** A service worker whose first GET_SETTINGS stays unanswered until `answer` runs. */
  function holdSettings() {
    let answer;
    let fail;
    const held = new Promise((resolve, reject) => {
      answer = resolve;
      fail = reject;
    });
    const t = installChrome((message) => (message.action === MSG.GET_SETTINGS ? held : reply(message)));
    return { t, answer: (value) => answer(value), fail: (error) => fail(error) };
  }

  it('no pill before the first settings answer', async () => {
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    other().focus();
    await flush();
    expect(hosts()).toHaveLength(0);
    answer(site(true));
    await flush();
    expect(hosts()).toHaveLength(0);
  });

  it('a focus change or a window blur during the wait shows no pill', async () => {
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    other().focus();
    window.dispatchEvent(new Event('blur'));
    await sleep(FOCUS_OUT_MS + 20);
    expect(hosts()).toHaveLength(0);
    answer(site(true));
    await flush();
    expect(hosts()).toHaveLength(0);
  });

  it('the focused field gets the pill after the answer', async () => {
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    other().focus();
    await flush();
    expect(hosts()).toHaveLength(0);
    answer(site(false));
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('a failed first read shows the pill', async () => {
    const { fail } = holdSettings();
    field().focus();
    await loadInstance();
    fail(new Error('Could not establish connection. Receiving end does not exist.'));
    await flush();
    expect(hosts()).toHaveLength(1);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('a window blur during the wait is not lost', async () => {
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    window.dispatchEvent(new Event('blur'));
    answer(site(false));
    await flush();
    await vi.waitFor(() => expect(shadow().querySelector('.vt').hidden).toBe(true));
    expect(document.activeElement).toBe(field());
  });

  it('a focused window keeps the pill after the wait', async () => {
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    answer(site(false));
    await sleep(FOCUS_OUT_MS + 20);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('a throw while applying the answer leaves focus working', async () => {
    // Handle the rejection the boot chain passes on, so it does not fail the run as unhandled.
    const { finally: original } = Promise.prototype;
    vi.spyOn(Promise.prototype, 'finally').mockImplementation(function handled(fn) {
      const next = original.call(this, fn);
      next.catch(() => {});
      return next;
    });
    const { answer } = holdSettings();
    field().focus();
    await loadInstance();
    answer({ ...site(false), modes: { get default() { throw new Error('bad modes'); } } });
    await flush();
    expect(hosts()).toHaveLength(1);
    other().focus();
    expect(shadow().querySelector('.vt').hidden).toBe(false);
  });

  it('the hotkey during the wait records with the pill, whatever the answer says', async () => {
    const { t, answer } = holdSettings();
    field().focus();
    await loadInstance();
    field().dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent()).toContain(MSG.START_RECORDING);
    expect(shadow().querySelector('.vt').hidden).toBe(false);
    answer(site(true));
    await flush();
    expect(shadow().querySelector('.vt').hidden).toBe(false);
    expect(shadow().querySelector('.rec').getAttribute('aria-label')).toBe('Stop recording');
  });
});

describe('a document that becomes current', () => {
  const site = (hidePill) => ({ ...structuredClone(SETTINGS), site: { hidePill, mode: null } });
  const field = () => document.getElementById('field');
  const reads = (t) => t.sent().filter((action) => action === MSG.GET_SETTINGS).length;
  const shown = () => hosts().length === 1 && shadow().querySelector('.vt').hidden === false;

  /** A service worker that answers `current.settings`, which a test changes as the rule changes. */
  function serve(hidePill) {
    const current = { settings: site(hidePill) };
    const t = installChrome((message) => (message.action === MSG.GET_SETTINGS ? current.settings : reply(message)));
    return { t, current };
  }

  describe('prerendered', () => {
    /** @param {boolean} value */
    const stubPrerendering = (value) => Object.defineProperty(document, 'prerendering', { configurable: true, get: () => value });
    const activate = async () => {
      stubPrerendering(false);
      document.dispatchEvent(new Event('prerenderingchange'));
      await flush();
    };

    beforeEach(() => stubPrerendering(true));

    afterEach(() => {
      delete document.prerendering;
    });

    it('reads no settings until it is activated, then reads once', async () => {
      const { t } = serve(false);
      await loadInstance();
      expect(reads(t)).toBe(0);
      await activate();
      expect(reads(t)).toBe(1);
      document.dispatchEvent(new Event('prerenderingchange'));
      await flush();
      expect(reads(t)).toBe(1);
    });

    it('keeps the boot gate closed until the read settles, so a hidden site shows no pill', async () => {
      let answer;
      const held = new Promise((resolve) => { answer = resolve; });
      installChrome((message) => (message.action === MSG.GET_SETTINGS ? held : reply(message)));
      await loadInstance();
      field().focus();
      await flush();
      expect(hosts()).toHaveLength(0);
      await activate();
      field().blur();
      field().focus();
      await flush();
      expect(hosts()).toHaveLength(0);
      answer(site(true));
      await flush();
      expect(hosts()).toHaveLength(0);
    });

    it('shows the focused field its pill after the read', async () => {
      serve(false);
      field().focus();
      await loadInstance();
      expect(hosts()).toHaveLength(0);
      await activate();
      expect(shown()).toBe(true);
    });

    it('a copy torn down before activation stays silent', async () => {
      const { t } = serve(false);
      await loadInstance();
      document.dispatchEvent(new CustomEvent('voicetype:teardown'));
      await activate();
      expect(reads(t)).toBe(0);
    });

    it('the entry ignores a look-alike activation from the page', async () => {
      const { t } = serve(false);
      await loadEntry();
      document.dispatchEvent(new Event('prerenderingchange'));
      await flush();
      expect(reads(t)).toBe(0);
    });

    it('an extension gone by activation stays quiet until the chord', async () => {
      const { t } = serve(false);
      field().focus();
      await loadInstance({ isAlive: () => false });
      await activate();
      expect(reads(t)).toBe(0);
      expect(hosts()).toHaveLength(0);
      field().dispatchEvent(hotkey('keydown'));
      await flush();
      expect(statusText()).toBe(ORPHAN);
    });
  });

  describe('restored from the back-forward cache', () => {
    const restore = async (persisted = true) => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted }));
      await flush();
    };

    it('a rule added while cached hides the idle pill', async () => {
      const { current } = serve(false);
      field().focus();
      await loadInstance();
      expect(shown()).toBe(true);
      current.settings = site(true);
      await restore();
      expect(shown()).toBe(false);
    });

    it('a rule removed while cached shows the pill at the focused field', async () => {
      const { current } = serve(true);
      field().focus();
      await loadInstance();
      expect(hosts()).toHaveLength(0);
      current.settings = site(false);
      await restore();
      expect(shown()).toBe(true);
    });

    it('a first load reads nothing again', async () => {
      const { t } = serve(false);
      await loadInstance();
      await restore(false);
      expect(reads(t)).toBe(1);
    });

    it('the entry ignores a look-alike restore from the page', async () => {
      const { t } = serve(false);
      await loadEntry();
      await restore();
      expect(reads(t)).toBe(1);
    });

    it('a copy torn down stays silent', async () => {
      const { t } = serve(false);
      await loadInstance();
      document.dispatchEvent(new CustomEvent('voicetype:teardown'));
      await restore();
      expect(reads(t)).toBe(1);
    });

    it('an extension gone meanwhile stays quiet until the chord', async () => {
      const { t } = serve(false);
      let alive = true;
      field().focus();
      await loadInstance({ isAlive: () => alive });
      alive = false;
      t.chrome.runtime.sendMessage.mockImplementation(async () => {
        throw new Error('Extension context invalidated.');
      });
      await restore();
      expect(statusText()).not.toBe(ORPHAN);
      field().dispatchEvent(hotkey('keydown'));
      await flush();
      expect(statusText()).toBe(ORPHAN);
    });
  });
});

describe('menu on a site with a mode rule', () => {
  function withRule() {
    return installChrome((message) => {
      if (message.action === MSG.GET_SETTINGS) return { ...structuredClone(SETTINGS), site: { hidePill: false, mode: 'email' } };
      if (message.action === MSG.SET_SITE_MODE) return { success: true };
      return reply(message);
    });
  }

  const siteModes = (t) => t.chrome.runtime.sendMessage.mock.calls.map(([m]) => m).filter((m) => m.action === MSG.SET_SITE_MODE);

  it('a mode choice in the menu reaches chooseMode', async () => {
    const t = withRule();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    await flush();
    shadow().querySelector('[data-mode="default"]').click();
    await flush();
    expect(siteModes(t)).toEqual([{ action: MSG.SET_SITE_MODE, mode: 'default' }]);
    expect(t.sent()).not.toContain(MSG.UPDATE_SETTINGS);
  });

  it('Use active mode in the menu reaches useActiveMode', async () => {
    const t = withRule();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    await flush();
    shadow().querySelector('[data-use-active]').click();
    await flush();
    expect(siteModes(t)).toEqual([{ action: MSG.SET_SITE_MODE, mode: null }]);
  });
});

describe('page and key isolation', () => {
  it('never touches chrome.storage', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    shadow().querySelector('.rec').click();
    await flush();
    expect(t.storageAccess).toEqual([]);
    const files = readdirSync(CONTENT_DIR).filter((name) => name.endsWith('.js'));
    expect(files).toEqual(expect.arrayContaining(['index.js', 'boot.js', 'controller.js', 'pill.js', 'pill-menu.js', 'pill-sight.js', 'pill-raise.js']));
    for (const name of files) expect(readContent(name), name).not.toMatch(/chrome\.storage/);
  });

  it('the entry ignores untrusted focus and hotkey events from the page', async () => {
    const t = installChrome();
    await loadEntry();
    const down = hotkey('keydown');
    const up = hotkey('keyup');
    window.dispatchEvent(down);
    window.dispatchEvent(up);
    await flush();
    expect(t.sent()).toEqual([MSG.GET_SETTINGS]);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    document.getElementById('field').dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    expect(hosts()).toHaveLength(0);
  });

  it('the entry ignores an untrusted window focus while a result is held', async () => {
    const t = installChrome();
    const field = document.getElementById('field');
    field.focus();
    await loadEntry();
    await recordAndStop();
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const [listener] = t.listeners;
    listener(RESULT, {}, () => {});
    await flush();
    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(field.value).toBe('');
    expect(statusText()).toBe(HOLD);
  });

  it('no file under src/content uses an HTML string sink', () => {
    const files = readdirSync(CONTENT_DIR).filter((name) => name.endsWith('.js'));
    expect(files).toContain('index.js');
    for (const name of files) {
      expect(readContent(name), name).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    }
  });
});
