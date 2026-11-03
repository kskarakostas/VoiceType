// VoiceType settings page, opened in a tab. A trusted extension page: it reads the full settings
// (keys included), saves only the top-level fields an edit changed, and re-reads when stored
// settings change, so a tab left open never writes its stale copy over newer data.
import { createSettingsClient } from '../ui/settings-client.js';
import { createSettingsState } from '../ui/settings-state.js';
import { DEFAULT_ROUTE, parseRoute } from './routes.js';
import { createProviderSection } from './sections/provider.js';
import { createRecordingSection } from './sections/recording.js';
import { createSpeechSection } from './sections/speech.js';
import { createModesSection } from './sections/modes.js';
import { createDictionarySection } from './sections/dictionary.js';
import { createUsageSection } from './sections/usage.js';
import { createHomeSection } from './sections/home.js';

/** @typedef {import('../shared/defaults.js').Settings} Settings */
/**
 * @typedef {{ readonly pending: boolean, schedule(): void, cancel(): void, flush(): unknown }} TypingSave
 * @typedef {{ render(): void, typingSaves?: TypingSave[], beforeReset?(): void }} Section
 * @typedef {{
 *   document: Document, window: Window, chrome: typeof chrome, mac: boolean,
 *   $: (id: string) => HTMLElement,
 *   settings: () => Settings, loaded: () => boolean,
 *   commit: (mutate: (draft: Settings) => void, successText?: string) => Promise<boolean>,
 *   send: (message: object) => Promise<any|null>,
 *   toast: (text: string, tone?: 'info'|'success'|'error') => void,
 *   typingSave: (save: () => unknown) => TypingSave,
 *   beforeReset: () => void,
 *   setTimer: (fn: () => void, ms: number) => number, clearTimer: (id: number) => void,
 *   onUsageChange: (listener: () => void) => () => void,
 * }} PageContext
 */

// Typing pauses this long before a text field saves; blur, change and the page being hidden or
// closed save at once.
const TYPING_SAVE_MS = 400;
const LOAD_ERROR = 'Could not load settings. Reload this page.';

/**
 * Section factories, each given the one PageContext. A section reads `ctx.settings()` and never
 * mutates it; every change goes through `ctx.commit`. Its `render` must not write a focused field.
 * @type {ReadonlyArray<(ctx: PageContext) => Section>}
 */
const SECTIONS = Object.freeze([
  createHomeSection, createProviderSection, createRecordingSection, createSpeechSection, createModesSection,
  createDictionarySection, createUsageSection,
]);

/**
 * Wire the page, route it from the hash, load settings and mount every section.
 * @param {{ chrome: typeof globalThis.chrome, document: Document, window: Window,
 *   sections?: ReadonlyArray<(ctx: PageContext) => Section> }} env `sections` defaults to SECTIONS
 * @returns {Promise<{ readonly settings: Settings, readonly loaded: boolean, readonly route: string }>}
 */
export async function initOptions({ chrome, document, window, sections = SECTIONS }) {
  const $ = (id) => document.getElementById(id);
  const setTimer = (fn, ms) => window.setTimeout(fn, ms);
  const clearTimer = (id) => window.clearTimeout(id);
  const nav = window.navigator;
  const mac = /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
  const client = createSettingsClient({ chrome });

  const el = {
    banner: $('banner'), bannerText: $('banner-text'), toast: $('toast'), version: $('version'),
    routes: [...document.querySelectorAll('section[data-route]')],
    links: [...document.querySelectorAll('nav a[href^="#"]')],
  };

  let route = DEFAULT_ROUTE;
  let toastTimer;

  function toast(text, tone = 'info') {
    el.toast.textContent = text;
    el.toast.dataset.tone = tone;
    el.toast.hidden = false;
    clearTimer(toastTimer);
    toastTimer = setTimer(() => { el.toast.hidden = true; }, tone === 'error' ? 6000 : 2500);
  }

  /**
   * A save that waits for a pause in typing. `flush` runs it at once, but only while it waits,
   * and returns the save's promise.
   * @param {() => unknown} save
   * @returns {TypingSave}
   */
  function typingSave(save) {
    let timer = null;
    const cancel = () => {
      clearTimer(timer);
      timer = null;
    };
    return {
      get pending() {
        return timer !== null;
      },
      schedule() {
        cancel();
        timer = setTimer(() => {
          timer = null;
          save();
        }, TYPING_SAVE_MS);
      },
      cancel,
      flush() {
        if (timer === null) return undefined;
        cancel();
        return save();
      },
    };
  }

  function render() {
    for (const section of mounted) section.render();
  }

  /**
   * Call `listener` when the stored usage log changes and when the tab becomes visible again,
   * so usage shown on a tab left open never goes stale.
   * @param {() => void} listener
   * @returns {() => void} unsubscribe
   */
  function onUsageChange(listener) {
    const onChanged = (changes, areaName) => {
      if (areaName === 'local' && Object.hasOwn(changes, 'usageLog')) listener();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') listener();
    };
    chrome.storage.onChanged.addListener(onChanged);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      chrome.storage.onChanged.removeListener(onChanged);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }

  const state = createSettingsState({ client, render, toast });

  /** @type {PageContext} */
  const ctx = {
    document, window, chrome, mac, $,
    settings: state.settings,
    loaded: state.loaded,
    commit: state.commit,
    send: client.send,
    toast,
    typingSave,
    // Reset to defaults calls this before it commits, so sections can close open editors.
    beforeReset: () => { for (const section of mounted) section.beforeReset?.(); },
    setTimer,
    clearTimer,
    onUsageChange,
  };
  const mounted = sections.map((factory) => factory(ctx));

  // Routing. The hash names the page; anything else opens Home and the URL is rewritten to it.

  function showRoute({ focus }) {
    route = parseRoute(window.location.hash);
    if (window.location.hash !== `#${route}`) window.history.replaceState(null, '', `#${route}`);
    for (const section of el.routes) section.hidden = section.dataset.route !== route;
    for (const link of el.links) {
      if (link.getAttribute('href') === `#${route}`) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (focus) el.routes.find((section) => !section.hidden)?.querySelector('h1')?.focus();
  }

  showRoute({ focus: false });
  window.addEventListener('hashchange', () => showRoute({ focus: true }));

  el.version.textContent = `Version ${chrome.runtime.getManifest().version}`;

  // Closing. The flush is a best effort: Chrome may drop messages a closing page sends. The page
  // never blocks closing with beforeunload.

  function flushTypingSaves() {
    return Promise.all(mounted.flatMap((section) => section.typingSaves ?? []).map((save) => save.flush()));
  }

  window.addEventListener('pagehide', flushTypingSaves);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushTypingSaves();
  });

  // Load.

  if (!(await state.start())) {
    el.bannerText.textContent = LOAD_ERROR;
    el.banner.hidden = false;
  }

  return {
    get settings() { return state.settings(); },
    get loaded() { return state.loaded(); },
    get route() { return route; },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initOptions({ chrome: globalThis.chrome, document, window });
  });
}
