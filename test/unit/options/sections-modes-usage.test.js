// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { CONFIRM_GUARD_MS } from '../../../src/ui/form.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { formatChord } from '../../../src/shared/chord.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const SETTINGS_CHANGE = { settings: { newValue: {} } };
const RESET_PROMPT = 'Click again to reset. Custom modes will be deleted.';
const RESET_HINT = 'Resets modes and prompts, recording limits, silence auto-stop, the hotkey, the pill style, sounds and always-copy. Custom modes are deleted, and site rules that use one lose their mode. Keeps your API keys, provider, spoken languages, dictionary and site rules.';

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

/** Stored settings with a custom mode `custom_1`. */
function withCustomMode() {
  const s = storedSettings();
  s.modes.custom_1 = { name: 'Notes', icon: 'N', prompt: 'Bullet notes.', builtIn: false };
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
    [MSG.GET_USAGE]: () => structuredClone(USAGE),
    [MSG.CLEAR_USAGE]: () => ({ success: true }),
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

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const pagehide = () => window.dispatchEvent(new Event('pagehide'));
const row = (kind, key) => document.querySelector(`[data-focus-key="${kind}:${key}"]`);

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

beforeEach(() => {
  // Every page this file starts shares window: flush any typing save an earlier test left waiting.
  pagehide();
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settings page modes and usage layout', () => {
  const route = (id) => document.querySelector(`section[data-route="${id}"]`);
  const inRoute = (id, elementId) => route(id).contains($(elementId));

  it('Modes and Usage and data hold the popup ids', async () => {
    await start(fakeChrome(), 'modes');
    for (const id of ['add-mode', 'mode-list', 'mode-editor', 'editor-title', 'mode-icon', 'mode-name', 'mode-prompt', 'delete-mode', 'close-mode', 'create-mode']) {
      expect(inRoute('modes', id), id).toBe(true);
    }
    for (const id of ['refresh-usage', 'clear-usage', 'reset', 'reset-hint', 'usage-today-sessions', 'usage-gemini-cost']) {
      expect(inRoute('settings/usage', id), id).toBe(true);
    }
  });

  it('no card heading repeats its route heading', async () => {
    await start(fakeChrome(), 'modes');
    const cardHeadings = (id) => [...route(id).querySelectorAll('h2')].map((h) => h.textContent.trim());
    for (const id of ['modes', 'settings/provider', 'settings/recording', 'settings/speech']) expect(cardHeadings(id), id).toEqual([]);
    expect(cardHeadings('settings/usage')).toEqual(['Usage']);
    expect(route('modes').querySelector('.card-head #add-mode')).not.toBeNull();
  });

  it('every aria-labelledby names a heading on the page', async () => {
    await start(fakeChrome(), 'modes');
    for (const node of document.querySelectorAll('[aria-labelledby]')) {
      for (const id of node.getAttribute('aria-labelledby').split(/\s+/)) expect($(id), id).not.toBeNull();
    }
    expect($('mode-list').getAttribute('aria-labelledby')).toBe(route('modes').querySelector('h1').id);
    const providerGroup = document.querySelector('[role="radiogroup"]');
    expect(providerGroup.getAttribute('aria-labelledby')).toBe(route('settings/provider').querySelector('h1').id);
  });
});

describe('settings page usage', () => {
  it('fills the usage table per period and per provider', async () => {
    await start(fakeChrome(), 'settings/usage');
    expect($('usage-today-sessions').textContent).toBe('1');
    expect($('usage-today-audio').textContent).toBe('0:30');
    expect($('usage-week-cost').textContent).toBe('$0.02');
    expect($('usage-total-audio').textContent).toBe('10:10');
    expect($('usage-total-cost').textContent).toBe('$0.21');
    expect($('usage-openai-sessions').textContent).toBe('12');
    expect($('usage-gemini-cost').textContent).toBe('$0.00');
  });

  it('Refresh reloads the table and toasts when usage cannot be read', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'settings/usage');
    chrome.script(MSG.GET_USAGE, { ...structuredClone(USAGE), today: bucket(4, 75, 0.05) }, null);
    $('refresh-usage').click();
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);
    expect($('usage-today-sessions').textContent).toBe('4');
    expect($('usage-today-audio').textContent).toBe('1:15');
    $('refresh-usage').click();
    await flush();
    expect($('toast').textContent).toBe('Could not load usage.');
    expect($('toast').dataset.tone).toBe('error');
    expect($('usage-today-sessions').textContent).toBe('4');
  });

  it('Clear history needs two clicks', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome, 'settings/usage');
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
    await start(chrome, 'settings/usage');
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
    await start(chrome, 'settings/usage');
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
});

