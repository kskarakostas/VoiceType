// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { createDictionarySection } from '../../../src/options/sections/dictionary.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { SPOKEN_LANGUAGES } from '../../../src/shared/dictionary.js';
import { MAX_IMPORT_BYTES, serializeDictionary } from '../../../src/options/dictionary-csv.js';
import { CONFIRM_GUARD_MS } from '../../../src/ui/form.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const SETTINGS_CHANGE = { settings: { newValue: {} } };
const REMOVE_PROMPT = 'Click again to remove this group and its terms';
const FIRST_BEAT_MS = 400;
const HEARTBEAT_MS = 20000;

function storedSettings(dictionary = {}) {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '' };
  s.dictionary = dictionary;
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

/** Open the settings page on the Dictionary with the real sections. */
function start(chrome, sections) {
  window.history.replaceState(null, '', '#dictionary');
  return initOptions({ chrome, document, window, sections });
}

function typeInto(el, value) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
function press(el) {
  const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}
function pressEnter(el) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}
function paste(el, text) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: (type) => (type === 'text/plain' ? text : '') };
  el.dispatchEvent(event);
  return event;
}
/** jsdom has no execCommand. This one acts as Chrome does: it replaces the selection and fires input. */
function stubInsertText(el) {
  document.execCommand = vi.fn((command, showUi, text) => {
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  return document.execCommand;
}
function externalChange(chrome, dictionary) {
  chrome.script(MSG.GET_SETTINGS, storedSettings(dictionary));
  chrome.fire(SETTINGS_CHANGE, 'local');
}

const card = (group) => document.querySelector(`.dictionary-group[data-group="${group}"]`);
const groups = () => [...document.querySelectorAll('.dictionary-group')].map((c) => c.dataset.group);
const chips = (group) => [...card(group).querySelectorAll('.chip-text')].map((c) => c.textContent);
const input = (group) => $(`dictionary-input-${group}`);
const message = (group) => $(`dictionary-message-${group}`);
const chipButton = (term) => document.querySelector(`button.chip-remove[aria-label="Remove ${term}"]`);
const removeGroup = (group) => card(group).querySelector('[data-role="remove-group"]');
const languages = () => [...$('dictionary-language').options].map((o) => o.value);

beforeEach(() => {
  // Every page this file starts shares window: flush anything an earlier test left in a field.
  pagehide();
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
  delete document.execCommand;
});

describe('dictionary page layout', () => {
  it('shows the any card first and languages in display order', async () => {
    await start(fakeChrome(storedSettings({ el: ['b'], any: ['a'], de: [] })));
    expect(groups()).toEqual(['any', 'el', 'de']);
    expect(chips('any')).toEqual(['a']);
    expect(chips('el')).toEqual(['b']);
    expect($('dictionary-count').textContent).toBe('2 of 100 terms');
  });

  it('an empty dictionary still shows the any card without Remove group', async () => {
    await start(fakeChrome());
    expect(groups()).toEqual(['any']);
    expect(chips('any')).toEqual([]);
    expect(removeGroup('any').hidden).toBe(true);
    expect($('dictionary-count').textContent).toBe('0 of 100 terms');
  });

  it('Remove group shows on a language card always, and on any once it has terms', async () => {
    await start(fakeChrome(storedSettings({ any: ['a'], el: [] })));
    expect(removeGroup('any').hidden).toBe(false);
    expect(removeGroup('el').hidden).toBe(false);
  });

  it('renders the page copy, the toolbar and the card markup', async () => {
    await start(fakeChrome(storedSettings({ any: ['a'] })));
    const section = document.querySelector('section[data-route="dictionary"]');
    expect(section.querySelector('h1 + p.hint').textContent).toBe(
      'Names and jargon the provider should recognize. Every term goes with every dictation, whatever language you speak.',
    );
    expect(section.querySelector('.placeholder')).toBeNull();
    expect($('dictionary-export').textContent).toBe('Export CSV');
    expect($('dictionary-import').textContent).toBe('Import CSV');
    expect($('dictionary-file').type).toBe('file');
    expect($('dictionary-file').hidden).toBe(true);
    expect($('dictionary-file').accept).toBe('.csv,.txt,text/csv,text/plain');
    expect($('dictionary-status').getAttribute('role')).toBe('status');
    expect($('dictionary-status').classList.contains('hint')).toBe(true);
    expect($('dictionary-status').textContent).toBe('');
    expect(section.querySelector('label[for="dictionary-language"]').textContent).toBe('Add a language');
    expect($('dictionary-add-group').textContent).toBe('Add language');

    const heading = $('dictionary-heading-any');
    expect(heading.tagName).toBe('H2');
    expect(heading.textContent).toBe('All languages');
    expect(card('any').tagName).toBe('DIV');
    expect(card('any').classList.contains('card')).toBe(true);
    const list = card('any').querySelector('ul.chips');
    expect(list.getAttribute('aria-labelledby')).toBe('dictionary-heading-any');
    expect(list.querySelector('li.chip > span.chip-text').textContent).toBe('a');
    expect(input('any').type).toBe('text');
    expect(input('any').placeholder).toBe('Type a term, then press Enter');
    expect(input('any').getAttribute('aria-describedby')).toBe('dictionary-message-any');
    const label = card('any').querySelector('label.field-label');
    expect(label.textContent).toBe('Add a term to All languages');
    expect(label.htmlFor).toBe('dictionary-input-any');
    expect(message('any').tagName).toBe('P');
    expect(message('any').classList.contains('hint')).toBe(true);
    expect(message('any').getAttribute('role')).toBe('status');
    expect(chipButton('a').type).toBe('button');
    const button = removeGroup('any');
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.className).toBe('btn btn-danger');
    expect(button.textContent).toBe('Remove group');
    expect(button.getAttribute('aria-describedby')).toBe('dictionary-heading-any');
  });

  it('terms render as text', async () => {
    const term = '<img src=x onerror=alert(1)>';
    await start(fakeChrome(storedSettings({ any: [term] })));
    expect(chips('any')).toEqual([term]);
    expect(document.querySelector('.chip img')).toBeNull();
    expect(document.querySelector('.chip button').getAttribute('aria-label')).toBe(`Remove ${term}`);
  });
});

describe('dictionary page adding terms', () => {
  it('Enter adds and commas split', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), 'Palowise, Noesis');
    expect(pressEnter(input('any')).defaultPrevented).toBe(true);
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palowise', 'Noesis'] } }]);
    expect(input('any').value).toBe('');
    expect(chips('any')).toEqual(['Palowise', 'Noesis']);
    expect($('dictionary-count').textContent).toBe('2 of 100 terms');
  });

  it('names the group in each add field\'s label', async () => {
    await start(fakeChrome(storedSettings({ el: ['a'] })));
    expect(card('el').querySelector('label.field-label').textContent).toBe('Add a term to Greek');
  });

  it('an Enter that ends a composition neither adds nor is prevented', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), 'a');
    const event = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    input('any').dispatchEvent(event);
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(input('any').value).toBe('a');
    expect(chrome.saves()).toEqual([]);
  });

  it('a pasted line list goes in as comma-separated terms at the selection', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), 'x, y');
    input('any').setSelectionRange(3, 4);
    const execCommand = stubInsertText(input('any'));
    const event = paste(input('any'), 'Alpha\r\n\r\nBeta\nGamma\r\n');
    expect(event.defaultPrevented).toBe(true);
    expect(execCommand.mock.calls).toEqual([['insertText', false, 'Alpha, Beta, Gamma']]);
    expect(input('any').value).toBe('x, Alpha, Beta, Gamma');
    pressEnter(input('any'));
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['x', 'Alpha', 'Beta', 'Gamma'] } }]);
  });

  it('a paste with no line break is left to the browser', async () => {
    await start(fakeChrome());
    typeInto(input('any'), 'x');
    const execCommand = stubInsertText(input('any'));
    expect(paste(input('any'), 'Alpha, Beta').defaultPrevented).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
    expect(input('any').value).toBe('x');
  });

  it('refuses a term in another group', async () => {
    const chrome = fakeChrome(storedSettings({ el: ['Noesis'] }));
    await start(chrome);
    typeInto(input('any'), 'noesis');
    pressEnter(input('any'));
    await flush();
    expect(chrome.saves()).toEqual([]);
    expect(message('any').textContent).toBe('Already in Greek');
    expect(message('any').dataset.tone).toBe('error');
    expect(input('any').value).toBe('noesis');
  });

  it('adds what it can and keeps the refused text', async () => {
    const chrome = fakeChrome(storedSettings({ el: ['Noesis'] }));
    await start(chrome);
    typeInto(input('any'), 'x, noesis');
    pressEnter(input('any'));
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { el: ['Noesis'], any: ['x'] } }]);
    expect(input('any').value).toBe('noesis');
    expect(message('any').textContent).toBe('Already in Greek');
  });

  it('refuses a long term and a full dictionary', async () => {
    const long = 'x'.repeat(65);
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), long);
    pressEnter(input('any'));
    await flush();
    expect(message('any').textContent).toBe('Terms can have at most 64 characters');
    expect(message('any').dataset.tone).toBe('error');
    expect(input('any').value).toBe(long);
    expect(chrome.saves()).toEqual([]);

    document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
    const full = fakeChrome(storedSettings({ any: Array.from({ length: 100 }, (_, i) => `t${i}`) }));
    await start(full);
    typeInto(input('any'), 'one more');
    pressEnter(input('any'));
    await flush();
    expect(message('any').textContent).toBe('The dictionary is full (100 terms)');
    expect(message('any').dataset.tone).toBe('error');
    expect(input('any').value).toBe('one more');
    expect(full.saves()).toEqual([]);
  });

  it('an add with no refusal clears the message; empty text leaves it', async () => {
    const chrome = fakeChrome(storedSettings({ el: ['Noesis'] }));
    await start(chrome);
    typeInto(input('any'), 'noesis');
    pressEnter(input('any'));
    typeInto(input('any'), '   ');
    pressEnter(input('any'));
    expect(message('any').textContent).toBe('Already in Greek');
    typeInto(input('any'), 'fresh');
    pressEnter(input('any'));
    await flush();
    expect(message('any').textContent).toBe('');
    expect(message('any').hasAttribute('data-tone')).toBe(false);
  });

  it('Enter then blur adds once', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    input('any').focus();
    typeInto(input('any'), 'Palowise');
    pressEnter(input('any'));
    input('any').blur();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palowise'] } }]);
    expect(message('any').textContent).toBe('');
  });

  it('blur adds the typed term', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    input('any').focus();
    typeInto(input('any'), 'Palowise');
    input('any').blur();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palowise'] } }]);
    expect(chips('any')).toEqual(['Palowise']);
  });

  it('pagehide adds the typed term', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    input('any').focus();
    typeInto(input('any'), 'Palowise');
    await vi.advanceTimersByTimeAsync(1000);
    expect(chrome.saves()).toEqual([]);
    pagehide();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palowise'] } }]);
  });

  it('a hidden tab adds the text of every field, and pagehide after it sends nothing more', async () => {
    const chrome = fakeChrome(storedSettings({ el: [] }));
    await start(chrome);
    typeInto(input('any'), 'a');
    typeInto(input('el'), 'b');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.visibilityState;
    }
    await flush();
    pagehide();
    await flush();
    expect(chrome.saves()).toHaveLength(2);
    expect(chrome.saves()[1]).toEqual({ dictionary: { any: ['a'], el: ['b'] } });
  });

  it('its typing save is pending while a field holds text and never waits on a timer', async () => {
    vi.useFakeTimers();
    let section;
    const chrome = fakeChrome();
    await start(chrome, [(ctx) => { section = createDictionarySection(ctx); return section; }]);
    const [save] = section.typingSaves;
    expect(section.typingSaves).toHaveLength(1);
    expect(save.pending).toBe(false);
    typeInto(input('any'), 'Palowise');
    expect(save.pending).toBe(true);
    save.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    save.cancel();
    expect(chrome.saves()).toEqual([]);
    expect(input('any').value).toBe('Palowise');
    await save.flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palowise'] } }]);
    expect(save.pending).toBe(false);
  });

  it('a failed save puts the text back', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    await start(chrome);
    typeInto(input('any'), 'Palowise');
    pressEnter(input('any'));
    expect(input('any').value).toBe('');
    await flush();
    expect(input('any').value).toBe('Palowise');
    expect(chips('any')).toEqual([]);
    expect($('toast').textContent).toBe('x');
  });

  it('a failed save puts back the terms it took, beside the refused ones', async () => {
    const chrome = fakeChrome(storedSettings({ el: ['Noesis'] }));
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    await start(chrome);
    typeInto(input('any'), 'x, noesis');
    pressEnter(input('any'));
    expect(input('any').value).toBe('noesis');
    await flush();
    expect(input('any').value).toBe('x, noesis');
    expect(chips('any')).toEqual([]);
  });

  it('a failed save leaves text typed since then alone', async () => {
    let answer;
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, new Promise((resolve) => { answer = resolve; }));
    await start(chrome);
    typeInto(input('any'), 'first');
    pressEnter(input('any'));
    typeInto(input('any'), 'second');
    answer({ success: false, error: 'x' });
    await flush();
    expect(input('any').value).toBe('second');
  });
});

