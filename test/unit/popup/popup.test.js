// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPopup } from '../../../src/popup/popup.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { withSiteRule } from '../../../src/shared/sites.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/popup/popup.html'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const ORIGIN = 'chrome-extension://id';
const SETTINGS_CHANGE = { settings: { newValue: {} } };
const PAGE_URL = 'https://www.example.com/page';

function bucket(sessions, cost) {
  return { sessions, audioSeconds: 30 * sessions, estimatedCost: cost, modes: {}, byProvider: {} };
}
const USAGE = { today: bucket(4, 0.0123), last7Days: bucket(9, 0.05), total: bucket(30, 0.4) };

function storedSettings(keys = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '', ...keys };
  return s;
}

function withRule(rule, host = 'example.com') {
  const s = storedSettings();
  s.siteRules = { [host]: rule };
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
    [MSG.SET_SITE_RULE]: ({ action: _action, host, ...fields }) => {
      stored.siteRules = withSiteRule(stored.siteRules, host, { hidePill: false, mode: null, ...stored.siteRules[host], ...fields });
      return { success: true };
    },
    [MSG.GET_USAGE]: () => structuredClone(USAGE),
  };
  return {
    sent,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    siteWrites: () => sent.filter((m) => m.action === MSG.SET_SITE_RULE),
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
    tabs: {
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      query: vi.fn(async () => [{ url: PAGE_URL }]),
    },
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
    expect($('copy-last').textContent.trim()).toBe('Copy last');
    expect($('copy-last').compareDocumentPosition($('open-settings'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect($('today-cost').compareDocumentPosition($('copy-last'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect($('site-block').querySelector('h2').textContent.trim()).toBe('This site');
    expect($('site-block').textContent).not.toContain('coming in a later update');
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

describe('popup This site block', () => {
  const blockVisible = () => !$('site-controls').hidden;

  it('shows the host and the rule of the active tab', async () => {
    const chrome = fakeChrome(withRule({ hidePill: true, mode: 'email' }));
    await start(chrome);
    expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(blockVisible()).toBe(true);
    expect($('site-unavailable').hidden).toBe(true);
    expect($('site-host').textContent).toBe('example.com');
    expect($('site-hide').checked).toBe(true);
    expect($('site-mode').value).toBe('email');
    expect($('site-block').textContent).toContain('Hide pill');
    expect($('site-block').textContent).toContain('Mode on this site');
  });

  it('Use active mode is listed first and selected without a mode rule', async () => {
    await start(fakeChrome());
    const select = $('site-mode');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'default', 'email', 'translate', 'instruct']);
    expect(select.options[0].textContent).toBe('Use active mode');
    expect(select.value).toBe('');
    expect($('site-hide').checked).toBe(false);
  });

  it('a rule naming a missing mode shows Use active mode', async () => {
    await start(fakeChrome(withRule({ hidePill: false, mode: 'custom_gone' })));
    expect($('site-mode').value).toBe('');
  });

  it('Hide pill sends only hidePill', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('site-hide').click();
    await flush();
    expect(chrome.siteWrites()).toEqual([
      { action: MSG.SET_SITE_RULE, host: 'example.com', hidePill: true },
    ]);
    expect(chrome.saves()).toEqual([]);
  });

  it('choosing a mode sends it', async () => {
    const chrome = fakeChrome(withRule({ hidePill: true, mode: null }));
    await start(chrome);
    change($('site-mode'), 'translate');
    await flush();
    expect(chrome.siteWrites()).toEqual([
      { action: MSG.SET_SITE_RULE, host: 'example.com', mode: 'translate' },
    ]);
    expect(chrome.saves()).toEqual([]);
  });

  it('Use active mode sends null', async () => {
    const chrome = fakeChrome(withRule({ hidePill: false, mode: 'email' }));
    await start(chrome);
    change($('site-mode'), '');
    await flush();
    expect(chrome.siteWrites()).toEqual([
      { action: MSG.SET_SITE_RULE, host: 'example.com', mode: null },
    ]);
  });

  it('a second quick edit keeps the first', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    await start(chrome);
    $('site-hide').click();
    change($('site-mode'), 'email');
    await flush();
    expect(stored.siteRules).toEqual({ 'example.com': { hidePill: true, mode: 'email' } });
  });

  it('a stale focused select leaves a newer mode alone when Hide pill changes (V18)', async () => {
    const stored = withRule({ hidePill: false, mode: 'email' });
    const chrome = fakeChrome(stored);
    await start(chrome);
    $('site-mode').focus();
    // The pill moves the site on; the focused select is not repainted.
    stored.siteRules = { 'example.com': { hidePill: false, mode: 'translate' } };
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('site-mode').value).toBe('email');
    $('site-hide').click();
    await flush();
    expect(chrome.siteWrites()).toEqual([{ action: MSG.SET_SITE_RULE, host: 'example.com', hidePill: true }]);
    expect(stored.siteRules).toEqual({ 'example.com': { hidePill: true, mode: 'translate' } });
  });

  it.each([
    ['a chrome page', [{ url: 'chrome://extensions' }]],
    ['a file page', [{ url: 'file:///x' }]],
    ['the Web Store', [{ url: 'https://chromewebstore.google.com/detail/x' }]],
    ['a tab without a URL', [{ url: undefined }]],
    ['no tab', []],
  ])('not available on %s', async (_name, tabs) => {
    const chrome = fakeChrome();
    chrome.tabs.query.mockResolvedValue(tabs);
    await start(chrome);
    expect($('site-unavailable').hidden).toBe(false);
    expect($('site-unavailable').textContent).toBe('Not available on this page');
    expect(blockVisible()).toBe(false);
    $('site-hide').click();
    change($('site-mode'), 'email');
    await flush();
    expect(chrome.siteWrites()).toEqual([]);
  });

  it('not available when the tab query rejects', async () => {
    const chrome = fakeChrome();
    chrome.tabs.query.mockRejectedValue(new Error('no window'));
    await start(chrome);
    expect($('site-unavailable').hidden).toBe(false);
    expect(blockVisible()).toBe(false);
    $('site-hide').click();
    await flush();
    expect(chrome.siteWrites()).toEqual([]);
    expect($('today-sessions').textContent).toBe('4');
  });

  it('never writes a rule from unloaded settings', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, { error: 'nope' });
    await start(chrome);
    expect(blockVisible()).toBe(false);
    expect($('site-unavailable').hidden).toBe(true);
    $('site-hide').click();
    change($('site-mode'), 'email');
    await flush();
    expect(chrome.siteWrites()).toEqual([]);
  });

  it('a change while the tab is queried waits for the tab', async () => {
    const chrome = fakeChrome();
    let answer;
    chrome.tabs.query.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const started = start(chrome);
    await flush();
    expect($('site-unavailable').hidden).toBe(true);
    expect(blockVisible()).toBe(false);
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('site-unavailable').hidden).toBe(true);
    answer([{ url: PAGE_URL }]);
    await started;
    expect(blockVisible()).toBe(true);
  });

  it('a refused save restores the controls and shows the error', async () => {
    const chrome = fakeChrome(withRule({ hidePill: false, mode: 'email' }));
    chrome.script(MSG.SET_SITE_RULE, { success: false, error: 'Storage is full.' }, null);
    await start(chrome);

    // A control keeps the focus through its own save, and the restore must still reach it.
    $('site-mode').focus();
    change($('site-mode'), 'translate');
    await flush();
    expect($('site-mode').value).toBe('email');
    expect($('toast').textContent).toBe('Storage is full.');
    expect($('toast').dataset.tone).toBe('error');

    $('site-hide').focus();
    $('site-hide').click();
    await flush();
    expect($('site-hide').checked).toBe(false);
    expect($('toast').textContent).toBe('Could not save settings.');
  });

  it('an external change updates the block', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    await start(chrome);
    stored.siteRules = { 'example.com': { hidePill: true, mode: 'instruct' } };
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('site-hide').checked).toBe(true);
    expect($('site-mode').value).toBe('instruct');
    expect(chrome.siteWrites()).toEqual([]);
  });

  it('an external change never writes a focused control', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    await start(chrome);
    stored.siteRules = { 'example.com': { hidePill: true, mode: 'instruct' } };

    $('site-mode').focus();
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('site-mode').value).toBe('');
    expect($('site-hide').checked).toBe(true);

    stored.siteRules = {};
    $('site-hide').focus();
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('site-hide').checked).toBe(true);
    expect($('site-mode').value).toBe('');
  });

  it('a mode renamed elsewhere updates its row', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    await start(chrome);
    stored.modes.email.name = 'Mail';
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect([...$('site-mode').options].map((o) => o.textContent)).toContain('📧 Mail');
  });
});

