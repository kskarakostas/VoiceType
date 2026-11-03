// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../../../src/popup/popup.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/popup/popup.html'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const ORIGIN = 'chrome-extension://id';
const SETTINGS_CHANGE = { settings: { newValue: {} } };

function bucket(sessions, cost) {
  return { sessions, audioSeconds: 30 * sessions, estimatedCost: cost, modes: {}, byProvider: {} };
}
const USAGE = { today: bucket(4, 0.0123), last7Days: bucket(9, 0.05), total: bucket(30, 0.4) };

function storedSettings(keys = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '', ...keys };
  return s;
}

/**
 * Fake chrome for the popup. `script(action, ...responses)` queues one-shot answers; without a
 * queued answer each action gets a success default, and a successful save updates `stored`.
 * `fire(changes, area)` plays a storage.onChanged event. `contexts` is what runtime.getContexts
 * returns.
 */
function fakeChrome(stored = storedSettings(), contexts = []) {
  const queues = new Map();
  const sent = [];
  const changeListeners = new Set();
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(stored),
    [MSG.SAVE_SETTINGS]: (message) => {
      Object.assign(stored, structuredClone(message.settings));
      return { success: true };
    },
    [MSG.GET_USAGE]: () => structuredClone(USAGE),
  };
  return {
    sent,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    fire(changes, area) { for (const listener of [...changeListeners]) listener(changes, area); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        const queue = queues.get(message.action);
        if (queue?.length) return queue.shift();
        return defaults[message.action]?.(message);
      }),
      getURL: vi.fn((path) => `${ORIGIN}/${path}`),
      getContexts: vi.fn(async () => contexts),
    },
    tabs: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    windows: { update: vi.fn(async () => ({})) },
    storage: {
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.add(listener)),
        removeListener: vi.fn((listener) => changeListeners.delete(listener)),
      },
    },
  };
}

const $ = (id) => document.getElementById(id);
const flush = () => new Promise((r) => setTimeout(r, 0));
const start = (chrome) => initPopup({ chrome, document, window });
const radio = (value) => document.querySelector(`input[name="provider"][value="${value}"]`);
const checkedProvider = () => document.querySelector('input[name="provider"]:checked')?.value;

