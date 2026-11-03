// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { createDictionarySection } from '../../../src/options/sections/dictionary.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { SPOKEN_LANGUAGES } from '../../../src/shared/dictionary.js';
import { CONFIRM_GUARD_MS } from '../../../src/ui/form.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const SETTINGS_CHANGE = { settings: { newValue: {} } };
const REMOVE_PROMPT = 'Click again to remove this group and its terms';

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
function pressEnter(el) {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
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
    expect($('dictionary-export').textContent).toBe('Export');
    expect($('dictionary-import').textContent).toBe('Import');
    expect($('dictionary-file').type).toBe('file');
    expect($('dictionary-file').hidden).toBe(true);
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
    expect(label.textContent).toBe('Add a term');
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

  it('pressing the mouse on a chip leaves the field focused, so the click lands on that chip', async () => {
    await start(fakeChrome(storedSettings({ any: ['a'] })));
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    chipButton('a').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
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
