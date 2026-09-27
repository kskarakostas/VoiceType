// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MSG } from '../../../src/shared/messages.js';

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
 */
async function loadInstance() {
  vi.resetModules();
  const { boot } = await import('../../../src/content/boot.js');
  boot({ isTrusted: () => true });
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
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
    expect(console.warn).not.toHaveBeenCalled();

    root.querySelector('.rec').click();
    document.getElementById('field').dispatchEvent(hotkey('keydown'));
    await flush();
    expect(t.sent().filter((a) => a === MSG.START_RECORDING)).toHaveLength(1);
    expect(root.querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
  });

  it('a synchronous throw is treated the same way', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    t.chrome.runtime.sendMessage.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    shadow().querySelector('.rec').click();
    await flush();
    expect(shadow().querySelector('[role="status"]').textContent).toBe('VoiceType was updated. Reload this page.');
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

describe('page and key isolation', () => {
  it('never touches chrome.storage', async () => {
    const t = installChrome();
    document.getElementById('field').focus();
    await loadInstance();
    shadow().querySelector('.more').click();
    shadow().querySelector('.rec').click();
    await flush();
    expect(t.storageAccess).toEqual([]);
    for (const name of ['index.js', 'boot.js', 'controller.js', 'pill.js']) expect(readContent(name), name).not.toMatch(/chrome\.storage/);
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