describe('settings page reset (V21)', () => {
  /** Every stored field off its default, with the custom mode `custom_1` active. */
  function offDefaults() {
    const s = withCustomMode();
    s.keys.gemini = 'AQ.gemini-key-0001';
    s.modes.email.prompt = 'My own email prompt';
    Object.assign(s, {
      provider: 'gemini', activeMode: 'custom_1', minRecordingTime: 2, maxRecordingTime: 300,
      translateTargetLang: 'German', languages: ['el'], dictionary: { any: ['x'] }, pillGap: 16,
      hotkey: { code: 'KeyD', ctrl: false, shift: false, alt: true, meta: false }, autoStopSilenceSec: 3,
      siteRules: { 'a.com': { hidePill: true, mode: 'custom_1' } }, pillStyle: 'dot', sounds: true, alwaysCopy: true,
    });
    const fresh = freshSettings();
    for (const field of Object.keys(fresh)) {
      if (field !== 'settingsVersion') expect(s[field], field).not.toEqual(fresh[field]);
    }
    return s;
  }

  it('reset keeps the V21 fields and resets the rest', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(offDefaults());
    const page = await start(chrome, 'settings/usage');
    const button = $('reset');
    button.click();
    button.click();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();

    expect(chrome.saves()).toHaveLength(1);
    const patch = chrome.saves()[0];
    for (const kept of ['keys', 'provider', 'languages', 'dictionary', 'siteRules', 'settingsVersion']) {
      expect(Object.hasOwn(patch, kept), kept).toBe(false);
    }
    expect(patch.modes).toEqual(freshSettings().modes);
    expect(patch).toMatchObject({ activeMode: 'default', pillStyle: 'pill', sounds: false, alwaysCopy: false });
    const { settingsVersion, keys, provider, languages, dictionary, siteRules, ...reset } = freshSettings();
    expect(patch).toEqual(reset);

    expect(page.settings.keys).toEqual({ openai: 'sk-proj-abcdefgh1234', gemini: 'AQ.gemini-key-0001' });
    expect(page.settings.siteRules).toEqual({ 'a.com': { hidePill: true, mode: 'custom_1' } });
    expect($('max-time').value).toBe('120');
    expect($('hotkey').textContent).toBe(formatChord(freshSettings().hotkey));
    expect(row('select', 'custom_1')).toBeNull();
    expect($('toast').textContent).toBe('Settings reset');
  });

  it('reset shows the V21 prompt and hint', async () => {
    await start(fakeChrome(), 'settings/usage');
    const button = $('reset');
    expect(button.textContent).toBe('Reset to defaults');
    expect($('reset-hint').textContent).toBe(RESET_HINT);
    button.click();
    expect(button.textContent).toBe(RESET_PROMPT);
  });

  it('reset closes the mode editor first and saves its waiting edit before resetting', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(withCustomMode());
    await start(chrome, 'settings/usage');
    row('edit', 'custom_1').click();
    typeInto($('mode-name'), 'Renamed');
    const button = $('reset');
    button.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect($('mode-editor').hidden).toBe(true);
    expect(chrome.saves()).toHaveLength(2);
    expect(chrome.saves()[0].modes.custom_1.name).toBe('Renamed');
    expect(chrome.saves()[1].modes).toEqual(freshSettings().modes);
    typeInto($('mode-name'), 'Again');
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.saves()).toHaveLength(2);
  });
});

