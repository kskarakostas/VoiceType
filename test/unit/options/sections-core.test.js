// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, AUTO_STOP_CHOICES } from '../../../src/shared/defaults.js';
import { formatChord } from '../../../src/shared/chord.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const SETTINGS_CHANGE = { settings: { newValue: {} } };

function storedSettings(keys = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '', ...keys };
  return s;
}

/**
 * Fake chrome for the settings page. `script(action, ...responses)` queues one-shot answers;
 * without a queued answer each action gets a success default. `fire(changes, area)` plays a
 * storage.onChanged event. `saves()` returns the SAVE_SETTINGS patches.
 */
function fakeChrome(stored = storedSettings()) {
  const queues = new Map();
  const sent = [];
  const changeListeners = new Set();
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(stored),
    [MSG.SAVE_SETTINGS]: () => ({ success: true }),
    [MSG.VALIDATE_KEY]: () => ({ ok: true }),
  };
  return {
    sent,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    count: (action) => sent.filter((m) => m.action === action).length,
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    fire(changes, area) { for (const listener of [...changeListeners]) listener(changes, area); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        const queue = queues.get(message.action);
        if (queue?.length) return queue.shift();
        return defaults[message.action]?.(message);
      }),
      getManifest: () => ({ version: '3.0.0-test' }),
    },
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.add(listener)),
        removeListener: vi.fn((listener) => changeListeners.delete(listener)),
      },
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const pagehide = () => window.dispatchEvent(new Event('pagehide'));
const radio = (value) => document.querySelector(`input[name="provider"][value="${value}"]`);

/** Open the settings page at `route` with the real sections. */
function start(chrome, route) {
  window.history.replaceState(null, '', `#${route}`);
  return initOptions({ chrome, document, window });
}

function change(el, value) {
  if (value !== undefined) el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function keydown(target, init) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  // Every page this file starts shares window: flush any typing save an earlier test left waiting.
  pagehide();
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settings page core sections layout', () => {
  it('each route holds one card, without a heading that repeats the route, and the popup ids', async () => {
    await start(fakeChrome(), 'settings/provider');
    for (const route of ['settings/provider', 'settings/recording', 'settings/speech']) {
      const section = document.querySelector(`section[data-route="${route}"]`);
      expect(section.querySelectorAll('.card'), route).toHaveLength(1);
      expect(section.querySelectorAll('h2'), route).toHaveLength(0);
    }
    const inRoute = (route, id) => document.querySelector(`section[data-route="${route}"]`).contains($(id));
    for (const id of ['key-row-openai', 'key-openai', 'test-openai', 'clear-openai', 'key-row-gemini', 'key-gemini', 'spend-hint']) {
      expect(inRoute('settings/provider', id), id).toBe(true);
    }
    for (const id of ['min-time', 'max-time', 'auto-stop', 'hotkey', 'hotkey-hint']) expect(inRoute('settings/recording', id), id).toBe(true);
    for (const id of ['languages']) expect(inRoute('settings/speech', id), id).toBe(true);
    expect($('status')).toBeNull();
    expect($('status-text')).toBeNull();
  });

  it('shows the masked key, the Clear state and the spend hint', async () => {
    await start(fakeChrome(), 'settings/provider');
    expect(radio('openai').checked).toBe(true);
    expect($('key-openai').placeholder).toBe('sk-p…1234 (saved)');
    expect($('key-gemini').placeholder).toBe('AQ.... or AIza...');
    expect($('clear-openai').disabled).toBe(false);
    expect($('clear-gemini').disabled).toBe(true);
    expect($('key-row-openai').hidden).toBe(false);
    expect($('key-row-gemini').hidden).toBe(true);
    expect($('spend-hint').hidden).toBe(false);
  });

  it('hides the spend hint when no key is saved', async () => {
    await start(fakeChrome(storedSettings({ openai: '' })), 'settings/provider');
    expect($('spend-hint').hidden).toBe(true);
  });
});

