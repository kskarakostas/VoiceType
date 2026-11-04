// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { createSitesSection } from '../../../src/options/sections/sites.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { withSiteRule } from '../../../src/shared/sites.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const SETTINGS_CHANGE = { settings: { newValue: {} } };
const NOT_A_HOST = 'Enter a hostname or a URL, such as example.com.';
const EMPTY_RULE = 'Turn on Hide pill or choose a mode.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const hide = { hidePill: true, mode: null };

function storedSettings(siteRules = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '' };
  s.siteRules = siteRules;
  return s;
}

/**
 * Fake chrome for the settings page. SET_SITE_RULE updates the store as the worker does and plays
 * the storage event; `script(action, ...responses)` queues one-shot answers that do neither.
 * `rules()` returns the SET_SITE_RULE messages without their action.
 */
function fakeChrome(stored = storedSettings()) {
  const queues = new Map();
  const sent = [];
  const changeListeners = new Set();
  const fire = (changes, area) => { for (const listener of [...changeListeners]) listener(changes, area); };
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(stored),
    [MSG.SAVE_SETTINGS]: () => ({ success: true }),
    [MSG.SET_SITE_RULE]: ({ host, hidePill, mode }) => {
      stored.siteRules = withSiteRule(stored.siteRules, host, { hidePill, mode });
      fire(SETTINGS_CHANGE, 'local');
      return { success: true };
    },
  };
  return {
    stored,
    sent,
    rules: () => sent.filter((m) => m.action === MSG.SET_SITE_RULE).map(({ action, ...rule }) => rule),
    count: (action) => sent.filter((m) => m.action === action).length,
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    fire,
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
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Open the settings page on Sites with the real sections. */
function start(chrome, sections) {
  window.history.replaceState(null, '', '#settings/sites');
  return initOptions({ chrome, document, window, sections });
}

const hosts = () => [...$('site-table').tBodies[0].rows].map((row) => row.cells[0].textContent);
const hideOn = (host) => document.querySelector(`input[aria-label="Hide pill on ${host}"]`);
const modeOn = (host) => document.querySelector(`select[aria-label="Mode on ${host}"]`);
const removeOf = (host) => document.querySelector(`button[aria-label="Remove ${host}"]`);
const error = () => $('site-add-error');
const toast = () => $('toast');

function externalChange(chrome, siteRules) {
  chrome.stored.siteRules = siteRules;
  chrome.fire(SETTINGS_CHANGE, 'local');
  return flush();
}
function choose(select, value) {
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}
function typeHost(value) {
  $('site-add-host').value = value;
  $('site-add-host').dispatchEvent(new Event('input', { bubbles: true }));
}
async function submit() {
  $('site-add').requestSubmit();
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('sites page markup', () => {
  it('has the hint, the form and the table with its columns', async () => {
    await start(fakeChrome());
    expect(document.querySelector('section[data-route="settings/sites"] .placeholder')).toBeNull();
    expect(document.querySelector('.site-hint').textContent).toBe('Hide pill removes the idle pill on that site; the hotkey still records there, with a small indicator at the bottom of the page.');
    expect(document.querySelector('label[for="site-add-host"]').textContent).toBe('Add site');
    expect($('site-add-hide').checked).toBe(true);
    expect($('site-add-hide').closest('.check')).not.toBeNull();
    expect($('site-add-mode').options[0].textContent).toBe('Use active mode');
    expect($('site-add').querySelector('button[type="submit"]').textContent).toBe('Add');
    expect(error().getAttribute('role')).toBe('alert');
    expect(error().hidden).toBe(true);
    expect($('site-table').querySelector('caption').className).toBe('visually-hidden');
    expect([...$('site-table').tHead.rows[0].cells].map((c) => c.textContent)).toEqual(['Site', 'Hide pill', 'Mode', 'Remove']);
  });
});

describe('sites page rows', () => {
  it('lists every rule by host', async () => {
    // A replaced rule moves to the end of the object's key order.
    const hostile = '<img src=x onerror=alert(1)>';
    await start(fakeChrome(storedSettings({ 'c.com': hide, 'a.com': hide, [hostile]: hide, 'b.com': { hidePill: false, mode: 'email' } })));
    expect(hosts()).toEqual([hostile, 'a.com', 'b.com', 'c.com']);
    expect($('site-table').querySelector('img')).toBeNull();
    expect(hideOn('a.com').checked).toBe(true);
    expect(modeOn('a.com').value).toBe('');
    expect(hideOn('b.com').checked).toBe(false);
    expect(modeOn('b.com').value).toBe('email');
    expect($('site-empty').hidden).toBe(true);
    expect($('site-table').hidden).toBe(false);
  });

  it('shows the empty line when there are no rules', async () => {
    await start(fakeChrome());
    expect(hosts()).toEqual([]);
    expect($('site-empty').textContent).toBe('No site rules yet.');
    expect($('site-empty').hidden).toBe(false);
    expect($('site-table').hidden).toBe(true);
  });

  it('the row edits send the whole rule', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': { hidePill: true, mode: 'email' } }));
    await start(chrome);
    hideOn('a.com').click();
    await flush();
    choose(modeOn('a.com'), 'default');
    await flush();
    const picked = modeOn('a.com').value;
    hideOn('a.com').click();
    await flush();
    choose(modeOn('a.com'), '');
    await flush();
    expect(chrome.rules()).toEqual([
      { host: 'a.com', hidePill: false, mode: 'email' },
      { host: 'a.com', hidePill: false, mode: picked },
      { host: 'a.com', hidePill: true, mode: picked },
      { host: 'a.com', hidePill: true, mode: null },
    ]);
    expect(chrome.count(MSG.SAVE_SETTINGS)).toBe(0);
  });

  it('a stored rule replaced by an edit keeps its alphabetical place', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'b.com': hide }));
    await start(chrome);
    choose(modeOn('a.com'), 'email');
    await flush();
    expect(Object.keys(chrome.stored.siteRules)).toEqual(['b.com', 'a.com']);
    expect(hosts()).toEqual(['a.com', 'b.com']);
  });

  it('a failed edit puts the stored value back on the focused control and says why', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': { hidePill: true, mode: 'email' } }));
    await start(chrome);
    chrome.script(MSG.SET_SITE_RULE, { success: false, error: 'Invalid settings.' }, null);
    hideOn('a.com').focus();
    hideOn('a.com').click();
    await flush();
    expect(hideOn('a.com').checked).toBe(true);
    expect(toast().textContent).toBe('Invalid settings.');
    expect(toast().dataset.tone).toBe('error');
    modeOn('a.com').focus();
    choose(modeOn('a.com'), '');
    await flush();
    expect(modeOn('a.com').value).toBe('email');
    expect(toast().textContent).toBe('Could not save settings.');
  });

  it('clearing the last setting removes the row and moves focus', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'b.com': hide, 'c.com': { hidePill: false, mode: 'email' } }));
    await start(chrome);
    hideOn('a.com').focus();
    hideOn('a.com').click();
    await flush();
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: false, mode: null }]);
    expect(hosts()).toEqual(['b.com', 'c.com']);
    expect(document.activeElement).toBe(removeOf('b.com'));

    modeOn('c.com').focus();
    choose(modeOn('c.com'), '');
    await flush();
    expect(hosts()).toEqual(['b.com']);
    expect(document.activeElement).toBe($('site-add-host'));
  });

  it('the row goes when the store says so, not before', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'b.com': hide }));
    await start(chrome);
    chrome.script(MSG.SET_SITE_RULE, { success: true });
    hideOn('a.com').focus();
    hideOn('a.com').click();
    await flush();
    expect(hosts()).toEqual(['a.com', 'b.com']);
    expect(document.activeElement).toBe(hideOn('a.com'));
    await externalChange(chrome, { 'b.com': hide });
    expect(hosts()).toEqual(['b.com']);
    expect(document.activeElement).toBe(removeOf('b.com'));
  });

  it('a failed clear keeps the row', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide }));
    await start(chrome);
    chrome.script(MSG.SET_SITE_RULE, { success: false });
    hideOn('a.com').focus();
    hideOn('a.com').click();
    await flush();
    expect(hosts()).toEqual(['a.com']);
    expect(hideOn('a.com').checked).toBe(true);
    expect(document.activeElement).toBe(hideOn('a.com'));
  });

  it('a row removed elsewhere leaves focus alone when it did not hold it', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'b.com': hide }));
    await start(chrome);
    modeOn('b.com').focus();
    await externalChange(chrome, { 'b.com': hide });
    expect(hosts()).toEqual(['b.com']);
    expect(document.activeElement).toBe(modeOn('b.com'));
  });

  it('Remove sends an empty rule and toasts', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': { hidePill: true, mode: 'email' }, 'b.com': hide }));
    await start(chrome);
    removeOf('a.com').focus();
    removeOf('a.com').click();
    await flush();
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: false, mode: null }]);
    expect(toast().textContent).toBe('Removed a.com');
    expect(toast().dataset.tone).toBe('success');
    expect(hosts()).toEqual(['b.com']);
    expect(document.activeElement).toBe(removeOf('b.com'));

    removeOf('b.com').click();
    await flush();
    expect(hosts()).toEqual([]);
    expect(document.activeElement).toBe($('site-add-host'));
    expect($('site-empty').hidden).toBe(false);
  });

  it('a failed Remove keeps the row and says why', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide }));
    await start(chrome);
    chrome.script(MSG.SET_SITE_RULE, { success: false, error: 'Invalid settings.' });
    removeOf('a.com').focus();
    removeOf('a.com').click();
    await flush();
    expect(hosts()).toEqual(['a.com']);
    expect(toast().textContent).toBe('Invalid settings.');
    expect(toast().dataset.tone).toBe('error');
    expect(document.activeElement).toBe(removeOf('a.com'));
  });

  it('a double click or a held key on Remove takes one row', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'b.com': hide }));
    await start(chrome);
    removeOf('a.com').focus();
    removeOf('a.com').click();
    await flush();
    // Focus and the pointer are on the row that slid in.
    removeOf('b.com').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    const repeat = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    removeOf('b.com').dispatchEvent(repeat);
    await flush();
    expect(repeat.defaultPrevented).toBe(true);
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: false, mode: null }]);
    expect(hosts()).toEqual(['b.com']);
  });

  it('a rule whose custom mode is gone reads Use active mode', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': { hidePill: true, mode: 'gone' }, 'b.com': { hidePill: true, mode: 'toString' } }));
    await start(chrome);
    // Not `.value`: a value with no option reads '' too, while the select shows nothing.
    expect(modeOn('a.com').selectedOptions[0].textContent).toBe('Use active mode');
    expect(modeOn('b.com').selectedOptions[0].textContent).toBe('Use active mode');
    hideOn('a.com').click();
    await flush();
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: false, mode: null }]);
  });
});