describe('dictionary page removing terms', () => {
  it('removing a chip saves and moves focus', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    chipButton('a').focus();
    chipButton('a').click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['b'] } }]);
    expect(document.activeElement).toBe(chipButton('b'));
  });

  it('removing the last chip in the row moves focus to the previous one', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    chipButton('b').focus();
    chipButton('b').click();
    await flush();
    expect(document.activeElement).toBe(chipButton('a'));
  });

  it('removing the last term keeps a language card and focuses its input', async () => {
    const chrome = fakeChrome(storedSettings({ el: ['a'] }));
    await start(chrome);
    chipButton('a').click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { el: [] } }]);
    expect(groups()).toEqual(['any', 'el']);
    expect(document.activeElement).toBe(input('el'));
  });

  it('pressing the mouse on a button leaves the field focused, so the click lands on it', async () => {
    await start(fakeChrome(storedSettings({ any: ['a'], el: [] })));
    expect(press(chipButton('a')).defaultPrevented).toBe(true);
    expect(press(removeGroup('any')).defaultPrevented).toBe(true);
    expect(press(removeGroup('el')).defaultPrevented).toBe(true);
    expect(press($('dictionary-add-group')).defaultPrevented).toBe(true);
  });

  it('a held key on a chip removes one term', async () => {
    await start(fakeChrome(storedSettings({ any: ['a', 'b'] })));
    const held = (init) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      chipButton('a').dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(held({ key: 'Enter', repeat: true })).toBe(true);
    expect(held({ key: ' ', repeat: true })).toBe(true);
    expect(held({ key: 'Enter' })).toBe(false);
    expect(held({ key: ' ' })).toBe(false);
    expect(held({ key: 'Tab', repeat: true })).toBe(false);
  });

  it('a double click on a chip removes one term', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b', 'c'] }));
    await start(chrome);
    chipButton('a').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
    await flush();
    chipButton('b').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    await flush();
    expect(chips('any')).toEqual(['b', 'c']);
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['b', 'c'] } }]);
  });

  it('a chip click adds the text in the field first, then removes, then moves focus', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    input('any').focus();
    typeInto(input('any'), 'typed');
    chipButton('a').click();
    await flush();
    expect(chrome.saves()).toEqual([
      { dictionary: { any: ['a', 'b', 'typed'] } },
      { dictionary: { any: ['b', 'typed'] } },
    ]);
    expect(input('any').value).toBe('');
    expect(document.activeElement).toBe(chipButton('b'));
  });

  it('Remove group needs a second click', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ el: ['a'] }));
    await start(chrome);
    const button = removeGroup('el');
    button.click();
    await flush();
    expect(chrome.saves()).toEqual([]);
    expect(button.textContent).toBe(REMOVE_PROMPT);
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: {} }]);
    expect(card('el')).toBeNull();
    expect(document.activeElement).toBe(input('any'));
  });

  it('Remove group adds the text of its focused field before the card goes, so the card stays gone', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ el: ['a'] }));
    await start(chrome);
    input('el').focus();
    typeInto(input('el'), 'typed');
    const button = removeGroup('el');
    button.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { el: ['a', 'typed'] } }, { dictionary: {} }]);
    expect(card('el')).toBeNull();
    expect(document.activeElement).toBe(input('any'));
  });

  it('Remove group on any empties it and keeps the card', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ any: ['a'], el: ['b'] }));
    await start(chrome);
    const button = removeGroup('any');
    button.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    button.click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { el: ['b'] } }]);
    expect(groups()).toEqual(['any', 'el']);
    expect(chips('any')).toEqual([]);
    expect(button.hidden).toBe(true);
    expect(document.activeElement).toBe(input('any'));
  });
});

