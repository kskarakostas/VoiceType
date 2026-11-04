// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const ROUTE = 'settings/sound';
const SOUNDS_HINT = 'Short tones when recording starts, when it stops, when the text is ready, and when something goes wrong.';
const COPY_HINT = 'Also copies every dictation to the clipboard. This replaces whatever is on the clipboard.';

function storedSettings(fields = {}) {
  return { ...freshSettings(), keys: { openai: 'sk-proj-abcdefgh1234', gemini: '' }, ...fields };
}

/**
 * Fake chrome for the settings page. `stored` is what GET_SETTINGS returns, `failNextSave` makes
 * the next save fail, `fire()` plays a settings change, `saves()` returns the SAVE_SETTINGS patches.
 */
function fakeChrome(initial = storedSettings()) {
  const sent = [];
  const changeListeners = new Set();
  const fake = {
    stored: initial,
    failNextSave: false,
    saves: () => sent.filter((m) => m.action === MSG.SAVE_SETTINGS).map((m) => m.settings),
    fire() { for (const listener of [...changeListeners]) listener({ settings: { newValue: {} } }, 'local'); },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        sent.push(structuredClone(message));
        if (message.action === MSG.GET_SETTINGS) return structuredClone(fake.stored);
        if (message.action !== MSG.SAVE_SETTINGS) return undefined;
        if (!fake.failNextSave) return { success: true };
        fake.failNextSave = false;
        return { success: false, error: 'Storage is full.' };
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
const flush = () => new Promise((r) => setTimeout(r, 0));

function start(chrome) {
  window.history.replaceState(null, '', `#${ROUTE}`);
  return initOptions({ chrome, document, window });
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});

describe('settings page Sound and clipboard', () => {
  it('renders both checkboxes from settings', async () => {
    await start(fakeChrome(storedSettings({ sounds: true, alwaysCopy: false })));
    expect($('sounds').checked).toBe(true);
    expect($('always-copy').checked).toBe(false);
  });

  it('renders the other way round too', async () => {
    await start(fakeChrome(storedSettings({ sounds: false, alwaysCopy: true })));
    expect($('sounds').checked).toBe(false);
    expect($('always-copy').checked).toBe(true);
  });

  it('Play sounds saves only sounds', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('sounds').click();
    await flush();
    expect(chrome.saves()).toEqual([{ sounds: true }]);
  });

  it('Always copy saves only alwaysCopy', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    $('always-copy').click();
    await flush();
    expect(chrome.saves()).toEqual([{ alwaysCopy: true }]);
  });

  it('unticking a box saves false', async () => {
    const chrome = fakeChrome(storedSettings({ sounds: true, alwaysCopy: true }));
    await start(chrome);
    $('always-copy').click();
    await flush();
    expect(chrome.saves()).toEqual([{ alwaysCopy: false }]);
    expect($('sounds').checked).toBe(true);
  });

  it('a storage change re-renders', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    chrome.stored = storedSettings({ sounds: true, alwaysCopy: true });
    chrome.fire();
    await flush();
    expect($('sounds').checked).toBe(true);
    expect($('always-copy').checked).toBe(true);
  });

  it('a failed save restores the box', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    chrome.failNextSave = true;
    $('sounds').click();
    await flush();
    expect($('sounds').checked).toBe(false);
    expect($('toast').textContent).toBe('Storage is full.');
  });

  it('the always-copy hint says it replaces the clipboard', async () => {
    await start(fakeChrome());
    expect($('always-copy-hint').textContent).toBe(COPY_HINT);
  });

  it('the placeholder is gone', async () => {
    await start(fakeChrome());
    const section = document.querySelector(`section[data-route="${ROUTE}"]`);
    expect(section.querySelector('.placeholder')).toBeNull();
    expect(section.querySelectorAll('.card')).toHaveLength(1);
  });

  it('each hint is tied to its box', async () => {
    await start(fakeChrome());
    const hintOf = (id) => $($(id).getAttribute('aria-describedby')).textContent;
    expect(hintOf('sounds')).toBe(SOUNDS_HINT);
    expect(hintOf('always-copy')).toBe(COPY_HINT);
  });
});
