// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initOptions } from '../../../src/options/options.js';
import { ROUTES } from '../../../src/options/routes.js';
import { MSG, SAVE_PORT } from '../../../src/shared/messages.js';
import { freshSettings } from '../../../src/shared/defaults.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/options/options.html'), 'utf8');
const LOAD_ERROR = 'Could not load settings. Reload this page.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';

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
// A press on a sidebar link with its default action stopped: jsdom compares the link with the URL
// the page was opened at and fires a hashchange a task later, into whichever test runs then.
const press = (id) => {
  const link = navLink(id);
  link.addEventListener('click', (event) => event.preventDefault(), { once: true });
  link.click();
};
const sections = () => [...document.querySelectorAll('section[data-route]')];
// jsdom has no scrollIntoView; a test that watches the scroll puts one on the prototype.
const stubScroll = (impl = () => {}) => {
  const fn = vi.fn(impl);
  Element.prototype.scrollIntoView = fn;
  return fn;
};
const PARTS = ROUTES.filter((r) => r.id.startsWith('settings/'));

/** The page opened at `hash`; `go` plays a change of the hash to it. */
async function open(hash, chrome = fakeChrome(), sectionFactories) {
  window.history.replaceState(null, '', hash);
  const page = await start(chrome, sectionFactories);
  const go = async (next) => {
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
  };
  return { page, go, document, sections };
}

// The page adds its listeners to the window and the document, which outlive a test: a hashchange
// would reach every page this file opened before.
const listening = [];

