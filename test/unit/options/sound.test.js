// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings, SOUND_SETS } from '../../../src/shared/defaults.js';
import { CUE_NAMES } from '../../../src/offscreen/cues.js';

// The page plays through createCuePlayer; the real cues keep their other exports.
const { play, createCuePlayer } = vi.hoisted(() => {
  const play = vi.fn();
  return { play, createCuePlayer: vi.fn() };
});
vi.mock('../../../src/offscreen/cues.js', async (importOriginal) => ({ ...(await importOriginal()), createCuePlayer }));

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
const section = () => document.querySelector(`section[data-route="${ROUTE}"]`);
const setRadio = (value) => section().querySelector(`input[name="sound-set"][value="${value}"]`);
const checkedSets = () => [...section().querySelectorAll('input[name="sound-set"]')].filter((r) => r.checked).map((r) => r.value);
const playButtons = () => [...section().querySelectorAll('[data-play]')];
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

/** Presses a button and lets what it started settle. */
async function press(selector) {
  document.querySelector(selector).click();
  await flush();
}

function start(chrome) {
  window.history.replaceState(null, '', `#${ROUTE}`);
  return initOptions({ chrome, document, window });
}

beforeEach(() => {
  play.mockReset();
  play.mockResolvedValue({ ok: true });
  createCuePlayer.mockReset();
  createCuePlayer.mockImplementation(() => ({ play }));
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

describe('settings page Sound and clipboard, sound sets', () => {
  it('checks the stored set, and a stored change moves it', async () => {
    const chrome = fakeChrome(storedSettings({ soundSet: 'warm' }));
    await start(chrome);
    expect(checkedSets()).toEqual(['warm']);
    chrome.stored = storedSettings({ soundSet: 'classic' });
    chrome.fire();
    await flush();
    expect(checkedSets()).toEqual(['classic']);
  });

  it('a fresh record shows Soft', async () => {
    await start(fakeChrome());
    expect(checkedSets()).toEqual(['soft']);
  });

  it('saves a sound set', async () => {
    const chrome = fakeChrome();
    await start(chrome);
    setRadio('tap').click();
    await flush();
    expect(chrome.saves()).toEqual([{ soundSet: 'tap' }]);
  });

  it('a failed save puts the stored set back', async () => {
    const chrome = fakeChrome(storedSettings({ soundSet: 'warm' }));
    await start(chrome);
    chrome.failNextSave = true;
    setRadio('tap').click();
    await flush();
    expect(checkedSets()).toEqual(['warm']);
  });

  it('lists the four sets in order as a labelled group, each with a Play button that names it', async () => {
    await start(fakeChrome());
    const radios = [...section().querySelectorAll('input[name="sound-set"]')];
    const group = radios[0].closest('[role="radiogroup"]');
    expect(radios.map((r) => r.value)).toEqual(SOUND_SETS);
    expect(radios.every((r) => r.closest('[role="radiogroup"]') === group)).toBe(true);
    expect($(group.getAttribute('aria-labelledby')).textContent).toBe('Sound set');
    const names = ['Soft', 'Warm', 'Single tap', 'Classic'];
    expect(radios.map((r) => r.closest('.style-card').querySelector('.style-name').textContent.trim())).toEqual(names);
    expect(playButtons().map((b) => b.dataset.play)).toEqual(SOUND_SETS);
    expect(playButtons().map((b) => [b.textContent, b.getAttribute('aria-label'), b.type])).toEqual(
      names.map((name) => ['Play', `Play ${name}`, 'button']),
    );
    // A button inside a label is not valid markup and would split the card's two jobs.
    expect(section().querySelector('label button')).toBeNull();
  });

  it('each radio is named by its own label', async () => {
    await start(fakeChrome());
    const radios = [...section().querySelectorAll('input[name="sound-set"]')];
    expect(radios).toHaveLength(SOUND_SETS.length);
    for (const r of radios) {
      expect(r.labels).toHaveLength(1);
      expect(r.labels[0].textContent.trim()).not.toBe('');
    }
  });

  it('plays the four cues of a set in turn, with sounds off too', async () => {
    await start(fakeChrome(storedSettings({ sounds: false })));
    await press('[data-play="warm"]');
    expect(play.mock.calls).toEqual(CUE_NAMES.map((name) => [name, 'warm']));
  });

  it('plays the four cues in turn: the next waits for the last', async () => {
    const gates = CUE_NAMES.map(() => deferred());
    let n = 0;
    play.mockImplementation(() => gates[n++].promise);
    await start(fakeChrome());
    document.querySelector('[data-play="tap"]').click();
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    gates[0].resolve({ ok: true });
    await flush();
    expect(play).toHaveBeenCalledTimes(2);
    for (const gate of gates.slice(1)) gate.resolve({ ok: true });
    await flush();
    expect(play.mock.calls).toEqual(CUE_NAMES.map((name) => [name, 'tap']));
  });

  it('a Play press sends no message to the worker: the page plays the cues itself (V61)', async () => {
    const chrome = fakeChrome(storedSettings({ sounds: false }));
    await start(chrome);
    await flush();
    const before = chrome.runtime.sendMessage.mock.calls.length;
    await press('[data-play="warm"]');
    expect(play).toHaveBeenCalledTimes(CUE_NAMES.length);
    expect(chrome.runtime.sendMessage.mock.calls).toHaveLength(before);
  });

  it('Play previews a set and does not choose it', async () => {
    const chrome = fakeChrome(storedSettings({ soundSet: 'soft' }));
    await start(chrome);
    await press('[data-play="classic"]');
    expect(chrome.saves()).toEqual([]);
    expect(checkedSets()).toEqual(['soft']);
  });

  it('builds the player at the first press, once, over an AudioContext', async () => {
    class FakeAudioContext {}
    vi.stubGlobal('AudioContext', FakeAudioContext);
    try {
      await start(fakeChrome());
      expect(createCuePlayer).not.toHaveBeenCalled();
      await press('[data-play="soft"]');
      await press('[data-play="warm"]');
      expect(createCuePlayer).toHaveBeenCalledTimes(1);
      expect(createCuePlayer.mock.calls[0][0].createContext()).toBeInstanceOf(FakeAudioContext);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a second press while a set plays does nothing', async () => {
    const gate = deferred();
    play.mockImplementation(() => gate.promise);
    await start(fakeChrome());
    document.querySelector('[data-play="soft"]').click();
    document.querySelector('[data-play="warm"]').click();
    document.querySelector('[data-play="soft"]').click();
    gate.resolve({ ok: true });
    await flush();
    expect(play.mock.calls).toEqual(CUE_NAMES.map((name) => [name, 'soft']));
  });

  it('the buttons say they are busy while a set plays, and are free after', async () => {
    const gate = deferred();
    play.mockImplementation(() => gate.promise);
    await start(fakeChrome());
    const busy = () => playButtons().map((b) => b.getAttribute('aria-disabled'));
    document.querySelector('[data-play="soft"]').click();
    expect(busy()).toEqual(['true', 'true', 'true', 'true']);
    gate.resolve({ ok: true });
    await flush();
    expect(busy()).toEqual([null, null, null, null]);
    play.mockClear();
    await press('[data-play="warm"]');
    expect(play.mock.calls).toEqual(CUE_NAMES.map((name) => [name, 'warm']));
  });

  it('a cue that cannot play ends the set, since the rest would each wait out the same timeout', async () => {
    play.mockResolvedValue({ ok: false });
    await start(fakeChrome());
    await press('[data-play="soft"]');
    expect(play).toHaveBeenCalledTimes(1);
    expect(playButtons().every((b) => !b.hasAttribute('aria-disabled'))).toBe(true);
  });

  it('a player that cannot start leaves the page working', async () => {
    createCuePlayer.mockImplementation(() => { throw new Error('no audio'); });
    await start(fakeChrome());
    await expect(press('[data-play="soft"]')).resolves.toBeUndefined();
    expect(playButtons().every((b) => !b.hasAttribute('aria-disabled'))).toBe(true);
    // The next press tries again, and a save still works.
    createCuePlayer.mockImplementation(() => ({ play }));
    await press('[data-play="soft"]');
    expect(play).toHaveBeenCalledTimes(CUE_NAMES.length);
  });

  it('a play that rejects leaves the page working', async () => {
    play.mockRejectedValue(new Error('closed'));
    await start(fakeChrome());
    await expect(press('[data-play="soft"]')).resolves.toBeUndefined();
    expect(playButtons().every((b) => !b.hasAttribute('aria-disabled'))).toBe(true);
  });
});
