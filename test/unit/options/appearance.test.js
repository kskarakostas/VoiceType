// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const ROUTE = 'settings/appearance';

function storedSettings(fields = {}) {
  return { ...freshSettings(), ...fields };
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

const flush = () => new Promise((r) => setTimeout(r, 0));
const section = () => document.querySelector(`section[data-route="${ROUTE}"]`);
const radio = (value) => section().querySelector(`input[name="pill-style"][value="${value}"]`);
const checked = () => [...section().querySelectorAll('input[name="pill-style"]')].filter((r) => r.checked).map((r) => r.value);

function start(chrome) {
  window.history.replaceState(null, '', `#${ROUTE}`);
  return initOptions({ chrome, document, window });
}

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});

describe('settings page Appearance', () => {
  it('checks the stored style', async () => {
    await start(fakeChrome(storedSettings({ pillStyle: 'minimal' })));
    expect(radio('minimal').checked).toBe(true);
    expect(radio('pill').checked).toBe(false);
    expect(radio('dot').checked).toBe(false);
  });

  it('a choice saves at once', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    vi.useFakeTimers();
    try {
      radio('pill').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(chrome.saves()).toEqual([{ pillStyle: 'pill' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stored change re-renders', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'pill' }));
    await start(chrome);
    expect(checked()).toEqual(['pill']);
    chrome.stored = storedSettings({ pillStyle: 'dot' });
    chrome.fire();
    await flush();
    expect(checked()).toEqual(['dot']);
  });

  it('a failed save puts the stored style back', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'dot' }));
    await start(chrome);
    chrome.failNextSave = true;
    radio('minimal').click();
    await flush();
    expect(checked()).toEqual(['dot']);
    expect(document.getElementById('toast').textContent).toBe('Storage is full.');
  });

  it('the group is labelled', async () => {
    await start(fakeChrome());
    const group = section().querySelector('[role="radiogroup"]');
    expect(group.getAttribute('aria-labelledby')).toBe('h-settings-appearance');
    const radios = [...group.querySelectorAll('input[type="radio"][name="pill-style"]')];
    expect(radios.map((r) => r.value)).toEqual(['pill', 'dot', 'minimal']);
  });

  it('previews are static and hidden from assistive tech', async () => {
    await start(fakeChrome());
    const previews = [...section().querySelectorAll('.style-preview')];
    expect(previews).toHaveLength(3);
    for (const preview of previews) {
      expect(preview.getAttribute('aria-hidden')).toBe('true');
      expect(preview.querySelector('button, input, script, img')).toBeNull();
    }
  });

  it('the placeholder is gone', async () => {
    await start(fakeChrome());
    expect(section().querySelector('.placeholder')).toBeNull();
  });

  it('copy', async () => {
    await start(fakeChrome());
    const card = (value) => radio(value).closest('.style-card');
    expect(card('minimal').textContent).toContain('hotkey');
    expect(card('dot').querySelector('.tag').textContent).toBe('Default');
    expect(section().textContent).toContain('Sites with Hide pill use Minimal.');
  });
});
