// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../../../src/popup/popup.js';
import { parseKeywords, CONFIRM_GUARD_MS } from '../../../src/popup/form.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, AUTO_STOP_CHOICES } from '../../../src/shared/defaults.js';
import { formatChord } from '../../../src/shared/chord.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const POPUP_DIR = join(import.meta.dirname, '../../../src/popup');
const HTML = readFileSync(join(POPUP_DIR, 'popup.html'), 'utf8');
const CSS = readFileSync(join(POPUP_DIR, 'popup.css'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';

function bucket(sessions, audioSeconds, cost) {
  return {
    sessions, audioSeconds, estimatedCost: cost, modes: {},
    byProvider: { openai: { sessions, audioSeconds, cost }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
  };
}
const USAGE = { today: bucket(1, 30, 0.002), last7Days: bucket(3, 95, 0.02), total: bucket(12, 610, 0.21) };

function storedSettings(keys = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '', ...keys };
  return s;
}

/**
 * Fake chrome for the popup. `script(action, ...responses)` queues one-shot answers;
 * without a queued answer each action gets a success default.
 */
function fakeChrome(stored = storedSettings()) {
  const queues = new Map();
  const sent = [];
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(stored),
    [MSG.SAVE_SETTINGS]: () => ({ success: true }),
    [MSG.GET_USAGE]: () => structuredClone(USAGE),
    [MSG.CLEAR_USAGE]: () => ({ success: true }),
    [MSG.VALIDATE_KEY]: () => ({ ok: true }),
  };
  return {
    sent,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    count: (action) => sent.filter((m) => m.action === action).length,
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        const queue = queues.get(message.action);
        if (queue?.length) return queue.shift();
        return defaults[message.action]?.(message);
      }),
      getManifest: () => ({ version: '2.1.0' }),
    },
    tabs: { create: vi.fn(async () => ({})) },
  };
}

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const start = (chrome) => initPopup({ chrome, document, window });

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
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('popup layout', () => {
  it('renders the sections in spec order with the version', async () => {
    await start(fakeChrome());
    const titles = [...document.querySelectorAll('main > section h2')].map((h) => h.textContent.trim());
    expect(titles).toEqual(['Provider', 'Recording', 'Speech', 'Modes', 'Usage', 'About']);
    expect($('version').textContent).toBe('Version 2.1.0');
    expect($('status-text').textContent).toBe('Ready');
    expect($('banner').hidden).toBe(true);
  });

  it('fills the usage table per period and per provider', async () => {
    await start(fakeChrome());
    expect($('usage-today-sessions').textContent).toBe('1');
    expect($('usage-today-audio').textContent).toBe('0:30');
    expect($('usage-week-cost').textContent).toBe('$0.02');
    expect($('usage-total-audio').textContent).toBe('10:10');
    expect($('usage-total-cost').textContent).toBe('$0.21');
    expect($('usage-openai-sessions').textContent).toBe('12');
    expect($('usage-gemini-cost').textContent).toBe('$0.00');
  });

  it('opens the About links in a new tab', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const github = document.querySelector('a[href="https://github.com/kskarakostas/VoiceType"]');
    github.click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com/kskarakostas/VoiceType' });
    expect(document.querySelector('a[href$="/PRIVACY.md"]')).not.toBeNull();
  });
});