function change(el, value) {
  if (value !== undefined) el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function choose(value) {
  radio(value).checked = true;
  change(radio(value));
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('popup quick panel', () => {
  it('renders the quick panel in spec order', async () => {
    await start(fakeChrome());
    const order = [...document.querySelectorAll('#status, main > section h2, #open-settings')]
      .map((node) => (node.id === 'status' || node.id === 'open-settings' ? node.id : node.textContent.trim()));
    expect(order).toEqual(['status', 'Provider', 'Mode', 'This site', 'Today', 'open-settings']);
    expect($('open-settings').textContent.trim()).toBe('Open settings');
    expect($('banner').hidden).toBe(true);
    expect($('site-block').querySelector('h2').textContent.trim()).toBe('This site');
    expect($('site-block').textContent).toContain('Site controls are coming in a later update.');
  });

  it('status is Ready with a key, and Add API key opens Settings, Provider', async () => {
    const ready = fakeChrome();
    await start(ready);
    expect($('status-ready').hidden).toBe(false);
    expect($('status-ready').textContent.trim()).toBe('Ready');
    expect($('add-key').hidden).toBe(true);

    document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
    const chrome = fakeChrome(storedSettings({ openai: '   ' }));
    await start(chrome);
    expect($('status-ready').hidden).toBe(true);
    expect($('add-key').hidden).toBe(false);
    expect($('add-key').textContent.trim()).toBe('Add API key');

    $('add-key').click();
    await flush();
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'] });
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/options.html#settings/provider` });
    expect(window.close).toHaveBeenCalledTimes(1);
    const [contexts] = chrome.runtime.getContexts.mock.invocationCallOrder;
    const [create] = chrome.tabs.create.mock.invocationCallOrder;
    const [close] = window.close.mock.invocationCallOrder;
    expect(contexts).toBeLessThan(create);
    expect(create).toBeLessThan(close);
  });

  it('switching provider saves only the provider', async () => {
    const chrome = fakeChrome();
    const popup = await start(chrome);
    choose('gemini');
    await flush();
    expect(chrome.saves()).toEqual([{ provider: 'gemini' }]);
    expect(popup.settings.provider).toBe('gemini');
    expect(checkedProvider()).toBe('gemini');
    expect($('add-key').hidden).toBe(false);
  });

  it('the mode select lists modes in display order and saves only activeMode', async () => {
    const stored = storedSettings();
    // Stored first, as chrome.storage hands keys back sorted.
    stored.modes = { custom_1: { name: 'Standup', icon: '', prompt: 'Bullets.', builtIn: false }, ...stored.modes };
    const chrome = fakeChrome(stored);
    const popup = await start(chrome);
    const select = $('active-mode');
    expect([...select.options].map((o) => o.value)).toEqual(['default', 'email', 'translate', 'instruct', 'custom_1']);
    expect([...select.options].map((o) => o.textContent))
      .toEqual(['🎤 Default', '📧 Email', '🌐 Translate', '💡 Instruct', '🎯 Standup']);
    expect(select.value).toBe('default');

    change(select, 'custom_1');
    await flush();
    expect(chrome.saves()).toEqual([{ activeMode: 'custom_1' }]);
    expect(popup.settings.activeMode).toBe('custom_1');
    expect($('toast').textContent).toBe('Mode: Standup');
    expect($('toast').dataset.tone).toBe('success');
  });

  it('today shows sessions and cost', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    expect(chrome.sent.some((m) => m.action === MSG.GET_USAGE)).toBe(true);
    expect($('today-sessions').textContent).toBe('4');
    expect($('today-cost').textContent).toBe('$0.01');
  });

  it('today stays at zero when usage cannot be read', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_USAGE, null);
    await start(chrome);
    expect($('today-sessions').textContent).toBe('0');
    expect($('today-cost').textContent).toBe('$0.00');
  });

  it('Open settings opens or focuses the settings tab and closes the popup', async () => {
    const chrome = fakeChrome(storedSettings(), [
      { contextType: 'TAB', tabId: 5, windowId: 2, documentUrl: `${ORIGIN}/popup.html` },
      { contextType: 'TAB', tabId: 7, windowId: 3, documentUrl: `${ORIGIN}/options.html#modes` },
    ]);
    await start(chrome);
    $('open-settings').click();
    await flush();
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true });
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(window.close).toHaveBeenCalledTimes(1);

    document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
    const fresh = fakeChrome();
    await start(fresh);
    $('open-settings').click();
    await flush();
    expect(fresh.tabs.create).toHaveBeenCalledWith({ url: `${ORIGIN}/options.html#home` });
    expect(window.close).toHaveBeenCalledTimes(2);
  });

  it('a settings tab that cannot open shows an error and keeps the popup open', async () => {
    const chrome = fakeChrome(storedSettings({ openai: '' }));
    chrome.tabs.create.mockRejectedValue(new Error('no tabs'));
    await start(chrome);
    for (const id of ['open-settings', 'add-key']) {
      $('toast').textContent = '';
      $(id).click();
      await flush();
      expect($('toast').textContent, id).toBe('Could not open settings.');
      expect($('toast').dataset.tone, id).toBe('error');
    }
    expect(window.close).not.toHaveBeenCalled();
  });

  it('an external change re-renders the mode select', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    const popup = await start(chrome);
    expect($('active-mode').value).toBe('default');
    const changed = structuredClone(stored);
    changed.activeMode = 'email';
    changed.provider = 'gemini';
    chrome.script(MSG.GET_SETTINGS, changed);
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('active-mode').value).toBe('email');
    expect(checkedProvider()).toBe('gemini');
    expect(popup.settings.activeMode).toBe('email');
    expect(chrome.saves()).toEqual([]);

    chrome.fire(SETTINGS_CHANGE, 'sync');
    await flush();
    expect(chrome.sent.filter((m) => m.action === MSG.GET_SETTINGS)).toHaveLength(2);
  });

  it('a failed save reverts the control', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' }, { success: false });
    const popup = await start(chrome);

    choose('gemini');
    expect(popup.settings.provider).toBe('gemini');
    await flush();
    expect(checkedProvider()).toBe('openai');
    expect(popup.settings.provider).toBe('openai');
    expect($('toast').textContent).toBe('Storage is full.');
    expect($('toast').dataset.tone).toBe('error');

    change($('active-mode'), 'email');
    await flush();
    expect($('active-mode').value).toBe('default');
    expect(popup.settings.activeMode).toBe('default');
    expect($('toast').textContent).toBe('Could not save settings.');
  });

  it('load failure shows the banner and saves nothing', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, { error: 'nope' });
    const popup = await start(chrome);
    expect(popup.loaded).toBe(false);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
    expect($('status-ready').hidden).toBe(true);
    expect($('add-key').hidden).toBe(true);

    choose('gemini');
    change($('active-mode'), 'email');
    await flush();
    expect(chrome.saves()).toEqual([]);
    expect(checkedProvider()).toBe('openai');
    expect($('active-mode').value).toBe('default');
    expect($('toast').textContent).toBe(NOT_LOADED);
    expect($('banner').hidden).toBe(false);
    expect($('status-ready').hidden).toBe(true);
    expect($('add-key').hidden).toBe(true);
  });
});