describe('settings page autosave', () => {
  it('failed save reverts the control and in-memory value', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' }, { success: false, error: 'Storage is full.' });
    const page = await start(chrome, 'settings/recording');

    change($('max-time'), '300');
    expect(page.settings.maxRecordingTime).toBe(300);
    await flush();
    expect($('max-time').value).toBe('120');
    expect(page.settings.maxRecordingTime).toBe(120);
    expect($('toast').textContent).toBe('Storage is full.');
    expect($('toast').dataset.tone).toBe('error');

    const gemini = radio('gemini');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(document.querySelector('input[name="provider"]:checked').value).toBe('openai');
    expect(page.settings.provider).toBe('openai');
    expect($('key-row-gemini').hidden).toBe(true);
  });

  it('switching provider saves and shows that key row', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/provider');
    const gemini = radio('gemini');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(chrome.saves()).toEqual([{ provider: 'gemini' }]);
    expect($('key-row-gemini').hidden).toBe(false);
    expect($('key-row-openai').hidden).toBe(true);
  });

  it('min and max recording save as numbers', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/recording');
    change($('min-time'), '0.5');
    await flush();
    change($('max-time'), '60');
    await flush();
    expect(chrome.saves()).toEqual([{ minRecordingTime: 0.5 }, { maxRecordingTime: 60 }]);
  });

  it('silence auto-stop saves numbers from AUTO_STOP_CHOICES', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/recording');
    const select = $('auto-stop');
    expect([...select.options].map((o) => o.value)).toEqual(AUTO_STOP_CHOICES.map(String));
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', '2 s', '3 s', '5 s']);
    expect(select.value).toBe('0');
    for (const seconds of AUTO_STOP_CHOICES.slice(1)) {
      change(select, String(seconds));
      await flush();
      expect(chrome.saves().at(-1)).toEqual({ autoStopSilenceSec: seconds });
    }
  });

  it('a save after an external change sends only the edited field', async () => {
    const chrome = fakeChrome();
    const page = await start(chrome, 'settings/recording');
    chrome.script(MSG.GET_SETTINGS, { ...storedSettings(), activeMode: 'email' });
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(page.settings.activeMode).toBe('email');
    change($('min-time'), '3');
    await flush();
    expect(chrome.saves().at(-1)).toEqual({ minRecordingTime: 3 });
  });

  it('a failed save rolls back only its own fields', async () => {
    const chrome = fakeChrome();
    const page = await start(chrome, 'settings/provider');
    chrome.script(MSG.GET_SETTINGS, { ...storedSettings(), activeMode: 'email' });
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(page.settings.activeMode).toBe('email');

    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Disk full' });
    const gemini = radio('gemini');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(chrome.saves()).toEqual([{ provider: 'gemini' }]);
    expect(radio('openai').checked).toBe(true);
    expect(radio('gemini').checked).toBe(false);
    expect(page.settings.provider).toBe('openai');
    expect(page.settings.activeMode).toBe('email');
    expect($('toast').textContent).toBe('Disk full');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('a failed provider save keeps a recording change made while it ran', async () => {
    const chrome = fakeChrome();
    const failing = deferred();
    chrome.script(MSG.SAVE_SETTINGS, failing.promise);
    const page = await start(chrome, 'settings/provider');
    const gemini = radio('gemini');
    gemini.checked = true;
    change(gemini);
    change($('max-time'), '300');
    await flush();
    failing.resolve({ success: false, error: 'Disk full' });
    await flush();
    expect(chrome.saves()).toEqual([{ provider: 'gemini' }, { maxRecordingTime: 300 }]);
    expect(page.settings.provider).toBe('openai');
    expect(radio('openai').checked).toBe(true);
    expect(page.settings.maxRecordingTime).toBe(300);
    expect($('max-time').value).toBe('300');
  });

  it('an external change during a save waits for the save', async () => {
    const chrome = fakeChrome();
    const saving = deferred();
    chrome.script(MSG.SAVE_SETTINGS, saving.promise);
    await start(chrome, 'settings/recording');
    change($('max-time'), '300');
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(chrome.saves()).toEqual([{ maxRecordingTime: 300 }]);
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(1);
    saving.resolve({ success: true });
    await flush();
    await flush();
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(2);
  });
});

