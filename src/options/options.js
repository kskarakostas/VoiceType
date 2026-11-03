// VoiceType settings page, opened in a tab. A trusted extension page: it reads the full settings
// (keys included), saves only the top-level fields an edit changed, and re-reads when stored
// settings change, so a tab left open never writes its stale copy over newer data.
import { freshSettings } from '../shared/defaults.js';
import { createSettingsClient, changedFields } from '../ui/settings-client.js';
import { DEFAULT_ROUTE, parseRoute } from './routes.js';
import { createProviderSection } from './sections/provider.js';
import { createRecordingSection } from './sections/recording.js';
import { createSpeechSection } from './sections/speech.js';
import { createModesSection } from './sections/modes.js';
import { createUsageSection } from './sections/usage.js';

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
 * }} PageContext
 */

// Typing pauses this long before a text field saves; blur, change and the page being hidden or
// closed save at once.
const TYPING_SAVE_MS = 400;
const LOAD_ERROR = 'Could not load settings. Reload this page.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const SAVE_ERROR = 'Could not save settings.';

/**
 * Section factories, each given the one PageContext. A section reads `ctx.settings()` and never
 * mutates it; every change goes through `ctx.commit`. Its `render` must not write a focused field.
 * @type {ReadonlyArray<(ctx: PageContext) => Section>}
 */
const SECTIONS = Object.freeze([
  createProviderSection, createRecordingSection, createSpeechSection, createModesSection, createUsageSection,
]);

/**
 * `current` with the fields of `patch` put back to their `snapshot` values; for `keys` only the
 * providers in the patch. Fields other saves changed in the meantime are kept.
 * @param {Settings} current
 * @param {Settings} snapshot
 * @param {Partial<Settings>} patch
 * @returns {Settings}
 */
function restoreFields(current, snapshot, patch) {
  const next = { ...current };
  for (const field of Object.keys(patch)) {
    if (field === 'keys') {
      const keys = { ...next.keys };
      for (const id of Object.keys(patch.keys)) {
        if (Object.hasOwn(snapshot.keys, id)) keys[id] = snapshot.keys[id];
        else delete keys[id];
      }
      next.keys = keys;
    } else if (Object.hasOwn(snapshot, field)) {
      next[field] = snapshot[field];
    } else {
      delete next[field];
    }
  }
  return next;
}

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

  let settings = freshSettings();
  let loaded = false;
  let route = DEFAULT_ROUTE;
  let toastTimer;
  // Saves in flight, saves started so far, and re-reads started so far. A re-read waits for the
  // saves in flight and is dropped when a save started while it ran: its copy may predate it.
  let inFlight = 0;
  let saveCount = 0;
  let readCount = 0;
  let rereadPending = false;
  let loading = true;
  let changedWhileLoading = false;

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
   * Apply a change to a copy of the settings, save only the fields it changed, and put those
   * fields back when the save fails.
   * @param {(draft: Settings) => void} mutate
   * @param {string} [successText]
   * @returns {Promise<boolean>}
   */
  async function commit(mutate, successText) {
    const snapshot = structuredClone(settings);
    const draft = structuredClone(settings);
    mutate(draft);
    const patch = changedFields(snapshot, draft);
    if (Object.keys(patch).length === 0) return true;
    if (!loaded) {
      // Never save from fallback settings: that would write blank keys over the real ones.
      render();
      toast(NOT_LOADED, 'error');
      return false;
    }
    settings = draft;
    render();
    inFlight += 1;
    saveCount += 1;
    const result = await client.save(patch);
    inFlight -= 1;
    if (result.success) {
      if (successText) toast(successText, 'success');
    } else {
      settings = restoreFields(settings, snapshot, patch);
      render();
      toast(result.error || SAVE_ERROR, 'error');
    }
    if (inFlight === 0 && rereadPending) {
      rereadPending = false;
      reread();
    }
    return result.success;
  }

  function requestReread() {
    if (inFlight > 0) rereadPending = true;
    else reread();
  }

  // Also runs after this page's own saves; rendering the same settings again changes nothing.
  async function reread() {
    const read = ++readCount;
    const savesBefore = saveCount;
    const fresh = await client.load();
    if (read !== readCount) return;
    if (saveCount !== savesBefore) {
      requestReread();
      return;
    }
    if (!fresh) return;
    settings = fresh;
    render();
  }

  /** @type {PageContext} */
  const ctx = {
    document, window, chrome, mac, $,
    settings: () => settings,
    loaded: () => loaded,
    commit,
    send: client.send,
    toast,
    typingSave,
    // Reset to defaults calls this before it commits, so sections can close open editors.
    beforeReset: () => { for (const section of mounted) section.beforeReset?.(); },
    setTimer,
    clearTimer,
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

  // Load. Subscribe first, so a change while the first read runs is read again after it.

  client.onExternalChange(() => {
    if (loading) changedWhileLoading = true;
    else if (loaded) requestReread();
  });
  const stored = await client.load();
  loading = false;
  loaded = stored !== null;
  if (loaded) {
    settings = stored;
  } else {
    el.bannerText.textContent = LOAD_ERROR;
    el.banner.hidden = false;
  }
  render();
  if (loaded && changedWhileLoading) requestReread();

  return {
    get settings() { return settings; },
    get loaded() { return loaded; },
    get route() { return route; },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initOptions({ chrome: globalThis.chrome, document, window });
  });
}