describe('dictionary page languages', () => {
  it('Add language offers only languages not present', async () => {
    const chrome = fakeChrome(storedSettings({ el: [] }));
    await start(chrome);
    expect(languages()).toEqual(['en', 'es', 'fr', 'de', 'it', 'pt']);
    expect($('dictionary-language').options[0].textContent).toBe('English');
    expect($('dictionary-add-language').hidden).toBe(false);
    $('dictionary-language').value = 'de';
    $('dictionary-add-group').click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { el: [], de: [] } }]);
    expect(groups()).toEqual(['any', 'el', 'de']);
    expect(document.activeElement).toBe(input('de'));
    expect(languages()).toEqual(['en', 'es', 'fr', 'it', 'pt']);
  });

  it('Add language rebuilds a select that kept focus through the press', async () => {
    await start(fakeChrome());
    $('dictionary-language').focus();
    $('dictionary-language').value = 'de';
    $('dictionary-add-group').click();
    expect(document.activeElement).toBe(input('de'));
    expect(languages()).not.toContain('de');
  });

  it('hides Add language when every language is present', async () => {
    const dictionary = Object.fromEntries(SPOKEN_LANGUAGES.map(({ code }) => [code, []]));
    await start(fakeChrome(storedSettings(dictionary)));
    expect($('dictionary-add-language').hidden).toBe(true);
    expect(languages()).toEqual([]);
  });

  it('the chosen language stays chosen when the list changes around it', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('dictionary-language').value = 'fr';
    externalChange(chrome, { en: [] });
    await flush();
    expect(languages()).not.toContain('en');
    expect($('dictionary-language').value).toBe('fr');
  });

  it('a focused language select is not rebuilt', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const first = $('dictionary-language').options[0];
    $('dictionary-language').focus();
    externalChange(chrome, { en: ['a'] });
    await flush();
    expect($('dictionary-language').options[0]).toBe(first);
  });

  it('Add language on a stale choice keeps the terms another page added', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('dictionary-language').focus();
    $('dictionary-language').value = 'en';
    externalChange(chrome, { en: ['a'] });
    await flush();
    $('dictionary-add-group').click();
    await flush();
    expect(chrome.saves()).toEqual([]);
    expect(chips('en')).toEqual(['a']);
    expect(document.activeElement).toBe(input('en'));
  });
});