describe('settings page keys', () => {
  it('paste then blur saves the key', async () => {
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    const page = await start(chrome, 'settings/provider');
    const input = $('key-openai');
    input.focus();
    typeInto(input, '  sk-proj-new-key-5678  ');
    input.blur();
    await flush();
    expect(chrome.saves()).toEqual([{ keys: { openai: 'sk-proj-new-key-5678' } }]);
    expect(page.settings.keys.openai).toBe('sk-proj-new-key-5678');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('sk-p…5678 (saved)');
    expect($('toast').textContent).toBe('Key saved');
  });

  it('a key also saves 400 ms after the last input', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    await start(chrome, 'settings/provider');
    const input = $('key-openai');
    input.focus();
    typeInto(input, 'sk-proj-typed');
    await vi.advanceTimersByTimeAsync(250);
    typeInto(input, 'sk-proj-typed-9999');
    await vi.advanceTimersByTimeAsync(399);
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chrome.saves()).toEqual([{ keys: { openai: 'sk-proj-typed-9999' } }]);
    expect(input.value).toBe('sk-proj-typed-9999');
    input.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('Clear empties the key and Test validates the typed key', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/provider');
    typeInto($('key-openai'), 'sk-proj-candidate');
    $('test-openai').click();
    await flush();
    expect(chrome.sent.find((m) => m.action === MSG.VALIDATE_KEY)).toEqual({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-proj-candidate' });
    expect($('toast').textContent).toBe('OpenAI key works');
    $('clear-openai').click();
    await flush();
    expect(chrome.saves().at(-1)).toEqual({ keys: { openai: '' } });
    expect($('key-openai').placeholder).toBe('sk-...');
    expect($('clear-openai').disabled).toBe(true);
  });
});

describe('settings page hotkey recorder', () => {
  it('saves a valid chord', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/recording');
    const button = $('hotkey');
    expect(button.textContent).toBe(formatChord(freshSettings().hotkey));
    button.click();
    expect(button.textContent).toBe('Press keys');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(keydown(button, { code: 'ControlLeft', key: 'Control', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(keydown(button, { code: 'AltLeft', key: 'Alt', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true);
    expect($('hotkey-hint').textContent).toBe('Press the new hotkey. Esc cancels.');
    expect(chrome.saves()).toHaveLength(0);
    keydown(button, { code: 'KeyD', key: 'd', ctrlKey: true, altKey: true });
    await flush();
    const chord = { code: 'KeyD', ctrl: true, shift: false, alt: true, meta: false };
    expect(chrome.saves()).toEqual([{ hotkey: chord }]);
    expect(button.textContent).toBe(formatChord(chord));
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('rejects Shift+Space with the hint', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/recording');
    const button = $('hotkey');
    button.click();
    keydown(button, { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
    keydown(button, { code: 'Space', key: ' ', shiftKey: true });
    await flush();
    expect($('hotkey-hint').textContent).toBe('Use Ctrl, Alt or Cmd with a key');
    expect(chrome.saves()).toHaveLength(0);
    expect(button.textContent).toBe('Press keys');
  });

  it('Escape cancels', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/recording');
    const button = $('hotkey');
    button.click();
    expect(keydown(button, { code: 'Escape', key: 'Escape' }).defaultPrevented).toBe(true);
    expect(button.textContent).toBe(formatChord(freshSettings().hotkey));
    expect(button.getAttribute('aria-pressed')).toBe('false');
    expect($('hotkey-hint').textContent).toBe('Tap to toggle, hold to talk.');
    keydown(button, { code: 'KeyK', key: 'k', ctrlKey: true });
    await flush();
    expect(chrome.saves()).toHaveLength(0);
  });
});

describe('settings page speech', () => {
  it('languages Auto clears the list', async () => {
    const stored = storedSettings();
    stored.languages = ['en', 'el'];
    const chrome = fakeChrome(stored);
    await start(chrome, 'settings/speech');
    const auto = $('lang-auto');
    expect(auto.checked).toBe(false);
    expect($('lang-en').checked).toBe(true);
    auto.checked = true;
    change(auto);
    await flush();
    expect(chrome.saves().at(-1)).toEqual({ languages: [] });
    expect($('lang-en').checked).toBe(false);
    expect($('lang-el').checked).toBe(false);

    const german = $('lang-de');
    german.checked = true;
    change(german);
    await flush();
    expect(chrome.saves().at(-1)).toEqual({ languages: ['de'] });
    expect(auto.checked).toBe(false);
  });

  it('the Speech page links to the Dictionary', async () => {
    await start(fakeChrome(), 'settings/speech');
    expect(document.querySelector('section[data-route="settings/speech"] a[href="#dictionary"]')).not.toBeNull();
    expect($('keywords')).toBeNull();
  });
});

describe('settings page close', () => {
  it('pagehide within 400 ms of pasting a key saves it', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    await start(chrome, 'settings/provider');
    const input = $('key-openai');
    input.focus();
    typeInto(input, 'sk-proj-pasted-4321');
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.saves()).toHaveLength(0);
    pagehide();
    expect(chrome.saves()).toEqual([{ keys: { openai: 'sk-proj-pasted-4321' } }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.saves()).toHaveLength(1);
  });

  it('hiding the page saves pending typing once, and pagehide after it sends nothing more', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    await start(chrome, 'settings/provider');
    pagehide();
    expect(chrome.saves()).toHaveLength(0);
    const input = $('key-openai');
    input.focus();
    typeInto(input, 'sk-proj-pasted-4321');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(chrome.saves()).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(chrome.saves()).toHaveLength(1);
      pagehide();
      await vi.advanceTimersByTimeAsync(1000);
    } finally {
      delete document.visibilityState;
    }
    expect(document.visibilityState).toBe('visible');
    expect(chrome.saves()).toEqual([{ keys: { openai: 'sk-proj-pasted-4321' } }]);
  });
});