describe('popup autosave', () => {
  it('failed save reverts the control and in-memory value', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' }, { success: false, error: 'Storage is full.' });
    const popup = await start(chrome);

    change($('max-time'), '300');
    expect(popup.settings.maxRecordingTime).toBe(300);
    await flush();
    expect($('max-time').value).toBe('120');
    expect(popup.settings.maxRecordingTime).toBe(120);
    expect($('toast').textContent).toBe('Storage is full.');
    expect($('toast').dataset.tone).toBe('error');

    const gemini = document.querySelector('input[name="provider"][value="gemini"]');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(document.querySelector('input[name="provider"]:checked').value).toBe('openai');
    expect(popup.settings.provider).toBe('openai');
    expect($('key-row-gemini').hidden).toBe(true);
  });

  it('switching provider saves and shows that key row', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const gemini = document.querySelector('input[name="provider"][value="gemini"]');
    gemini.checked = true;
    change(gemini);
    await flush();
    expect(chrome.saves().at(-1).provider).toBe('gemini');
    expect($('key-row-gemini').hidden).toBe(false);
    expect($('key-row-openai').hidden).toBe(true);
    expect($('status-text').textContent).toBe('Add API key');
  });

  it('min and max recording save as numbers', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    change($('min-time'), '0.5');
    await flush();
    change($('max-time'), '60');
    await flush();
    expect(chrome.saves().at(-1)).toMatchObject({ minRecordingTime: 0.5, maxRecordingTime: 60 });
  });

  it('silence auto-stop saves numbers from AUTO_STOP_CHOICES', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const select = $('auto-stop');
    expect([...select.options].map((o) => o.value)).toEqual(AUTO_STOP_CHOICES.map(String));
    expect([...select.options].map((o) => o.textContent)).toEqual(['Off', '2 s', '3 s', '5 s']);
    expect(select.value).toBe('0');
    for (const seconds of AUTO_STOP_CHOICES.slice(1)) {
      change(select, String(seconds));
      await flush();
      expect(chrome.saves().at(-1).autoStopSilenceSec).toBe(seconds);
    }
  });
});

describe('popup keys', () => {
  it('paste then blur saves the key', async () => {
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    const popup = await start(chrome);
    expect($('status-text').textContent).toBe('Add API key');
    const input = $('key-openai');
    input.focus();
    typeInto(input, '  sk-proj-new-key-5678  ');
    input.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].keys.openai).toBe('sk-proj-new-key-5678');
    expect(popup.settings.keys.openai).toBe('sk-proj-new-key-5678');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('sk-p…5678 (saved)');
    expect($('toast').textContent).toBe('Key saved');
    expect($('status-text').textContent).toBe('Ready');
  });

  it('a key also saves 800 ms after the last input', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    await start(chrome);
    const input = $('key-openai');
    input.focus();
    typeInto(input, 'sk-proj-typed');
    await vi.advanceTimersByTimeAsync(500);
    typeInto(input, 'sk-proj-typed-9999');
    await vi.advanceTimersByTimeAsync(799);
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].keys.openai).toBe('sk-proj-typed-9999');
    expect(input.value).toBe('sk-proj-typed-9999');
    input.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(input.value).toBe('');
  });

  it('Clear empties the key and Test validates the typed key', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto($('key-openai'), 'sk-proj-candidate');
    $('test-openai').click();
    await flush();
    expect(chrome.sent.find((m) => m.action === MSG.VALIDATE_KEY)).toEqual({ action: MSG.VALIDATE_KEY, provider: 'openai', key: 'sk-proj-candidate' });
    expect($('toast').textContent).toBe('OpenAI key works');
    $('clear-openai').click();
    await flush();
    expect(chrome.saves().at(-1).keys.openai).toBe('');
    expect($('key-openai').placeholder).toBe('sk-...');
    expect($('status-text').textContent).toBe('Add API key');
  });
});

describe('popup load failure', () => {
  it('shows a persistent banner and disables saving', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, null);
    const popup = await start(chrome);
    expect(popup.loaded).toBe(false);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);

    change($('max-time'), '300');
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect($('max-time').value).toBe('120');
    expect($('toast').hidden).toBe(false);
    expect($('toast').textContent).toBe('Settings are not loaded. Nothing was saved.');

    await vi.advanceTimersByTimeAsync(10_000);
    expect($('toast').hidden).toBe(true);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
  });

  it('a later toast does not remove the banner', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, undefined);
    await start(chrome);
    typeInto($('key-openai'), 'sk-proj-candidate');
    $('test-openai').click();
    await flush();
    expect($('toast').textContent).toBe('OpenAI key works');
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
  });
});

