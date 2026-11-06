// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, MINI_SIZES, REC_COLORS } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const OPTIONS_CSS = readFileSync(join(import.meta.dirname, '../../../src/options/options.css'), 'utf8');
const PILL_CSS = readFileSync(join(import.meta.dirname, '../../../src/content/pill.css'), 'utf8');
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
const choice = (name, value) => section().querySelector(`input[name="${name}"][value="${value}"]`);
const checkedOf = (name) => [...section().querySelectorAll(`input[name="${name}"]`)].filter((r) => r.checked).map((r) => r.value);
const sizeGroup = () => document.getElementById('mini-size-group');

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
    const hint = (value) => card(value).querySelector('.hint').textContent;
    expect(hint('minimal')).toBe('Nothing until you record, then a small indicator beside the field. Start and stop with the hotkey.');
    expect(hint('pill')).toBe('The full bar beside the field, always in view.');
    expect(hint('dot')).toBe('A small dot beside the field. It opens into the bar when you point at it.');
    expect(card('dot').querySelector('.tag').textContent).toBe('Default');
    expect(section().textContent).toContain('Sites with Hide pill use Minimal.');
  });
});

describe('settings page Appearance, Minimal size and recording colour', () => {
  it('shows the size choice only for Minimal', async () => {
    await start(fakeChrome(storedSettings({ pillStyle: 'dot' })));
    expect(sizeGroup().hidden).toBe(true);
    radio('minimal').click();
    expect(sizeGroup().hidden).toBe(false);
    radio('pill').click();
    expect(sizeGroup().hidden).toBe(true);
  });

  it('shows it from the start for a stored Minimal, and follows a stored change', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'minimal' }));
    await start(chrome);
    expect(sizeGroup().hidden).toBe(false);
    chrome.stored = storedSettings({ pillStyle: 'pill' });
    chrome.fire();
    await flush();
    expect(sizeGroup().hidden).toBe(true);
  });

  it('keeps the colour choice for every style', async () => {
    for (const pillStyle of ['pill', 'dot', 'minimal']) {
      document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
      await start(fakeChrome(storedSettings({ pillStyle })));
      expect(choice('rec-color', 'red').closest('[role="radiogroup"]').hidden, pillStyle).toBe(false);
    }
  });

  it('checks the stored size and colour, and a stored change moves them', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'minimal', miniSize: 'large', recColor: 'emerald' }));
    await start(chrome);
    expect(checkedOf('mini-size')).toEqual(['large']);
    expect(checkedOf('rec-color')).toEqual(['emerald']);
    chrome.stored = storedSettings({ pillStyle: 'minimal', miniSize: 'small', recColor: 'vampire' });
    chrome.fire();
    await flush();
    expect(checkedOf('mini-size')).toEqual(['small']);
    expect(checkedOf('rec-color')).toEqual(['vampire']);
  });

  it('a fresh record shows Medium and Classic red', async () => {
    await start(fakeChrome());
    expect(checkedOf('mini-size')).toEqual(['medium']);
    expect(checkedOf('rec-color')).toEqual(['red']);
  });

  it('saves a size and a colour at once', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'minimal' }));
    await start(chrome);
    vi.useFakeTimers();
    try {
      choice('mini-size', 'xlarge').click();
      choice('rec-color', 'mocha').click();
      await vi.advanceTimersByTimeAsync(0);
      expect(chrome.saves()).toEqual([{ miniSize: 'xlarge' }, { recColor: 'mocha' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed save puts the stored size and colour back', async () => {
    const chrome = fakeChrome(storedSettings({ pillStyle: 'minimal', miniSize: 'large', recColor: 'emerald' }));
    await start(chrome);
    chrome.failNextSave = true;
    choice('mini-size', 'small').click();
    await flush();
    expect(checkedOf('mini-size')).toEqual(['large']);
    chrome.failNextSave = true;
    choice('rec-color', 'mocha').click();
    await flush();
    expect(checkedOf('rec-color')).toEqual(['emerald']);
  });

  it('each group is labelled and lists the values in order, named as the spec has them', async () => {
    await start(fakeChrome());
    const groups = [
      ['mini-size', 'Minimal size', MINI_SIZES, ['Small', 'Medium', 'Large', 'Extra large']],
      ['rec-color', 'Recording colour', REC_COLORS, ['Classic red', 'Vampire red', 'Obsidian purple', 'Emerald green', 'Mocha brown']],
    ];
    for (const [name, label, values, names] of groups) {
      const radios = [...section().querySelectorAll(`input[name="${name}"]`)];
      const group = radios[0].closest('[role="radiogroup"]');
      expect(radios.map((r) => r.value), name).toEqual(values);
      expect(radios.every((r) => r.closest('[role="radiogroup"]') === group), name).toBe(true);
      expect(document.getElementById(group.getAttribute('aria-labelledby')).textContent, name).toBe(label);
      expect(radios.map((r) => r.closest('.style-card').querySelector('.style-name').textContent.trim()), name).toEqual(names);
    }
  });

  it('a swatch only shows a colour: the name and the radio say which one is chosen', async () => {
    await start(fakeChrome(storedSettings({ recColor: 'obsidian' })));
    const radios = [...section().querySelectorAll('input[name="rec-color"]')];
    for (const r of radios) {
      const swatch = r.closest('.style-card').querySelector('.swatch');
      expect(swatch.getAttribute('aria-hidden')).toBe('true');
      expect(swatch.classList.contains(`swatch-${r.value}`)).toBe(true);
      expect(swatch.textContent).toBe('');
    }
    expect(checkedOf('rec-color')).toEqual(['obsidian']);
  });

  it('each swatch paints the colour pill.css gives that recording colour', () => {
    const swatchCss = (value) => OPTIONS_CSS.match(new RegExp(`\\.swatch-${value}\\s*{\\s*background:\\s*(#[0-9a-f]{6});\\s*}`))?.[1];
    const pillCss = (value) => (value === 'red'
      ? PILL_CSS.match(/\.vt\s*{[^}]*?--vt-rec:\s*(#[0-9a-f]{6});/)
      : PILL_CSS.match(new RegExp(`\\.vt\\[data-rec='${value}'\\]\\s*{\\s*--vt-rec:\\s*(#[0-9a-f]{6});`)))?.[1];
    for (const value of REC_COLORS) {
      expect(pillCss(value), `pill.css ${value}`).toBeDefined();
      expect(swatchCss(value), `options.css ${value}`).toBe(pillCss(value));
    }
  });
});