describe('sites page Add site', () => {
  it('Add stores the form\'s rule', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('site-add-host').focus();
    typeHost('https://www.a.com/x');
    await submit();
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: true, mode: null }]);
    expect(hosts()).toEqual(['a.com']);
    expect($('site-add-host').value).toBe('');
    expect($('site-add-hide').checked).toBe(true);
    expect($('site-add-mode').value).toBe('');
    expect(document.activeElement).toBe($('site-add-host'));
    expect(toast().textContent).toBe('Added a.com');
    expect(toast().dataset.tone).toBe('success');
    expect(chrome.count(MSG.SAVE_SETTINGS)).toBe(0);
  });

  it('sends the chosen mode and returns the form to its defaults', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost('b.com');
    $('site-add-hide').click();
    choose($('site-add-mode'), 'email');
    $('site-add').querySelector('button[type="submit"]').focus();
    $('site-add').querySelector('button[type="submit"]').click();
    await flush();
    expect(chrome.rules()).toEqual([{ host: 'b.com', hidePill: false, mode: 'email' }]);
    expect($('site-add-hide').checked).toBe(true);
    expect($('site-add-mode').value).toBe('');
    expect(document.activeElement).toBe($('site-add-host'));
  });

  it('Enter submits the form', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    // jsdom does not run implicit submission: the browser's Enter needs an input inside a form
    // with a submit button, and the rule comes from the form's submit event alone.
    expect($('site-add-host').form).toBe($('site-add'));
    expect($('site-add-host').type).toBe('text');
    expect($('site-add').querySelectorAll('button[type="submit"]').length).toBe(1);
    typeHost('a.com');
    const event = new Event('submit', { bubbles: true, cancelable: true });
    $('site-add').dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: true, mode: null }]);
  });

  it('a second submit while one is on its way sends nothing', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost('a.com');
    $('site-add').requestSubmit();
    $('site-add').requestSubmit();
    await flush();
    expect(chrome.rules()).toEqual([{ host: 'a.com', hidePill: true, mode: null }]);
  });

  it('text typed while the save runs stays', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost('a.com');
    $('site-add').requestSubmit();
    typeHost('b.com');
    await flush();
    expect($('site-add-host').value).toBe('b.com');
  });

  it.each(['mailto:a@b.com', 'a@b.com', '', '   '])('refuses input that is not a host: %j', async (text) => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost(text);
    await submit();
    expect(error().textContent).toBe(NOT_A_HOST);
    expect(error().hidden).toBe(false);
    expect(chrome.rules()).toEqual([]);
    expect($('site-add-host').value).toBe(text);
  });

  it('refuses a host that already has a rule', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide }));
    await start(chrome);
    typeHost('WWW.A.com');
    await submit();
    expect(error().textContent).toBe('a.com already has a rule.');
    expect(chrome.rules()).toEqual([]);
    expect($('site-add-host').value).toBe('WWW.A.com');
  });

  it('a host named after an object member adds, and then counts as existing', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost('__proto__');
    await submit();
    expect(chrome.rules()).toEqual([{ host: '__proto__', hidePill: true, mode: null }]);
    expect(hosts()).toEqual(['__proto__']);
    typeHost('__proto__');
    await submit();
    expect(error().textContent).toBe('__proto__ already has a rule.');
    expect(chrome.rules().length).toBe(1);
  });

  it('refuses an empty rule', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeHost('a.com');
    $('site-add-hide').click();
    await submit();
    expect(error().textContent).toBe(EMPTY_RULE);
    expect(chrome.rules()).toEqual([]);
    expect($('site-add-host').value).toBe('a.com');
  });

  it('changing the form clears the error, and a good Add leaves none', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    await submit();
    expect(error().hidden).toBe(false);
    typeHost('a');
    expect(error().hidden).toBe(true);
    expect(error().textContent).toBe('');
    typeHost('');
    await submit();
    $('site-add-hide').click();
    expect(error().hidden).toBe(true);
    $('site-add-hide').click();
    typeHost('a.com');
    await submit();
    expect(error().hidden).toBe(true);
  });

  it('a failed save keeps the text and shows the error', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    chrome.script(MSG.SET_SITE_RULE, { success: false, error: 'Invalid settings.' }, null);
    typeHost('a.com');
    $('site-add-hide').click();
    choose($('site-add-mode'), 'email');
    await submit();
    expect(error().textContent).toBe('Invalid settings.');
    expect(error().hidden).toBe(false);
    expect($('site-add-host').value).toBe('a.com');
    expect($('site-add-hide').checked).toBe(false);
    expect($('site-add-mode').value).toBe('email');
    await submit();
    expect(error().textContent).toBe('Could not save settings.');
    expect($('site-add-host').value).toBe('a.com');
    await submit();
    expect(error().hidden).toBe(true);
    expect(hosts()).toEqual(['a.com']);
  });

  it('typed text is not added on blur, hide or close', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('site-add-host').focus();
    typeHost('a.com');
    $('site-add-host').blur();
    $('site-add-host').dispatchEvent(new Event('blur'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    window.dispatchEvent(new Event('pagehide'));
    await flush();
    expect(chrome.rules()).toEqual([]);
    expect($('site-add-host').value).toBe('a.com');
  });
});

