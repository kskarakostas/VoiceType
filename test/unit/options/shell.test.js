// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { ROUTES } from '../../../src/options/routes.js';
import { MSG } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Reload this page.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const PLACEHOLDER = 'Coming in a later update.';

function storedSettings() {
  const s = freshSettings();
  s.keys = { openai: 'sk-proj-abcdefgh1234', gemini: 'AIza-gemini-5678' };
  return s;
}

/**
 * Fake chrome for the settings page. `script(action, ...responses)` queues one-shot answers;
 * without a queued answer each action gets a success default. `fire(changes, area)` plays a
 * storage.onChanged event.
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

/** A test section that records the context it was given and counts renders. */
function probe() {
  const state = { ctx: null, renders: 0, typingSaves: [] };
  state.factory = (ctx) => {
    state.ctx = ctx;
    return { render: () => { state.renders += 1; }, typingSaves: state.typingSaves };
  };
  return state;
}

const $ = (id) => document.getElementById(id);
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((r) => setTimeout(r, 0)));
const start = (chrome, sections) => initOptions({ chrome, document, window, sections });
const visible = () => [...document.querySelectorAll('section[data-route]')].filter((s) => !s.hidden).map((s) => s.dataset.route);
const navLink = (id) => document.querySelector(`nav a[href="#${id}"]`);
const SETTINGS_CHANGE = { settings: { newValue: {} } };

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  vi.useRealTimers();
});