describe('dictionary page import and export', () => {
  const BLOB_URL = 'blob:chrome-extension://test/1';
  /** What a file input's value reads while it holds a file; jsdom cannot hold one. */
  const PICKED_VALUE = 'C:\\fakepath\\words.csv';
  const REVOKE_MS = 1000;

  const status = () => $('dictionary-status');
  const fileOf = (text, size = text.length) => ({ size, text: vi.fn(async () => text) });

  /** Plays the file chooser closing on `file`, or on nothing. */
  function pick(file) {
    const field = $('dictionary-file');
    Object.defineProperty(field, 'files', { value: file ? [file] : [], configurable: true });
    Object.defineProperty(field, 'value', { value: file ? PICKED_VALUE : '', configurable: true, writable: true });
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function importFile(text) {
    pick(fileOf(text));
    await flush();
  }

  const exported = (call = 0) => window.URL.createObjectURL.mock.calls[call][0];
  const exportedText = async (call = 0) => (
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(await exported(call).arrayBuffer())
  );

  let click;
  let downloads;

  beforeEach(() => {
    downloads = [];
    window.URL.createObjectURL = vi.fn(() => BLOB_URL);
    window.URL.revokeObjectURL = vi.fn();
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record() {
      downloads.push({ name: this.download, href: this.href });
    });
  });
  afterEach(() => {
    click.mockRestore();
    delete window.URL.createObjectURL;
    delete window.URL.revokeObjectURL;
  });

  it('Export downloads the CSV through a Blob URL', async () => {
    const stored = storedSettings({ any: ['Palowise'], el: ['Νόηση'] });
    vi.useFakeTimers();
    await start(fakeChrome(stored));
    $('dictionary-export').click();
    await flush();
    expect(downloads).toEqual([{ name: 'voicetype-dictionary.csv', href: BLOB_URL }]);
    expect(exported().type).toBe('text/csv;charset=utf-8');
    await vi.advanceTimersByTimeAsync(REVOKE_MS - 1);
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
    vi.useRealTimers();
    expect(await exportedText()).toBe(serializeDictionary(stored.dictionary));
  });

  it('Export of an empty dictionary is the header alone', async () => {
    await start(fakeChrome());
    $('dictionary-export').click();
    await flush();
    expect(downloads).toHaveLength(1);
    expect(await exportedText()).toBe(serializeDictionary({}));
  });

  it('Export includes a term still in an add field', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), 'typed');
    $('dictionary-export').click();
    await flush();
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['typed'] } }]);
    expect(await exportedText()).toBe(serializeDictionary({ any: ['typed'] }));
  });

  it('Export leaves out a term whose save failed during its flush', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    await start(chrome);
    typeInto(input('any'), 'typed');
    $('dictionary-export').click();
    await flush();
    expect(input('any').value).toBe('typed');
    expect(await exportedText()).toBe(serializeDictionary({}));
  });

  it('Export refuses when the settings did not load', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a'] }));
    chrome.script(MSG.GET_SETTINGS, { error: 'nope' });
    await start(chrome);
    $('dictionary-export').click();
    await flush();
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
    expect(status().textContent).toBe('Settings are not loaded. Nothing was exported.');
    expect(status().dataset.tone).toBe('error');
  });

  it('Export refuses while the first load is running, and works once it is done', async () => {
    let finish;
    const stored = storedSettings({ any: ['a'] });
    const chrome = fakeChrome(stored);
    chrome.script(MSG.GET_SETTINGS, new Promise((resolve) => { finish = resolve; }));
    const opened = start(chrome);
    $('dictionary-export').click();
    await flush();
    expect(window.URL.createObjectURL).not.toHaveBeenCalled();
    expect(status().textContent).toBe('Settings are not loaded. Nothing was exported.');

    finish(structuredClone(stored));
    await opened;
    $('dictionary-export').click();
    await flush();
    expect(status().textContent).toBe('');
    expect(status().hasAttribute('data-tone')).toBe(false);
    expect(await exportedText()).toBe(serializeDictionary(stored.dictionary));
  });

  it('the Import button opens the file picker', async () => {
    await start(fakeChrome());
    const opened = vi.spyOn($('dictionary-file'), 'click');
    $('dictionary-import').click();
    expect(opened).toHaveBeenCalledOnce();
  });

  it('Import merges and reports', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a'] }));
    await start(chrome);
    await importFile('language,term\nel,x\nen,a\n');
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['a'], el: ['x'] } }]);
    expect(status().textContent).toBe('Imported 1 term, skipped 1 already in the dictionary.');
    expect(status().hasAttribute('data-tone')).toBe(false);
    expect(groups()).toEqual(['any', 'el']);
    expect(chips('el')).toEqual(['x']);
  });

  it('Import counts in the plural and says nothing of skips when there are none', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    await importFile('c\nd\na\nb\n');
    expect(status().textContent).toBe('Imported 2 terms, skipped 2 already in the dictionary.');
    await importFile('e\n');
    expect(status().textContent).toBe('Imported 1 term.');
    await importFile('f\ng\n');
    expect(status().textContent).toBe('Imported 2 terms.');
  });

  it('Import shows the first bad line and saves nothing', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    await importFile('language,term\nxx,a\nyy,b\n');
    expect(status().textContent).toBe('Line 2: unknown language "xx". Nothing was imported.');
    expect(status().dataset.tone).toBe('error');
    expect(chrome.saves()).toEqual([]);
  });

  it('Import shows what the file says as text', async () => {
    await start(fakeChrome());
    await importFile('language,term\n<img src=x>,a\n');
    expect(status().textContent).toBe('Line 2: unknown language "<img src=x>". Nothing was imported.');
    expect(status().querySelector('img')).toBeNull();
  });

  it('Import over the cap saves nothing', async () => {
    const chrome = fakeChrome(storedSettings({ any: Array.from({ length: 95 }, (_, i) => `t${i}`) }));
    await start(chrome);
    await importFile(`${Array.from({ length: 10 }, (_, i) => `n${i}`).join('\n')}\n`);
    expect(status().textContent).toBe('This import would go over the 100 term limit by 5. Nothing was imported.');
    expect(status().dataset.tone).toBe('error');
    expect(chrome.saves()).toEqual([]);
  });

  it('Import with nothing new does not save', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    await importFile('a\n');
    expect(status().textContent).toBe('Nothing new: that term is already in the dictionary.');
    expect(status().hasAttribute('data-tone')).toBe(false);
    await importFile('a\nb\n');
    expect(status().textContent).toBe('Nothing new: all 2 terms are already in the dictionary.');
    expect(status().hasAttribute('data-tone')).toBe(false);
    expect(chrome.saves()).toEqual([]);
  });

  it('Import refuses a large file before reading it', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const large = fileOf('a\n', MAX_IMPORT_BYTES + 1);
    pick(large);
    await flush();
    expect(large.text).not.toHaveBeenCalled();
    expect(status().textContent).toBe('That file is too large. Nothing was imported.');
    expect(status().dataset.tone).toBe('error');
    expect(chrome.saves()).toEqual([]);

    pick(fileOf('a\n', MAX_IMPORT_BYTES));
    await flush();
    expect(status().textContent).toBe('Imported 1 term.');
  });

  it('Import reports a read failure', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    pick({ size: 1, text: async () => { throw new Error('gone'); } });
    await flush();
    expect(status().textContent).toBe('Could not read that file. Nothing was imported.');
    expect(status().dataset.tone).toBe('error');
    expect(chrome.saves()).toEqual([]);
  });

  it('Import reports a failed save', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    await start(chrome);
    await importFile('a\n');
    expect(status().textContent).toBe('Could not save. Nothing was imported.');
    expect(status().dataset.tone).toBe('error');
    expect(chips('any')).toEqual([]);
  });

  it('Import merges into the dictionary as it is when the file has been read', async () => {
    let finish;
    const chrome = fakeChrome();
    await start(chrome);
    pick({ size: 1, text: () => new Promise((resolve) => { finish = resolve; }) });
    typeInto(input('any'), 'typed');
    pressEnter(input('any'));
    await flush();
    finish('read\n');
    await flush();
    expect(chrome.saves().at(-1)).toEqual({ dictionary: { any: ['typed', 'read'] } });
    expect(status().textContent).toBe('Imported 1 term.');
  });

  it('closing the file picker on nothing does nothing', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    await importFile('language,term\nxx,a\n');
    const before = status().textContent;
    pick(null);
    await flush();
    expect(status().textContent).toBe(before);
    expect(status().dataset.tone).toBe('error');
    expect(chrome.saves()).toEqual([]);
  });

  it('the same file can be picked twice', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a'] }));
    await start(chrome);
    const paths = [
      fileOf('b\n', MAX_IMPORT_BYTES + 1),
      { size: 1, text: async () => { throw new Error('gone'); } },
      fileOf('language,term\nxx,b\n'),
      fileOf('a\n'),
      fileOf('b\n'),
    ];
    for (const file of paths) {
      pick(file);
      await flush();
      expect($('dictionary-file').value).toBe('');
    }
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    pick(fileOf('c\n'));
    await flush();
    expect(status().textContent).toBe('Could not save. Nothing was imported.');
    expect($('dictionary-file').value).toBe('');
  });

  it('the status clears at the next Export', async () => {
    await start(fakeChrome());
    await importFile('language,term\nxx,a\n');
    expect(status().dataset.tone).toBe('error');
    $('dictionary-export').click();
    expect(status().textContent).toBe('');
    expect(status().hasAttribute('data-tone')).toBe(false);
    await flush();
  });

  it('the status clears at the next file pick, and a success clears the error tone', async () => {
    let finish;
    await start(fakeChrome());
    await importFile('language,term\nxx,a\n');
    pick({ size: 1, text: () => new Promise((resolve) => { finish = resolve; }) });
    expect(status().textContent).toBe('');
    expect(status().hasAttribute('data-tone')).toBe(false);
    finish('a\n');
    await flush();
    expect(status().textContent).toBe('Imported 1 term.');
    expect(status().hasAttribute('data-tone')).toBe(false);
  });
});