describe('sites page before the settings load', () => {
  it('never writes before the settings load', async () => {
    const chrome = fakeChrome();
    const unloaded = (ctx) => createSitesSection({
      ...ctx,
      loaded: () => false,
      settings: () => storedSettings({ 'a.com': { hidePill: true, mode: 'email' } }),
    });
    await start(chrome, [unloaded]);
    const refused = () => {
      expect(chrome.rules()).toEqual([]);
      expect(toast().textContent).toBe(NOT_LOADED);
      expect(toast().dataset.tone).toBe('error');
      toast().textContent = '';
    };

    hideOn('a.com').focus();
    hideOn('a.com').click();
    await flush();
    refused();
    expect(hideOn('a.com').checked).toBe(true);

    modeOn('a.com').focus();
    choose(modeOn('a.com'), '');
    await flush();
    refused();
    expect(modeOn('a.com').value).toBe('email');

    removeOf('a.com').click();
    await flush();
    refused();

    typeHost('b.com');
    await submit();
    refused();
    expect($('site-add-host').value).toBe('b.com');
  });

  it('a failed load does not claim there are no rules', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, null);
    await start(chrome);
    expect($('banner').hidden).toBe(false);
    expect($('site-empty').hidden).toBe(true);
    typeHost('a.com');
    await submit();
    expect(chrome.rules()).toEqual([]);
    expect(toast().textContent).toBe(NOT_LOADED);
  });
});