describe('popup Copy last (V29)', () => {
  const NEWER = { id: 'e2', raw: 'raw newer', text: 'newer text', mode: 'email', host: 'example.com', ts: 2 };
  const OLDER = { id: 'e1', raw: 'older', text: 'older', mode: 'default', host: null, ts: 1 };

  function stubClipboard(writeText = vi.fn(async () => {})) {
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    return writeText;
  }
  afterEach(() => {
    delete window.navigator.clipboard;
  });

  it('Copy last copies the newest text', async () => {
    const writeText = stubClipboard();
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [NEWER, OLDER] });
    await start(chrome);
    expect($('copy-last').hidden).toBe(false);
    expect($('copy-last').disabled).toBe(false);
    $('copy-last').click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('newer text');
    expect($('toast').textContent).toBe('Copied to clipboard.');
    expect($('toast').dataset.tone).toBe('success');
  });

  it('Copy last is disabled with no entry', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [] });
    await start(chrome);
    expect($('copy-last').hidden).toBe(false);
    expect($('copy-last').disabled).toBe(true);
  });

  it('Copy last is disabled when history cannot be read', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, null);
    await start(chrome);
    expect($('copy-last').disabled).toBe(true);
  });

  it('Copy last is hidden with keepHistory off', async () => {
    const stored = storedSettings();
    stored.keepHistory = false;
    await start(fakeChrome(stored));
    expect($('copy-last').hidden).toBe(true);
  });

  it('going off in another page hides it and lets go of the text', async () => {
    const writeText = stubClipboard();
    const stored = storedSettings();
    const chrome = fakeChrome(stored);
    chrome.script(MSG.GET_HISTORY, { entries: [NEWER] });
    await start(chrome);
    stored.keepHistory = false;
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('copy-last').hidden).toBe(true);
    stored.keepHistory = true;
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect($('copy-last').hidden).toBe(false);
    expect($('copy-last').disabled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('a newer entry after opening: Copy last copies it', async () => {
    const writeText = stubClipboard();
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [OLDER] }, { entries: [NEWER, OLDER] });
    await start(chrome);
    chrome.fire({ history: { newValue: [] } }, 'session');
    await flush();
    $('copy-last').click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(NEWER.text);
  });

  it('the store emptied after opening: the button disables', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [NEWER] }, { entries: [] });
    await start(chrome);
    expect($('copy-last').disabled).toBe(false);
    chrome.fire({ history: {} }, 'session');
    await flush();
    expect($('copy-last').disabled).toBe(true);
  });

  it.each([
    ['another area', { history: { newValue: [] } }, 'local'],
    ['another session key', { other: { newValue: 1 } }, 'session'],
  ])('%s does not read history again', async (_name, changes, area) => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [NEWER] });
    await start(chrome);
    const reads = () => chrome.sent.filter((m) => m.action === MSG.GET_HISTORY).length;
    chrome.fire(changes, area);
    await flush();
    expect(reads()).toBe(1);
  });

  it('a slow reply does not bring back what a newer read emptied', async () => {
    let answerSlow;
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [] }, new Promise((resolve) => { answerSlow = resolve; }), { entries: [] });
    await start(chrome);
    chrome.fire({ history: {} }, 'session');
    chrome.fire({ history: {} }, 'session');
    await flush();
    answerSlow({ entries: [NEWER] });
    await flush();
    expect($('copy-last').disabled).toBe(true);
  });

  it('a rejected clipboard write shows a toast and throws nothing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    stubClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    const chrome = fakeChrome();
    chrome.script(MSG.GET_HISTORY, { entries: [NEWER] });
    await start(chrome);
    $('copy-last').click();
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect($('toast').textContent).toBe('Could not copy.');
    expect($('toast').dataset.tone).toBe('error');
  });
});