describe('dictionary page heartbeat', () => {
  const beats = (chrome) => chrome.count(MSG.GET_SETTINGS) - 1;

  it('a pasted line list starts the heartbeat', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    stubInsertText(input('any'));
    paste(input('any'), 'Alpha\nBeta');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(beats(chrome)).toBe(1);
    input('any').value = '';
    input('any').dispatchEvent(new Event('input', { bubbles: true }));
  });

  it('the heartbeat runs only while a field holds text', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(beats(chrome)).toBe(0);

    typeInto(input('any'), 'Pal');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS - 1);
    typeInto(input('any'), 'Palo');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS - 1);
    expect(beats(chrome)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats(chrome)).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS - 1);
    expect(beats(chrome)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(beats(chrome)).toBe(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(beats(chrome)).toBe(3);

    pressEnter(input('any'));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(chrome.saves()).toEqual([{ dictionary: { any: ['Palo'] } }]);
    expect(beats(chrome)).toBe(3);

    typeInto(input('any'), 'again');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(beats(chrome)).toBe(4);
    typeInto(input('any'), '');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(beats(chrome)).toBe(4);
  });

  it('text emptied before the first beat sends none, and spaces alone are no text', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    await start(chrome);
    typeInto(input('any'), 'x');
    typeInto(input('any'), '  ');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(beats(chrome)).toBe(0);
  });

  it('refused text keeps it going, until the field empties', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ el: ['Noesis'] }));
    await start(chrome);
    typeInto(input('any'), 'noesis');
    pressEnter(input('any'));
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS + HEARTBEAT_MS);
    expect(input('any').value).toBe('noesis');
    expect(beats(chrome)).toBe(2);
    typeInto(input('any'), '');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(beats(chrome)).toBe(2);
  });

  it('text in any field keeps it going when another field empties', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ el: [] }));
    await start(chrome);
    typeInto(input('any'), 'a');
    typeInto(input('el'), 'b');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(beats(chrome)).toBe(1);
    pressEnter(input('any'));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(input('el').value).toBe('b');
    expect(beats(chrome)).toBeGreaterThanOrEqual(2);
  });

  it('a failed save that puts text back starts it again', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome();
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'x' });
    await start(chrome);
    typeInto(input('any'), 'Palowise');
    pressEnter(input('any'));
    await flush();
    expect(input('any').value).toBe('Palowise');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(beats(chrome)).toBe(1);
  });

  it('it stops when the card holding the text goes', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome(storedSettings({ el: [] }));
    await start(chrome);
    typeInto(input('el'), 'b');
    await vi.advanceTimersByTimeAsync(FIRST_BEAT_MS);
    expect(beats(chrome)).toBe(1);
    externalChange(chrome, {});
    await flush();
    expect(card('el')).toBeNull();
    const after = chrome.count(MSG.GET_SETTINGS);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(after);
  });
});