describe('popup inline confirms', () => {
  it('Clear history needs two clicks', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('clear-usage');
    button.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_USAGE)).toBe(0);
    expect(button.textContent).toBe('Click again to clear usage history');
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_USAGE)).toBe(1);
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);
    expect($('toast').textContent).toBe('Usage history cleared');
    expect(button.textContent).toBe('Clear history');
  });

  it('a double click does not clear usage history', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const button = $('clear-usage');
    button.click();
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    await flush();
    expect(chrome.count(MSG.CLEAR_USAGE)).toBe(0);
    expect(button.textContent).toBe('Click again to clear usage history');
  });

  it('Clear history toasts success only on { success: true }', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    chrome.script(MSG.CLEAR_USAGE, { success: false }, undefined);
    await start(chrome);
    const button = $('clear-usage');
    button.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect($('toast').textContent).toBe('Could not clear usage history.');
    expect($('toast').dataset.tone).toBe('error');
    button.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect($('toast').textContent).toBe('Could not clear usage history.');
    expect(chrome.count(MSG.GET_USAGE)).toBe(1);
  });

  it('reset keeps keys, provider, languages and keywords', async () => {
    const stored = storedSettings({ gemini: 'AQ.gemini-key-0001' });
    Object.assign(stored, {
      provider: 'gemini', languages: ['en', 'el'], keywords: ['Palowise'], maxRecordingTime: 300, autoStopSilenceSec: 3,
      hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false }, activeMode: 'custom_1',
    });
    stored.modes.custom_1 = { name: 'Notes', icon: 'N', prompt: 'Bullet notes.', builtIn: false };
    stored.modes.email.prompt = 'My own email prompt';
    vi.useFakeTimers();
    const chrome = fakeChrome(stored);
    await start(chrome);

    const button = $('reset');
    button.click();
    expect(button.textContent).toBe('Click again to reset modes, prompts, recording limits, silence auto-stop and hotkey');
    button.click();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect(chrome.saves().at(-1)).toEqual({
      ...freshSettings(),
      keys: { openai: 'sk-proj-abcdefgh1234', gemini: 'AQ.gemini-key-0001' },
      provider: 'gemini', languages: ['en', 'el'], keywords: ['Palowise'],
    });
    expect($('max-time').value).toBe('120');
    expect($('hotkey').textContent).toBe(formatChord(freshSettings().hotkey));
    expect($('toast').textContent).toBe('Settings reset');
  });
});