describe('settings page shell', () => {
  it('opens Home with no hash and rewrites the URL', async () => {
    const page = await start(fakeChrome());
    expect(window.location.hash).toBe('#home');
    expect(visible()).toEqual(['home']);
    expect(page.route).toBe('home');
    expect(navLink('home').getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('nav [aria-current]')).toHaveLength(1);
  });

  it('opens the route in the hash and maps #settings to Provider', async () => {
    window.history.replaceState(null, '', '#settings');
    const page = await start(fakeChrome());
    expect(window.location.hash).toBe('#settings/provider');
    expect(visible()).toEqual(['settings/provider']);
    expect(page.route).toBe('settings/provider');
  });

  it('follows hashchange and focuses the heading', async () => {
    const page = await start(fakeChrome());
    window.history.replaceState(null, '', '#settings/usage');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const section = document.querySelector('section[data-route="settings/usage"]');
    expect(visible()).toEqual(['settings/usage']);
    expect(page.route).toBe('settings/usage');
    expect(document.activeElement).toBe(section.querySelector('h1'));
    expect(navLink('settings/usage').getAttribute('aria-current')).toBe('page');
    expect(navLink('home').hasAttribute('aria-current')).toBe(false);

    window.history.replaceState(null, '', '#nope');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#home');
    expect(visible()).toEqual(['home']);
  });

  it('does not move focus on load', async () => {
    window.history.replaceState(null, '', '#modes');
    await start(fakeChrome());
    expect(document.activeElement).toBe(document.body);
  });

  it('every route has a section and a sidebar link', async () => {
    await start(fakeChrome());
    for (const { id, title } of ROUTES) {
      const sections = document.querySelectorAll(`section[data-route="${id}"]`);
      expect(sections, id).toHaveLength(1);
      expect(sections[0].querySelector('h1').textContent.trim()).toBe(title);
      expect(sections[0].querySelector('h1').getAttribute('tabindex')).toBe('-1');
      expect(document.querySelectorAll(`nav a[href="#${id}"]`), id).toHaveLength(1);
      expect(navLink(id).textContent.trim()).toBe(title);
    }
    const order = [...document.querySelectorAll('nav a[href^="#"]')].map((a) => a.getAttribute('href').slice(1));
    expect(order).toEqual(ROUTES.map((r) => r.id));
    const group = document.querySelector('nav [data-group="settings"]');
    expect(group.querySelector('.nav-group-label').textContent.trim()).toBe('Settings');
    expect([...group.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(
      ROUTES.filter((r) => r.id.startsWith('settings/')).map((r) => `#${r.id}`),
    );
  });

  it('later-lane pages show their placeholder', async () => {
    await start(fakeChrome());
    const text = (id) => [...document.querySelectorAll(`section[data-route="${id}"] .placeholder`)].map((p) => p.textContent.trim());
    for (const id of ['settings/appearance']) expect(text(id), id).toEqual([PLACEHOLDER]);
    for (const id of ['home', 'modes', 'dictionary', 'settings/provider', 'settings/recording', 'settings/speech', 'settings/sites', 'settings/sound', 'settings/usage']) expect(text(id), id).toEqual([]);
  });

  it('the footer shows the version and the byline', async () => {
    await start(fakeChrome());
    const footer = document.querySelector('nav footer');
    expect($('version').textContent).toBe('Version 3.0.0-test');
    expect(footer.contains($('version'))).toBe(true);
    expect(footer.textContent).toContain('by K. S. Karakostas');
    const links = [...footer.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/kskarakostas/VoiceType',
      'https://github.com/kskarakostas/VoiceType/blob/main/PRIVACY.md',
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener');
    }
    expect(document.querySelector('.footnote').textContent.trim()).toBe('Changes save automatically.');
    expect($('banner').hidden).toBe(true);
  });

  it('load failure shows the banner and saves nothing', async () => {
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, { error: 'nope' });
    const section = probe();
    const page = await start(chrome, [section.factory]);
    expect(page.loaded).toBe(false);
    expect($('banner').hidden).toBe(false);
    expect($('banner-text').textContent).toBe(LOAD_ERROR);
    expect(await section.ctx.commit((s) => { s.maxRecordingTime = 300; })).toBe(false);
    expect(chrome.saves()).toEqual([]);
    expect(page.settings.maxRecordingTime).toBe(freshSettings().maxRecordingTime);
    expect($('toast').textContent).toBe(NOT_LOADED);
    expect($('toast').dataset.tone).toBe('error');
  });

  it('an external change re-reads settings', async () => {
    const chrome = fakeChrome();
    const section = probe();
    const page = await start(chrome, [section.factory]);
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(1);
    chrome.fire(SETTINGS_CHANGE, 'sync');
    await flush();
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(1);

    chrome.script(MSG.GET_SETTINGS, { ...storedSettings(), activeMode: 'email' });
    const renders = section.renders;
    chrome.fire(SETTINGS_CHANGE, 'local');
    await flush();
    expect(chrome.count(MSG.GET_SETTINGS)).toBe(2);
    expect(page.settings.activeMode).toBe('email');
    expect(section.renders).toBe(renders + 1);
  });
});

describe('settings page context', () => {
  it('hands each section one context with the page helpers', async () => {
    const a = probe();
    const b = probe();
    await start(fakeChrome(), [a.factory, b.factory]);
    expect(a.ctx).toBe(b.ctx);
    expect(a.ctx.$('version')).toBe($('version'));
    expect(a.ctx.document).toBe(document);
    expect(a.ctx.window).toBe(window);
    expect(typeof a.ctx.mac).toBe('boolean');
    expect(a.ctx.loaded()).toBe(true);
    expect(a.ctx.settings().keys.openai).toBe('sk-proj-abcdefgh1234');
    expect(a.renders).toBeGreaterThan(0);
    expect(b.renders).toBe(a.renders);
  });

  it('commit sends only the changed fields and skips an empty patch', async () => {
    const chrome = fakeChrome();
    const section = probe();
    const page = await start(chrome, [section.factory]);
    expect(await section.ctx.commit((s) => { s.maxRecordingTime = 300; s.keys.gemini = 'AIza-new'; }, 'Saved')).toBe(true);
    expect(chrome.saves()).toEqual([{ maxRecordingTime: 300, keys: { gemini: 'AIza-new' } }]);
    expect(page.settings.maxRecordingTime).toBe(300);
    expect($('toast').textContent).toBe('Saved');
    expect($('toast').dataset.tone).toBe('success');

    expect(await section.ctx.commit((s) => { s.maxRecordingTime = 300; })).toBe(true);
    expect(chrome.saves()).toHaveLength(1);
  });

  it('typingSave waits 400 ms after the last schedule', async () => {
    vi.useFakeTimers();
    const section = probe();
    await start(fakeChrome(), [section.factory]);
    const save = vi.fn(() => 'saved');
    const typing = section.ctx.typingSave(save);
    typing.schedule();
    await vi.advanceTimersByTimeAsync(300);
    typing.schedule();
    await vi.advanceTimersByTimeAsync(399);
    expect(save).not.toHaveBeenCalled();
    expect(typing.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(typing.pending).toBe(false);
    expect(typing.flush()).toBeUndefined();
    typing.schedule();
    expect(typing.flush()).toBe('saved');
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('pagehide and a hidden page flush every pending typing save', async () => {
    vi.useFakeTimers();
    const section = probe();
    await start(fakeChrome(), [section.factory]);
    const save = vi.fn();
    section.typingSaves.push(section.ctx.typingSave(save));
    section.typingSaves[0].schedule();
    window.dispatchEvent(new Event('pagehide'));
    expect(save).toHaveBeenCalledTimes(1);

    section.typingSaves[0].schedule();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      delete document.visibilityState;
    }
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
