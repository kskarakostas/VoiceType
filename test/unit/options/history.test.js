// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { CONFIRM_GUARD_MS } from '../../../src/ui/form.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const ROUTE = 'history';
const HINT = 'Your last 20 dictations stay in memory until you close the browser. Turning this off clears them.';
const TS = new Date(2026, 10, 5, 14, 3).getTime();
const time = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function entry(fields = {}) {
  return { id: 'e1', raw: 'hello', text: 'hello', mode: 'default', host: 'example.com', ts: TS, ...fields };
}

function storedSettings(fields = {}) {
  return { ...freshSettings(), keys: { openai: 'sk-proj-abcdefgh1234', gemini: '' }, ...fields };
}

/**
 * Fake chrome for the settings page. `history` is what GET_HISTORY returns; `script` queues
 * one-shot answers; `fire` plays a storage.onChanged event; `saves()` returns the save patches.
 */
function fakeChrome({ stored = storedSettings(), history = [] } = {}) {
  const queues = new Map();
  const sent = [];
  const changeListeners = new Set();
  const fake = {
    sent,
    stored,
    history,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    count: (action) => sent.filter((m) => m.action === action).length,
    script(action, ...responses) { queues.set(action, [...(queues.get(action) || []), ...responses]); },
    fire(changes, area) { for (const listener of [...changeListeners]) listener(changes, area); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        const queue = queues.get(message.action);
        if (queue?.length) return queue.shift();
        if (message.action === MSG.GET_SETTINGS) return structuredClone(fake.stored);
        if (message.action === MSG.SAVE_SETTINGS) return { success: true };
        if (message.action === MSG.GET_HISTORY) return { entries: structuredClone(fake.history) };
        if (message.action === MSG.CLEAR_HISTORY) {
          fake.history = [];
          return { success: true };
        }
        return undefined;
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
  return fake;
}

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const rows = () => [...$('history-list').children];
const text = (row) => row.querySelector('.history-text').textContent;
const meta = (row) => row.querySelector('.history-meta').textContent;
const buttons = (row) => [...row.querySelectorAll('button')].map((b) => b.textContent);
const button = (row, label) => [...row.querySelectorAll('button')].find((b) => b.textContent === label);

async function start(chrome) {
  window.history.replaceState(null, '', `#${ROUTE}`);
  const page = await initOptions({ chrome, document, window });
  await flush();
  return page;
}

function stubClipboard(writeText = vi.fn(async () => {})) {
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
  delete window.navigator.clipboard;
  delete document.visibilityState;
});

describe('settings page History (V29)', () => {
  it('lists entries newest first with time, site and mode name', async () => {
    const later = TS + 3_600_000;
    await start(fakeChrome({
      history: [
        entry({ id: 'e2', text: 'second', raw: 'second', mode: 'email', host: 'mail.example.com', ts: later }),
        entry({ id: 'e1', text: 'first', raw: 'first' }),
      ],
    }));
    expect(rows().map(text)).toEqual(['second', 'first']);
    expect(meta(rows()[0])).toBe(`${time(later)} · mail.example.com · Email`);
    expect(meta(rows()[1])).toBe(`${time(TS)} · example.com · ${freshSettings().modes.default.name}`);
    expect($('history-empty').hidden).toBe(true);
    expect($('history-list').hidden).toBe(false);
  });

  it('shows the toggle hint and a Clear button named apart from Usage', async () => {
    await start(fakeChrome());
    expect($('keep-history').getAttribute('aria-describedby')).toBe('keep-history-hint');
    expect($('keep-history-hint').textContent).toBe(HINT);
    expect($('clear-history').textContent).toBe('Clear');
  });

  it('sets text with textContent', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    await start(fakeChrome({ history: [entry({ text: hostile, raw: `${hostile}!`, host: hostile, mode: hostile })] }));
    expect($('history-list').querySelector('img')).toBeNull();
    expect(text(rows()[0])).toBe(hostile);
    expect(meta(rows()[0])).toContain(hostile);
  });

  it('a null host reads as "This device"', async () => {
    await start(fakeChrome({ history: [entry({ host: null })] }));
    expect(meta(rows()[0]).split(' · ')[1]).toBe('This device');
  });

  it('a deleted mode falls back to its key', async () => {
    await start(fakeChrome({ history: [entry({ mode: 'custom_9' })] }));
    expect(meta(rows()[0]).split(' · ')[2]).toBe('custom_9');
  });

  it('a mode renamed elsewhere updates its row in place', async () => {
    const stored = storedSettings();
    const chrome = fakeChrome({ stored, history: [entry({ mode: 'email' })] });
    await start(chrome);
    const [row] = rows();
    stored.modes.email.name = 'Mail';
    chrome.fire({ settings: { newValue: {} } }, 'local');
    await flush();
    expect(rows()[0]).toBe(row);
    expect(meta(row).split(' · ')[2]).toBe('Mail');
  });

  it('Copy writes the entry text', async () => {
    const writeText = stubClipboard();
    await start(fakeChrome({ history: [entry({ raw: 'raw words', text: 'clean words' })] }));
    button(rows()[0], 'Copy').click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('clean words');
    expect($('toast').textContent).toBe('Copied to clipboard.');
  });

  it('Copy original shows only when raw differs', async () => {
    const writeText = stubClipboard();
    await start(fakeChrome({
      history: [entry({ id: 'e2', raw: 'raw words', text: 'clean words' }), entry()],
    }));
    expect(buttons(rows()[1])).toEqual(['Copy']);
    expect(buttons(rows()[0])).toEqual(['Copy', 'Copy original']);
    button(rows()[0], 'Copy original').click();
    await flush();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('raw words');
    expect($('toast').textContent).toBe('Original text copied.');
  });

  it('a rejected clipboard write shows a toast and throws nothing', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    stubClipboard(vi.fn(async () => { throw new Error('NotAllowedError'); }));
    await start(fakeChrome({ history: [entry()] }));
    button(rows()[0], 'Copy').click();
    await flush();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect($('toast').textContent).toBe('Could not copy.');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('a page with no clipboard shows the same toast', async () => {
    await start(fakeChrome({ history: [entry()] }));
    button(rows()[0], 'Copy').click();
    await flush();
    expect($('toast').textContent).toBe('Could not copy.');
  });

  it('Clear takes two clicks and sends CLEAR_HISTORY', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome({ history: [entry()] });
    await start(chrome);
    const clear = $('clear-history');
    clear.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_HISTORY)).toBe(0);
    expect(rows()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    clear.click();
    await flush();
    expect(chrome.count(MSG.CLEAR_HISTORY)).toBe(1);
    expect(rows()).toHaveLength(0);
    expect($('history-empty').textContent).toBe('No dictations yet.');
    expect($('toast').textContent).toBe('History cleared');
  });

  it('a confirmed Clear moves the focus to the page heading, as the button goes disabled', async () => {
    vi.useFakeTimers();
    await start(fakeChrome({ history: [entry()] }));
    const clear = $('clear-history');
    clear.focus();
    clear.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    clear.click();
    await flush();
    expect(clear.disabled).toBe(true);
    expect(document.activeElement).toBe($('h-history'));
  });

  it('a Clear that fails leaves the focus on the button', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome({ history: [entry()] });
    chrome.script(MSG.CLEAR_HISTORY, { success: false });
    await start(chrome);
    const clear = $('clear-history');
    clear.focus();
    clear.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    clear.click();
    await flush();
    expect(document.activeElement).toBe(clear);
  });

  it('a Clear leaves the focus alone when a newer entry keeps the button enabled', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome({ history: [entry()] });
    chrome.script(MSG.CLEAR_HISTORY, { success: true });
    await start(chrome);
    const clear = $('clear-history');
    clear.focus();
    clear.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    clear.click();
    await flush();
    expect(clear.disabled).toBe(false);
    expect(document.activeElement).toBe(clear);
  });

  it('a Clear does not take the focus from where it moved meanwhile', async () => {
    vi.useFakeTimers();
    await start(fakeChrome({ history: [entry()] }));
    const clear = $('clear-history');
    clear.focus();
    clear.click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    clear.click();
    $('keep-history').focus();
    await flush();
    expect(document.activeElement).toBe($('keep-history'));
  });

  it('a Clear that fails says so and keeps the list', async () => {
    vi.useFakeTimers();
    const chrome = fakeChrome({ history: [entry()] });
    chrome.script(MSG.CLEAR_HISTORY, { success: false, error: 'Nope' });
    await start(chrome);
    $('clear-history').click();
    await vi.advanceTimersByTimeAsync(CONFIRM_GUARD_MS);
    $('clear-history').click();
    await flush();
    expect(rows()).toHaveLength(1);
    expect($('toast').textContent).toBe('Could not clear history.');
    expect($('toast').dataset.tone).toBe('error');
  });

  it('Clear is disabled with nothing to clear', async () => {
    await start(fakeChrome());
    expect($('clear-history').disabled).toBe(true);
  });

  it('the toggle saves keepHistory only', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    expect($('keep-history').checked).toBe(true);
    $('keep-history').click();
    await flush();
    expect(chrome.saves()).toEqual([{ keepHistory: false }]);
  });

  it('a refused save puts the toggle back', async () => {
    const chrome = fakeChrome({ history: [entry()] });
    chrome.script(MSG.SAVE_SETTINGS, { success: false, error: 'Storage is full.' });
    await start(chrome);
    $('keep-history').click();
    await flush();
    expect($('keep-history').checked).toBe(true);
    expect(rows()).toHaveLength(1);
    expect($('toast').textContent).toBe('Storage is full.');
  });

  it('off: the list reads "History is off."', async () => {
    await start(fakeChrome({ stored: storedSettings({ keepHistory: false }) }));
    expect($('keep-history').checked).toBe(false);
    expect($('history-empty').hidden).toBe(false);
    expect($('history-empty').textContent).toBe('History is off.');
    expect($('history-list').hidden).toBe(true);
    expect($('clear-history').disabled).toBe(true);
  });

  it('turning it off takes the entries off the page before the store clears', async () => {
    const chrome = fakeChrome({ history: [entry()] });
    await start(chrome);
    $('keep-history').click();
    expect(rows()).toHaveLength(0);
    expect($('history-empty').textContent).toBe('History is off.');
  });

  it('on with nothing held reads "No dictations yet."', async () => {
    await start(fakeChrome());
    expect($('history-empty').hidden).toBe(false);
    expect($('history-empty').textContent).toBe('No dictations yet.');
    expect($('history-list').hidden).toBe(true);
  });

  it('a list that cannot load says so, and does not claim there is nothing', async () => {
    const chrome = fakeChrome({ history: [entry()] });
    chrome.script(MSG.GET_HISTORY, null);
    await start(chrome);
    expect($('history-empty').hidden).toBe(false);
    expect($('history-empty').textContent).toBe('Could not load history.');
    expect($('clear-history').disabled).toBe(true);
  });

  it('reloads on a session storage change of history', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    expect(rows()).toHaveLength(0);
    chrome.history = [entry()];
    chrome.fire({ history: { newValue: [] } }, 'session');
    await flush();
    expect(rows()).toHaveLength(1);
  });

  it('ignores other storage changes', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    const reads = chrome.count(MSG.GET_HISTORY);
    chrome.fire({ history: { newValue: [] } }, 'local');
    chrome.fire({ other: { newValue: 1 } }, 'session');
    await flush();
    expect(chrome.count(MSG.GET_HISTORY)).toBe(reads);
  });

  it('reloads when the tab becomes visible', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    chrome.history = [entry()];
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(rows()).toHaveLength(1);
  });

  it('a slow reply never brings back what a newer one cleared', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    let answerOld;
    chrome.script(MSG.GET_HISTORY, new Promise((resolve) => { answerOld = resolve; }), { entries: [] });
    chrome.fire({ history: { newValue: [] } }, 'session');
    chrome.fire({ history: { newValue: [] } }, 'session');
    await flush();
    answerOld({ entries: [entry()] });
    await flush();
    expect(rows()).toHaveLength(0);
  });

  it('a reload keeps the row and the focus on it', async () => {
    const chrome = fakeChrome({ history: [entry()] });
    await start(chrome);
    const [row] = rows();
    const copy = button(row, 'Copy');
    document.querySelector('section[data-route="history"]').hidden = false;
    copy.focus();
    chrome.history = [entry({ id: 'e2', text: 'newer', raw: 'newer' }), entry()];
    chrome.fire({ history: { newValue: [] } }, 'session');
    await flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toBe(row);
    expect(document.activeElement).toBe(copy);
  });

  it('a reload with the same entries leaves the list alone, so a press in progress still lands', async () => {
    const chrome = fakeChrome({ history: [entry()] });
    await start(chrome);
    const replace = vi.spyOn($('history-list'), 'replaceChildren');
    chrome.fire({ history: { newValue: [] } }, 'session');
    await flush();
    expect(replace).not.toHaveBeenCalled();
  });

  it('each Copy names its entry for a screen reader', async () => {
    await start(fakeChrome({ history: [entry({ raw: 'raw words', text: 'clean words' })] }));
    expect(button(rows()[0], 'Copy').getAttribute('aria-label')).toBe(`Copy dictation from ${time(TS)}`);
    expect(button(rows()[0], 'Copy original').getAttribute('aria-label')).toBe(`Copy original from ${time(TS)}`);
  });
});
