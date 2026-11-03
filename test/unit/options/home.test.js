// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { createHomeSection } from '../../../src/options/sections/home.js';
import { NOT_COUNTED } from '../../../src/options/home-stats.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';
import { applyUsage, emptyLog, summarize } from '../../../src/background/usage.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const STATE_IDS = ['home-error', 'home-empty', 'home-stats'];

/** A GET_USAGE reply in the real shape: entries logged today, summarized now. */
function reply(...entries) {
  const now = new Date();
  return summarize(entries.reduce((log, entry) => applyUsage(log, entry, now), emptyLog()), now);
}
const DICTATION = { provider: 'openai', audioSeconds: 60, cost: 0.006, mode: 'email', words: 160 };

function storedSettings() {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: '' };
  return s;
}

/**
 * Fake chrome for the settings page. `script(action, ...responses)` queues one-shot answers;
 * without a queued answer each action gets a default. `fire(changes, area)` plays a
 * storage.onChanged event.
 */
function fakeChrome(usage = reply(DICTATION)) {
  const queues = new Map();
  const sent = [];
  const changeListeners = new Set();
  const defaults = {
    [MSG.GET_SETTINGS]: () => structuredClone(storedSettings()),
    [MSG.SAVE_SETTINGS]: () => ({ success: true }),
    [MSG.GET_USAGE]: () => structuredClone(usage),
  };
  return {
    sent,
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
const flush = () => new Promise((r) => setTimeout(r, 0));
const text = (id) => $(id).textContent;
const shown = () => STATE_IDS.filter((id) => !$(id).hidden);
const todayLi = () => $('home-days').querySelector('li[aria-current="date"]');

/** Open the settings page at Home with only the Home section mounted. */
async function start(chrome) {
  window.history.replaceState(null, '', '#home');
  const page = await initOptions({ chrome, document, window, sections: [createHomeSection] });
  await flush();
  return page;
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  try {
    document.dispatchEvent(new Event('visibilitychange'));
  } finally {
    delete document.visibilityState;
  }
}

/** Every text node under main, so a NaN in any card or day square is caught. */
function pageTexts() {
  const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  const out = [];
  while (walker.nextNode()) out.push(walker.currentNode.nodeValue);
  return out;
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Home', () => {
  it("Home shows this week's stats", async () => {
    await start(fakeChrome());
    expect(shown()).toEqual(['home-stats']);
    expect(text('home-saved')).toBe('about 3 min');
    expect(text('home-saved-detail')).toBe('1 min talking instead of 4 min typing');
    expect(text('home-words-week')).toBe('160');
    expect(text('home-words-total')).toBe('160');
    expect(text('home-speed')).toBe('160 words per minute');
    expect(text('home-refined')).toBe('1 of 1 sessions');
    expect(text('home-cost-week')).toBe('<$0.01');
    expect(text('home-cost-per-1k')).toBe('$0.04');
    const days = [...$('home-days').querySelectorAll('li')];
    expect(days).toHaveLength(7);
    expect(days.map((li) => li.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect($('home-days').querySelectorAll('[aria-current]')).toHaveLength(1);
    expect(todayLi().dataset.state).toBe('dictated');
    expect(todayLi().getAttribute('aria-label')).toMatch(/day, dictated$/);
    expect(todayLi().title).toBe(todayLi().getAttribute('aria-label'));
    expect(text('home-days-count')).toBe('1 of 7 days');
  });

  it('day squares name their state in words, not only by colour', async () => {
    await start(fakeChrome());
    const days = [...$('home-days').querySelectorAll('li')];
    const today = days.indexOf(todayLi());
    days.forEach((li, i) => {
      const name = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i];
      let expected = 'dictated';
      if (i < today) expected = 'not dictated';
      if (i > today) expected = 'still to come';
      expect(li.getAttribute('aria-label')).toBe(`${name}, ${expected}`);
      expect(li.dataset.state).toBe(i < today ? 'missed' : i > today ? 'upcoming' : 'dictated');
    });
    expect($('home-days').getAttribute('aria-label')).toBe('Days dictated this week');
  });

  it('Home shows the empty line with no sessions', async () => {
    await start(fakeChrome(reply()));
    expect(shown()).toEqual(['home-empty']);
    expect(text('home-empty')).toBe('Dictate once to see your stats.');
  });

  it('Home shows the error line when GET_USAGE fails', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_USAGE, null);
    await start(chrome);
    expect(shown()).toEqual(['home-error']);
    expect(text('home-error')).toBe('Could not load your stats.');
  });

  it('a 2.2 log shows cost and days but no word numbers', async () => {
    await start(fakeChrome(reply({ provider: 'openai', audioSeconds: 60, cost: 0.05, mode: 'default' })));
    expect(shown()).toEqual(['home-stats']);
    expect(text('home-words-week')).toBe(NOT_COUNTED);
    expect(text('home-words-total')).toBe(NOT_COUNTED);
    expect(text('home-cost-week')).toBe('$0.05');
    expect(text('home-refined')).toBe('0 of 1 sessions');
    expect(todayLi().dataset.state).toBe('dictated');
    expect(text('home-days-count')).toBe('1 of 7 days');
    for (const t of pageTexts()) expect(t).not.toMatch(/NaN|Infinity/);
  });

  it('Home reloads on a usageLog change and on becoming visible', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    expect(chrome.count(MSG.GET_USAGE)).toBe(1);

    chrome.script(MSG.GET_USAGE, reply(DICTATION, { ...DICTATION, words: 40 }));
    chrome.fire({ usageLog: { newValue: {} } }, 'local');
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);
    expect(text('home-words-week')).toBe('200');
    expect(text('home-refined')).toBe('2 of 2 sessions');

    chrome.fire({ usageLog: {} }, 'sync');
    chrome.fire({ settings: {} }, 'local');
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);

    setVisibility('hidden');
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);

    setVisibility('visible');
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(3);
  });

  it('a stale GET_USAGE reply never overwrites a newer one', async () => {
    const chrome = fakeChrome();
    let resolveFirst;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    chrome.script(MSG.GET_USAGE, first, reply({ ...DICTATION, words: 320 }));
    await start(chrome);
    chrome.fire({ usageLog: { newValue: {} } }, 'local');
    await flush();
    expect(text('home-words-week')).toBe('320');

    resolveFirst(reply({ ...DICTATION, words: 999 }));
    await flush();
    expect(chrome.count(MSG.GET_USAGE)).toBe(2);
    expect(text('home-words-week')).toBe('320');
    expect(shown()).toEqual(['home-stats']);
  });
});

describe('PageContext.onUsageChange', () => {
  it('calls the listener for usageLog in local and on visible, and stops after unsubscribe', async () => {
    const chrome = fakeChrome();
    let ctx;
    window.history.replaceState(null, '', '#home');
    await initOptions({ chrome, document, window, sections: [(c) => { ctx = c; return { render() {} }; }] });
    const listener = vi.fn();
    const off = ctx.onUsageChange(listener);
    chrome.fire({ usageLog: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledTimes(1);
    chrome.fire({ usageLog: { newValue: {} } }, 'sync');
    chrome.fire({ settings: { newValue: {} } }, 'local');
    expect(listener).toHaveBeenCalledTimes(1);
    setVisibility('visible');
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    chrome.fire({ usageLog: { newValue: {} } }, 'local');
    setVisibility('visible');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