beforeEach(() => {
  for (const target of [window, document]) {
    const add = target.addEventListener;
    vi.spyOn(target, 'addEventListener').mockImplementation(function listen(type, listener, options) {
      listening.push([target, type, listener, options]);
      return add.call(this, type, listener, options);
    });
  }
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  for (const [target, type, listener, options] of listening.splice(0)) target.removeEventListener(type, listener, options);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete Element.prototype.scrollIntoView;
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
    expect(visible()).toEqual(['settings']);
    expect(page.route).toBe('settings/provider');
    expect(navLink('settings/provider').getAttribute('aria-current')).toBe('page');
  });

  it('follows hashchange and focuses the heading', async () => {
    const page = await start(fakeChrome());
    window.history.replaceState(null, '', '#settings/usage');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(visible()).toEqual(['settings']);
    expect(page.route).toBe('settings/usage');
    expect(document.activeElement).toBe($('h-settings-usage'));
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

  it('every route has a section or a part, and a sidebar link', async () => {
    await start(fakeChrome());
    for (const { id, title } of ROUTES) {
      const isPart = id.startsWith('settings/');
      const sections = document.querySelectorAll(isPart ? `section[data-part="${id}"]` : `section[data-route="${id}"]`);
      expect(sections, id).toHaveLength(1);
      const heading = sections[0].querySelector(isPart ? 'h2' : 'h1');
      expect(heading.textContent.trim()).toBe(title);
      expect(heading.getAttribute('tabindex')).toBe('-1');
      expect(sections[0].getAttribute('aria-labelledby'), id).toBe(heading.id);
      expect(document.querySelectorAll(`nav a[href="#${id}"]`), id).toHaveLength(1);
      expect(navLink(id).textContent.trim()).toBe(title);
    }
    const order = [...document.querySelectorAll('nav .nav-list a[href^="#"]')].map((a) => a.getAttribute('href').slice(1));
    expect(order).toEqual(ROUTES.map((r) => r.id));
    const group = document.querySelector('nav [data-group="settings"]');
    expect(group.querySelector('.nav-group-label').textContent.trim()).toBe('Settings');
    expect([...group.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(PARTS.map((r) => `#${r.id}`));
  });

  it('Settings is one page with its parts in sidebar order, each heading keeping its id', async () => {
    await start(fakeChrome());
    const page = document.querySelectorAll('section[data-route="settings"]');
    expect(page).toHaveLength(1);
    expect(page[0].getAttribute('aria-labelledby')).toBe('h-settings');
    const h1 = page[0].querySelector(':scope > h1');
    expect([h1.id, h1.textContent.trim(), h1.getAttribute('tabindex')]).toEqual(['h-settings', 'Settings', '-1']);
    expect(page[0].querySelectorAll('h1')).toHaveLength(1);
    const parts = [...page[0].querySelectorAll(':scope > .settings-part')];
    expect(parts.map((p) => p.dataset.part)).toEqual(PARTS.map((r) => r.id));
    expect(parts.map((p) => p.querySelector(':scope > h2').id)).toEqual([
      'h-provider', 'h-settings-recording', 'h-settings-speech', 'h-settings-sites',
      'h-settings-appearance', 'h-settings-sound', 'h-settings-usage',
    ]);
    // Nothing else in the page is a route of its own.
    expect(page[0].querySelectorAll('[data-route]')).toHaveLength(0);
  });

  it('a radiogroup and a hint still name the heading they were labelled by', async () => {
    await start(fakeChrome());
    for (const id of ['h-provider', 'h-settings-appearance']) {
      const group = document.querySelector(`[role="radiogroup"][aria-labelledby="${id}"]`);
      expect(group, id).not.toBeNull();
      expect(group.closest('.settings-part').querySelector(':scope > h2').id).toBe(id);
    }
    for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby]')) {
      for (const id of `${el.getAttribute('aria-labelledby') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean)) {
        expect(document.querySelectorAll(`#${id}`), `${el.tagName}#${el.id} -> ${id}`).toHaveLength(1);
      }
    }
  });

  it('History sits after Dictionary, in the routes and the markup', async () => {
    await start(fakeChrome());
    const ids = ROUTES.map((r) => r.id);
    expect(ids.indexOf('history')).toBe(ids.indexOf('dictionary') + 1);
    const sections = [...document.querySelectorAll('section[data-route]')].map((s) => s.dataset.route);
    expect(sections.indexOf('history')).toBe(sections.indexOf('dictionary') + 1);
    expect(navLink('dictionary').closest('li').nextElementSibling.querySelector('a')).toBe(navLink('history'));
    expect(navLink('history').closest('[data-group]')).toBeNull();
  });

  it('Welcome opens from the sidebar footer, outside the sidebar lists', async () => {
    window.history.replaceState(null, '', '#welcome');
    const page = await start(fakeChrome());
    const link = navLink('welcome');
    expect(page.route).toBe('welcome');
    expect(visible()).toEqual(['welcome']);
    expect(document.querySelector('section[data-route="welcome"] h1').textContent.trim()).toBe('Welcome');
    expect(link.closest('.sidebar-footer .links')).not.toBeNull();
    expect(link.closest('.nav-list')).toBeNull();
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('nav [aria-current]')).toHaveLength(1);
  });

  it('every settings hash shows the one Settings page', async () => {
    for (const { id } of PARTS) {
      document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
      const { page } = await open(`#${id}`);
      expect(sections().filter((s) => !s.hidden).map((s) => s.dataset.route), id).toEqual(['settings']);
      expect(page.route).toBe(id);
    }
  });

  it('a hash change focuses that part, and marks its link', async () => {
    const { go } = await open('#home');
    await go('#settings/appearance');
    expect(document.activeElement.id).toBe('h-settings-appearance');
    expect(document.activeElement.tagName).toBe('H2');
    expect(document.querySelector('a[href="#settings/appearance"]').getAttribute('aria-current')).toBe('page');
    expect(document.querySelectorAll('nav [aria-current]')).toHaveLength(1);
  });

  it('a hash change between parts keeps the page and moves the mark and the focus', async () => {
    const { go } = await open('#settings/provider');
    await go('#settings/sound');
    expect(visible()).toEqual(['settings']);
    expect(document.activeElement.id).toBe('h-settings-sound');
    expect(navLink('settings/provider').hasAttribute('aria-current')).toBe(false);
    expect(navLink('settings/sound').getAttribute('aria-current')).toBe('page');
  });

  it('leaving Settings for another page focuses that page heading', async () => {
    const { go } = await open('#settings/sound');
    await go('#modes');
    expect(visible()).toEqual(['modes']);
    expect(document.activeElement.id).toBe('h-modes');
  });

  it('a load on a deep hash moves no focus', async () => {
    await open('#settings/usage');
    expect(document.activeElement).toBe(document.body);
  });

  it('a press on the link of the current hash focuses that part again', async () => {
    await open('#settings/sound');
    press('settings/sound');
    expect(document.activeElement.id).toBe('h-settings-sound');
  });

  it('a press on the link of the current hash scrolls its heading into view', async () => {
    const scroll = stubScroll();
    await open('#settings/sites');
    scroll.mockClear();
    press('settings/sites');
    expect(scroll).toHaveBeenCalledOnce();
    expect(scroll.mock.contexts[0]).toBe($('h-settings-sites'));
    expect(scroll).toHaveBeenCalledWith({ block: 'start' });
  });

  it('a press on a link of another hash is left to the hash change', async () => {
    await open('#settings/sound');
    press('settings/speech');
    expect(document.activeElement).toBe(document.body);
  });

  it('a hash change scrolls the heading of the part into view, and then focuses it', async () => {
    const calls = [];
    stubScroll(function scroll(arg) { calls.push(['scroll', this.id, arg]); });
    const { go } = await open('#home');
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function focused() { calls.push(['focus', this.id]); });
    await go('#settings/recording');
    expect(calls).toEqual([['scroll', 'h-settings-recording', { block: 'start' }], ['focus', 'h-settings-recording']]);
    focus.mockRestore();
  });

  it('a bare #settings scrolls to Provider', async () => {
    const scroll = stubScroll();
    const { go } = await open('#home');
    await go('#settings');
    expect(window.location.hash).toBe('#settings/provider');
    expect(scroll.mock.contexts.map((el) => el.id)).toEqual(['h-provider']);
  });

  it('a load on a deep hash scrolls after the settings first render, with no focus', async () => {
    const section = probe();
    const seen = [];
    stubScroll(function scroll() { seen.push([this.id, section.renders]); });
    await open('#settings/usage', fakeChrome(), [section.factory]);
    expect(seen).toEqual([['h-settings-usage', section.renders]]);
    expect(section.renders).toBeGreaterThan(0);
    expect(document.activeElement).toBe(document.body);
  });

  it('a load on a page that is not a part scrolls nothing', async () => {
    const scroll = stubScroll();
    await open('#modes');
    expect(scroll).not.toHaveBeenCalled();
  });

  it('a failed load still scrolls to the part', async () => {
    const scroll = stubScroll();
    const chrome = fakeChrome();
    chrome.script(MSG.GET_SETTINGS, { error: 'nope' });
    await open('#settings/speech', chrome);
    expect(scroll.mock.contexts.map((el) => el.id)).toEqual(['h-settings-speech']);
  });

  it('a page without scrollIntoView still shows the part and focuses it', async () => {
    const { go } = await open('#home');
    expect(Element.prototype.scrollIntoView).toBeUndefined();
    await go('#settings/speech');
    expect(document.activeElement.id).toBe('h-settings-speech');
  });

  it('no page shows a placeholder', async () => {
    await start(fakeChrome());
    expect(document.querySelector('.placeholder')).toBeNull();
  });

  it('the footer shows the version and the byline', async () => {
    await start(fakeChrome());
    const footer = document.querySelector('nav footer');
    expect($('version').textContent).toBe('Version 3.0.0-test');
    expect(footer.contains($('version'))).toBe(true);
    expect(footer.textContent).toContain('by K. S. Karakostas');
    const links = [...footer.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '#welcome',
      'https://github.com/kskarakostas/VoiceType',
      'https://github.com/kskarakostas/VoiceType/blob/main/PRIVACY.md',
    ]);
    for (const a of links.slice(1)) {
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

  it('a typing save opens the save port, and the save at a close goes over it', async () => {
    const chrome = fakeChrome();
    const port = { postMessage: vi.fn(), onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() } };
    chrome.runtime.connect = vi.fn(() => port);
    const section = probe();
    await start(chrome, [section.factory]);
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    section.typingSaves.push(section.ctx.typingSave(() => section.ctx.commit((s) => { s.keepHistory = false; })));
    section.typingSaves[0].schedule();
    expect(chrome.runtime.connect).toHaveBeenCalledExactlyOnceWith({ name: SAVE_PORT });
    window.dispatchEvent(new Event('pagehide'));
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ id: expect.any(Number), message: { action: MSG.SAVE_SETTINGS, settings: { keepHistory: false } } });
    expect(chrome.saves()).toEqual([]);
  });
});