describe('popup hotkey recorder', () => {
  it('saves a valid chord', async () => {
    const chrome = fakeChrome();
    await start(chrome);
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
    expect(chrome.saves().at(-1).hotkey).toEqual(chord);
    expect(button.textContent).toBe(formatChord(chord));
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  it('rejects Shift+Space with the hint', async () => {
    const chrome = fakeChrome();
    await start(chrome);
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
    await start(chrome);
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

describe('popup speech', () => {
  it('languages Auto clears the list', async () => {
    const stored = storedSettings();
    stored.languages = ['en', 'el'];
    const chrome = fakeChrome(stored);
    await start(chrome);
    const auto = $('lang-auto');
    expect(auto.checked).toBe(false);
    expect($('lang-en').checked).toBe(true);
    auto.checked = true;
    change(auto);
    await flush();
    expect(chrome.saves().at(-1).languages).toEqual([]);
    expect($('lang-en').checked).toBe(false);
    expect($('lang-el').checked).toBe(false);

    const german = $('lang-de');
    german.checked = true;
    change(german);
    await flush();
    expect(chrome.saves().at(-1).languages).toEqual(['de']);
    expect(auto.checked).toBe(false);
  });

  it('vocabulary textarea saves parseKeywords output', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const area = $('keywords');
    const text = ' Palowise \n\npalowise\nCommetric\n';
    area.focus();
    area.value = text;
    change(area);
    area.blur();
    await flush();
    expect(chrome.saves().at(-1).keywords).toEqual(parseKeywords(text));
    expect(area.value).toBe('Palowise\nCommetric');
    expect($('keyword-count').textContent).toBe('2 of 100 terms');
  });
});

describe('popup modes', () => {
  it('mode names and icons render as text', async () => {
    const stored = storedSettings();
    stored.modes.custom_x = { name: '<img src=x onerror=alert(1)>', icon: '<b>', prompt: '', builtIn: false };
    await start(fakeChrome(stored));
    expect(document.querySelector('#mode-list img, #mode-list b')).toBeNull();
    expect($('mode-list').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('choosing a mode saves activeMode', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const email = document.querySelector('[data-focus-key="select:email"]');
    email.click();
    await flush();
    expect(chrome.saves().at(-1).activeMode).toBe('email');
    expect(document.querySelector('[data-focus-key="select:email"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-focus-key="select:default"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('the editor creates and deletes a custom mode', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('add-mode').click();
    expect($('mode-editor').hidden).toBe(false);
    expect($('delete-mode').hidden).toBe(true);
    $('mode-name').value = 'Notes';
    $('mode-icon').value = 'N';
    $('mode-prompt').value = 'Turn this into bullet notes.';
    $('create-mode').click();
    await flush();
    const modes = chrome.saves().at(-1).modes;
    const key = Object.keys(modes).find((k) => k.startsWith('custom_'));
    expect(modes[key]).toEqual({ name: 'Notes', icon: 'N', prompt: 'Turn this into bullet notes.', builtIn: false });
    $('close-mode').click();
    expect($('mode-editor').hidden).toBe(true);

    document.querySelector(`[data-focus-key="edit:${key}"]`).click();
    expect($('delete-mode').hidden).toBe(false);
    $('delete-mode').click();
    await flush();
    expect(Object.hasOwn(chrome.saves().at(-1).modes, key)).toBe(false);
    expect($('mode-editor').hidden).toBe(true);
  });

  it('there is no Save mode button for an existing mode', async () => {
    await start(fakeChrome());
    document.querySelector('[data-focus-key="edit:email"]').click();
    const labels = [...$('mode-editor').querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent.trim());
    expect(labels).toEqual(['Close']);
    expect(document.getElementById('save-mode')).toBeNull();
    $('close-mode').click();
    expect($('mode-editor').hidden).toBe(true);
  });

  it('typing in an existing mode prompt then blurring saves it', async () => {
    const chrome = fakeChrome();
    const popup = await start(chrome);
    document.querySelector('[data-focus-key="edit:email"]').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Write it as a short email.  ');
    expect(chrome.saves()).toHaveLength(0);
    prompt.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email).toEqual({ ...freshSettings().modes.email, prompt: 'Write it as a short email.' });
    expect(popup.settings.modes.email.prompt).toBe('Write it as a short email.');
    expect($('mode-list').textContent).toContain('Write it as a short email.');
    expect($('mode-editor').hidden).toBe(false);
  });

  it('mode edits also save 800 ms after the last input', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    document.querySelector('[data-focus-key="edit:email"]').click();
    const name = $('mode-name');
    typeInto(name, 'Mail');
    await vi.advanceTimersByTimeAsync(500);
    typeInto($('mode-icon'), 'M');
    await vi.advanceTimersByTimeAsync(799);
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email).toMatchObject({ name: 'Mail', icon: 'M', builtIn: true });
    name.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
  });

  it('an empty mode name is not saved', async () => {
    const chrome = fakeChrome();
    const popup = await start(chrome);
    document.querySelector('[data-focus-key="edit:email"]').click();
    const name = $('mode-name');
    name.focus();
    typeInto(name, '   ');
    name.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect(popup.settings.modes.email.name).toBe('Email');
    expect($('toast').textContent).toBe('Enter a mode name');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('a new mode needs the Create button once, then further edits autosave', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('add-mode').click();
    expect($('create-mode').hidden).toBe(false);
    expect($('close-mode').textContent).toBe('Cancel');
    for (const [id, value] of [['mode-name', 'Notes'], ['mode-icon', 'N'], ['mode-prompt', 'Bullet notes.']]) {
      const field = $(id);
      field.focus();
      typeInto(field, value);
      change(field);
      field.blur();
    }
    await flush();
    expect(chrome.saves()).toHaveLength(0);

    $('create-mode').click();
    $('create-mode').click();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    const customKeys = (modes) => Object.keys(modes).filter((k) => k.startsWith('custom_'));
    const [key] = customKeys(chrome.saves()[0].modes);
    expect(chrome.saves()[0].modes[key]).toEqual({ name: 'Notes', icon: 'N', prompt: 'Bullet notes.', builtIn: false });
    expect($('toast').textContent).toBe('Mode created');
    expect($('mode-editor').hidden).toBe(false);
    expect($('create-mode').hidden).toBe(true);
    expect($('close-mode').textContent).toBe('Close');
    expect($('delete-mode').hidden).toBe(false);

    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Bullet notes, one line each.');
    prompt.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(2);
    expect(customKeys(chrome.saves()[1].modes)).toEqual([key]);
    expect(chrome.saves()[1].modes[key].prompt).toBe('Bullet notes, one line each.');
  });

  it('a failed mode save reverts the editor and the in-memory mode', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' });
    const popup = await start(chrome);
    const saved = freshSettings().modes.email.prompt;
    document.querySelector('[data-focus-key="edit:email"]').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Short email.');
    prompt.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(popup.settings.modes.email.prompt).toBe(saved);
    expect(prompt.value).toBe(saved);
    expect($('toast').textContent).toBe('Storage is full.');
  });

  it('Close saves an edit still waiting for the typing pause', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    document.querySelector('[data-focus-key="edit:email"]').click();
    typeInto($('mode-name'), 'Mail');
    $('close-mode').click();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email.name).toBe('Mail');
    expect($('mode-editor').hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.saves()).toHaveLength(1);
  });

  it('a new mode without a name is not created', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('add-mode').click();
    $('create-mode').click();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect($('toast').textContent).toBe('Enter a mode name');
    expect($('create-mode').hidden).toBe(false);
  });

  it('custom modes render after the built-ins, oldest first', async () => {
    // chrome.storage hands objects back with their keys sorted: custom_ before default.
    const stored = storedSettings();
    const { default: plain, email, instruct, translate } = stored.modes;
    stored.modes = {
      custom_10: { name: 'Second', icon: '2', prompt: '', builtIn: false },
      custom_2: { name: 'First', icon: '1', prompt: '', builtIn: false },
      default: plain, email, instruct, translate,
    };
    await start(fakeChrome(stored));
    const names = () => [...document.querySelectorAll('#mode-list .mode-name')].map((n) => n.firstChild.textContent);
    expect(names()).toEqual(['Default', 'Email', 'Translate', 'Instruct', 'First', 'Second']);

    $('add-mode').click();
    $('mode-name').value = 'Third';
    $('create-mode').click();
    await flush();
    expect(names()).toEqual(['Default', 'Email', 'Translate', 'Instruct', 'First', 'Second', 'Third']);
  });

  it('built-in modes have no delete button', async () => {
    await start(fakeChrome());
    document.querySelector('[data-focus-key="edit:email"]').click();
    expect($('mode-editor').hidden).toBe(false);
    expect($('delete-mode').hidden).toBe(true);
    expect($('mode-name').value).toBe('Email');
  });
});

describe('popup stylesheet and markup', () => {
  function tokens(block) {
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  const PAIRS = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text', 'accent-soft'],
    ['text-2', 'surface'], ['text-2', 'surface-2'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['muted', 'accent-soft'],
    ['accent', 'surface'], ['accent', 'accent-soft'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'],
    ['danger', 'surface'], ['danger', 'danger-soft'], ['on-accent', 'danger'],
    ['success', 'surface'], ['on-accent', 'success'], ['warning', 'surface'], ['surface', 'text'],
  ];

  it('contrast tokens meet 4.5:1 in light and dark', () => {
    const light = tokens(CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {'))));
    const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
    const dark = { ...light, ...tokens(CSS.slice(darkStart, CSS.indexOf('}', darkStart))) };
    expect(darkStart).toBeGreaterThan(0);
    for (const [scheme, t] of [['light', light], ['dark', dark]]) {
      for (const [fg, bg] of PAIRS) {
        expect(t[fg], `${scheme} --${fg}`).toBeDefined();
        expect(t[bg], `${scheme} --${bg}`).toBeDefined();
        expect(contrast(t[fg], t[bg]), `${scheme} --${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses no font size under 12 px', () => {
    const sizes = [...CSS.matchAll(/font(?:-size)?:\s*([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)px/g)].map((n) => Number(n[1])));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toBeGreaterThanOrEqual(12);
    expect(CSS).not.toMatch(/font(?:-size)?:[^;]*\d(?:em|rem|pt)\b/);
  });

  it('draws visible focus rings and follows the dark scheme', () => {
    expect(CSS).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus\)/);
    expect(CSS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('popup.html carries no emoji and no inline handlers', () => {
    expect(HTML).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