describe('sites page and outside changes', () => {
  it('an external change keeps typed text and a focused control', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide, 'c.com': hide }));
    await start(chrome);
    typeHost('draft.com');
    modeOn('a.com').focus();
    modeOn('a.com').value = 'email';
    await externalChange(chrome, { 'a.com': hide, 'b.com': { hidePill: false, mode: 'email' }, 'c.com': hide });
    expect($('site-add-host').value).toBe('draft.com');
    expect(modeOn('a.com').value).toBe('email');
    expect(document.activeElement).toBe(modeOn('a.com'));
    expect(hosts()).toEqual(['a.com', 'b.com', 'c.com']);
    expect(modeOn('b.com').value).toBe('email');
  });

  it('an external change updates the controls of a row in place', async () => {
    const chrome = fakeChrome(storedSettings({ 'a.com': hide }));
    await start(chrome);
    const [row, hideBox] = [$('site-table').tBodies[0].rows[0], hideOn('a.com')];
    await externalChange(chrome, { 'a.com': { hidePill: false, mode: 'email' } });
    expect($('site-table').tBodies[0].rows[0]).toBe(row);
    expect(hideOn('a.com')).toBe(hideBox);
    expect(hideBox.checked).toBe(false);
    expect(modeOn('a.com').value).toBe('email');
  });

  it('a focused Add select keeps its choice, and a mode that goes falls back', async () => {
    const stored = storedSettings();
    stored.modes.custom = { name: 'Custom', icon: '', prompt: '' };
    const chrome = fakeChrome(stored);
    await start(chrome);
    const select = $('site-add-mode');
    choose(select, 'custom');
    select.focus();
    delete chrome.stored.modes.custom;
    await externalChange(chrome, {});
    expect(select.value).toBe('custom');
    select.blur();
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(select.selectedOptions[0].textContent).toBe('Use active mode');
    expect([...select.options].map((o) => o.value)).not.toContain('custom');
  });

  it('a new mode reaches the Add select and keeps its choice', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    choose($('site-add-mode'), 'email');
    chrome.stored.modes.custom = { name: 'Custom', icon: '', prompt: '' };
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect([...$('site-add-mode').options].map((o) => o.value)).toContain('custom');
    expect($('site-add-mode').value).toBe('email');
  });
});