describe('settings page modes', () => {
  it('mode names and icons render as text', async () => {
    const stored = storedSettings();
    stored.modes.custom_x = { name: '<img src=x onerror=alert(1)>', icon: '<b>', prompt: '', builtIn: false };
    await start(fakeChrome(stored), 'modes');
    expect(document.querySelector('#mode-list img, #mode-list b')).toBeNull();
    expect($('mode-list').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('choosing a mode saves activeMode', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    row('select', 'email').click();
    await flush();
    expect(chrome.saves()).toEqual([{ activeMode: 'email' }]);
    expect(row('select', 'email').getAttribute('aria-pressed')).toBe('true');
    expect(row('select', 'default').getAttribute('aria-pressed')).toBe('false');
  });

  it('the first click after typing in the mode editor selects the mode', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    const items = () => [...document.querySelectorAll('#mode-list .mode')];
    const before = items();
    const email = row('select', 'email');
    row('edit', 'email').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Write it as a short email.');
    // In Chrome the mousedown on a row blurs the prompt, whose save renders before mouseup;
    // a row replaced in between never gets its click.
    prompt.blur();
    expect(chrome.saves()).toHaveLength(1);
    expect(items()).toHaveLength(before.length);
    items().forEach((item, i) => expect(item).toBe(before[i]));
    expect(email.isConnected).toBe(true);
    expect(email.querySelector('.mode-preview').textContent).toBe('Write it as a short email.');

    email.click();
    await flush();
    expect(chrome.saves()).toHaveLength(2);
    expect(chrome.saves()[0].modes.email.prompt).toBe('Write it as a short email.');
    expect(chrome.saves()[1]).toEqual({ activeMode: 'email' });
    expect($('toast').textContent).toBe('Mode: Email');
    expect(row('select', 'email')).toBe(email);
    expect(email.getAttribute('aria-pressed')).toBe('true');
    expect(email.querySelector('.mode-check')).not.toBeNull();
    const plain = row('select', 'default');
    expect(plain.getAttribute('aria-pressed')).toBe('false');
    expect(plain.querySelector('.mode-check')).toBeNull();
  });

  it('a saved mode edit updates its row in place', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    const item = row('select', 'email').closest('li');
    row('edit', 'email').click();
    for (const [id, value] of [['mode-name', 'Mail'], ['mode-icon', 'M']]) {
      const field = $(id);
      field.focus();
      typeInto(field, value);
      field.blur();
    }
    await flush();
    expect(Object.keys(chrome.saves().at(-1))).toEqual(['modes']);
    expect(chrome.saves().at(-1).modes.email).toMatchObject({ name: 'Mail', icon: 'M', builtIn: true });
    expect(row('select', 'email').closest('li')).toBe(item);
    expect(item.querySelector('.mode-icon').textContent).toBe('M');
    expect(item.querySelector('.mode-name').firstChild.textContent).toBe('Mail');
    expect(item.querySelector('.mode-badge').textContent).toBe('Built-in');
    expect(item.querySelector('.icon-btn').getAttribute('aria-label')).toBe('Edit Mail');
    expect($('mode-list').querySelectorAll('.mode')).toHaveLength(4);
  });

  it('the editor creates and deletes a custom mode', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'modes');
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

    row('edit', key).click();
    expect($('delete-mode').hidden).toBe(false);
    $('delete-mode').click();
    await flush();
    expect(Object.hasOwn(chrome.saves().at(-1).modes, key)).toBe(false);
    expect($('mode-editor').hidden).toBe(true);
  });

  it('deleting the active custom mode makes Default active', async () => {
    const stored = withCustomMode();
    stored.activeMode = 'custom_1';
    const chrome = fakeChrome(stored);
    await start(chrome, 'modes');
    row('edit', 'custom_1').click();
    $('delete-mode').click();
    await flush();
    expect(chrome.saves()).toEqual([{ activeMode: 'default', modes: freshSettings().modes }]);
    expect($('toast').textContent).toBe('Mode deleted');
    expect(row('select', 'default').getAttribute('aria-pressed')).toBe('true');
  });

  it('there is no Save mode button for an existing mode', async () => {
    await start(fakeChrome(), 'modes');
    row('edit', 'email').click();
    const labels = [...$('mode-editor').querySelectorAll('button')].filter((b) => !b.hidden).map((b) => b.textContent.trim());
    expect(labels).toEqual(['Close']);
    expect(document.getElementById('save-mode')).toBeNull();
    $('close-mode').click();
    expect($('mode-editor').hidden).toBe(true);
  });

  it('typing in an existing mode prompt then blurring saves it', async () => {
    const chrome = fakeChrome();
    const page = await start(chrome, 'modes');
    row('edit', 'email').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Write it as a short email.  ');
    expect(chrome.saves()).toHaveLength(0);
    prompt.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email).toEqual({ ...freshSettings().modes.email, prompt: 'Write it as a short email.' });
    expect(page.settings.modes.email.prompt).toBe('Write it as a short email.');
    expect($('mode-list').textContent).toContain('Write it as a short email.');
    expect($('mode-editor').hidden).toBe(false);
  });

  it('mode edits also save 400 ms after the last input', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    row('edit', 'email').click();
    const name = $('mode-name');
    typeInto(name, 'Mail');
    await vi.advanceTimersByTimeAsync(250);
    typeInto($('mode-icon'), 'M');
    await vi.advanceTimersByTimeAsync(399);
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
    const page = await start(chrome, 'modes');
    row('edit', 'email').click();
    const name = $('mode-name');
    name.focus();
    typeInto(name, '   ');
    name.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect(page.settings.modes.email.name).toBe('Email');
    expect($('toast').textContent).toBe('Enter a mode name');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('a new mode needs the Create button once, then further edits autosave', async () => {
    const chrome = fakeChrome();
    await start(chrome, 'modes');
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
    const page = await start(chrome, 'modes');
    const saved = freshSettings().modes.email.prompt;
    row('edit', 'email').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Short email.');
    prompt.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(1);
    expect(page.settings.modes.email.prompt).toBe(saved);
    expect(prompt.value).toBe(saved);
    expect($('toast').textContent).toBe('Storage is full.');
  });

  it('Close saves an edit still waiting for the typing pause', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    row('edit', 'email').click();
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
    await start(chrome, 'modes');
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
    await start(fakeChrome(stored), 'modes');
    const names = () => [...document.querySelectorAll('#mode-list .mode-name')].map((n) => n.firstChild.textContent);
    expect(names()).toEqual(['Default', 'Email', 'Translate', 'Instruct', 'First', 'Second']);

    $('add-mode').click();
    $('mode-name').value = 'Third';
    $('create-mode').click();
    await flush();
    expect(names()).toEqual(['Default', 'Email', 'Translate', 'Instruct', 'First', 'Second', 'Third']);
  });

  it('built-in modes have no delete button', async () => {
    await start(fakeChrome(), 'modes');
    row('edit', 'email').click();
    expect($('mode-editor').hidden).toBe(false);
    expect($('delete-mode').hidden).toBe(true);
    expect($('mode-name').value).toBe('Email');
  });

  it('a mode deleted on the page keeps a mode edit typed in another tab out', async () => {
    const chrome = fakeChrome(withCustomMode());
    const page = await start(chrome, 'modes');
    row('edit', 'custom_1').click();
    chrome.script(MSG.GET_SETTINGS, storedSettings());
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(Object.hasOwn(page.settings.modes, 'custom_1')).toBe(false);
    expect(row('select', 'custom_1')).toBeNull();
    const name = $('mode-name');
    name.focus();
    typeInto(name, 'Typed after the delete');
    name.blur();
    await flush();
    expect(chrome.saves()).toHaveLength(0);
    expect(Object.hasOwn(page.settings.modes, 'custom_1')).toBe(false);
  });

  it('an external change re-renders the list and never overwrites the field being typed in', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    const page = await start(chrome, 'modes');
    row('edit', 'email').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Typed here.');
    await vi.advanceTimersByTimeAsync(200);
    const external = storedSettings();
    external.activeMode = 'email';
    external.modes.email.name = 'Mail';
    chrome.script(MSG.GET_SETTINGS, external);
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(page.settings.modes.email.name).toBe('Mail');
    expect(row('select', 'email').getAttribute('aria-pressed')).toBe('true');
    expect($('mode-name').value).toBe('Mail');
    expect(prompt.value).toBe('Typed here.');
    await vi.advanceTimersByTimeAsync(400);
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email).toMatchObject({ name: 'Mail', prompt: 'Typed here.' });
  });

  it('pagehide within 400 ms of typing a mode prompt saves it', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome, 'modes');
    row('edit', 'email').click();
    const prompt = $('mode-prompt');
    prompt.focus();
    typeInto(prompt, 'Short email.');
    await vi.advanceTimersByTimeAsync(300);
    expect(chrome.saves()).toHaveLength(0);
    pagehide();
    expect(chrome.saves()).toHaveLength(1);
    expect(chrome.saves()[0].modes.email.prompt).toBe('Short email.');
  });
});