describe('dictionary page external changes', () => {
  it('an external change keeps typed text and focus', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    const field = input('any');
    field.focus();
    typeInto(field, 'pal');
    externalChange(chrome, { any: ['a', 'b', 'c'], el: ['d'] });
    await flush();
    expect(input('any')).toBe(field);
    expect(field.value).toBe('pal');
    expect(document.activeElement).toBe(field);
    expect(chips('any')).toEqual(['a', 'b', 'c']);
    expect(chips('el')).toEqual(['d']);
  });

  it('an external change keeps focus on a chip whose term is still there', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a', 'b'] }));
    await start(chrome);
    chipButton('b').focus();
    externalChange(chrome, { any: ['a', 'b', 'c'] });
    await flush();
    expect(chips('any')).toEqual(['a', 'b', 'c']);
    expect(document.activeElement).toBe(chipButton('b'));
  });

  it('a card keeps its chips when its terms did not change', async () => {
    const chrome = fakeChrome(storedSettings({ any: ['a'], el: ['b'] }));
    await start(chrome);
    const kept = chipButton('a');
    externalChange(chrome, { any: ['a'], el: ['b', 'c'] });
    await flush();
    expect(chipButton('a')).toBe(kept);
  });

  it('a new card goes in before the next existing one, and a card whose group went is removed', async () => {
    const chrome = fakeChrome(storedSettings({ fr: [], de: [] }));
    await start(chrome);
    const german = card('de');
    externalChange(chrome, { el: [], de: [] });
    await flush();
    expect(groups()).toEqual(['any', 'el', 'de']);
    expect(card('de')).toBe(german);
  });
});
