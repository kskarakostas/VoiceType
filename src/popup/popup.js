// VoiceType popup: a quick panel over the settings page. A trusted extension page: it reads the
// full settings, saves only the field an edit changed (provider or activeMode), and re-reads when
// stored settings change. Everything else lives on the settings page, which it opens (V6).
import { MSG } from '../shared/messages.js';
import { formatCost } from '../shared/pricing.js';
import { freshSettings, orderedModeKeys } from '../shared/defaults.js';
import { createSettingsClient, changedFields } from '../ui/settings-client.js';
import { openSettings } from './open-settings.js';

/** @typedef {import('../shared/defaults.js').Settings} Settings */

const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const SAVE_ERROR = 'Could not save settings.';
const DEFAULT_MODE_ICON = '🎯';

/**
 * Wire the quick panel, load settings and today's usage, and save the provider and active mode.
 * @param {{ chrome: typeof globalThis.chrome, document: Document, window: Window }} env
 * @returns {Promise<{ readonly settings: Settings, readonly loaded: boolean }>}
 */
export async function initPopup({ chrome, document, window }) {
  const $ = (id) => document.getElementById(id);
  const client = createSettingsClient({ chrome });

  const el = {
    ready: $('status-ready'), addKey: $('add-key'), banner: $('banner'), bannerText: $('banner-text'),
    providerRadios: [...document.querySelectorAll('input[name="provider"]')],
    mode: $('active-mode'), todaySessions: $('today-sessions'), todayCost: $('today-cost'),
    openSettings: $('open-settings'), toast: $('toast'),
  };

  let settings = freshSettings();
  let loaded = false;
  let toastTimer;
  // Saves in flight, saves started so far, and re-reads started so far, as on the settings page:
  // a re-read waits for the saves in flight and is dropped when a save started while it ran.
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
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, tone === 'error' ? 6000 : 2500);
  }

  function render() {
    const ready = Boolean(settings.keys[settings.provider]?.trim());
    el.ready.hidden = !ready;
    el.addKey.hidden = ready;
    for (const radio of el.providerRadios) radio.checked = radio.value === settings.provider;
    renderModes();
  }

  // The options are rebuilt only when the mode list or a label changed.
  function renderModes() {
    const options = orderedModeKeys(settings.modes).map((key) => {
      const mode = settings.modes[key];
      return [key, `${mode.icon || DEFAULT_MODE_ICON} ${mode.name}`];
    });
    const current = [...el.mode.options];
    const same = current.length === options.length
      && options.every(([key, text], i) => current[i].value === key && current[i].textContent === text);
    if (!same) {
      el.mode.replaceChildren(...options.map(([key, text]) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = text;
        return option;
      }));
    }
    el.mode.value = settings.activeMode;
  }

  /**
   * Apply a change to a copy of the settings, save only the fields it changed, and put those
   * fields back when the save fails. The popup saves only top-level scalar fields.
   * @param {(draft: Settings) => void} mutate
   * @param {string} [successText]
   */
  async function commit(mutate, successText) {
    const snapshot = structuredClone(settings);
    const draft = structuredClone(settings);
    mutate(draft);
    const patch = changedFields(snapshot, draft);
    if (Object.keys(patch).length === 0) return;
    if (!loaded) {
      // Never save from fallback settings: that would write blank keys over the real ones.
      render();
      toast(NOT_LOADED, 'error');
      return;
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
      const restored = Object.fromEntries(Object.keys(patch).map((field) => [field, snapshot[field]]));
      settings = { ...settings, ...restored };
      render();
      toast(result.error || SAVE_ERROR, 'error');
    }
    if (inFlight === 0 && rereadPending) {
      rereadPending = false;
      reread();
    }
  }

  // Also runs after the popup's own saves; rendering the same settings again changes nothing.
  async function reread() {
    if (inFlight > 0) {
      rereadPending = true;
      return;
    }
    const read = ++readCount;
    const savesBefore = saveCount;
    const fresh = await client.load();
    if (read !== readCount) return;
    if (saveCount !== savesBefore) {
      reread();
      return;
    }
    if (!fresh) return;
    settings = fresh;
    render();
  }

  for (const radio of el.providerRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) commit((s) => { s.provider = radio.value; });
    });
  }

  el.mode.addEventListener('change', () => {
    const key = el.mode.value;
    commit((s) => { s.activeMode = key; }, `Mode: ${settings.modes[key]?.name ?? key}`);
  });

  async function openRoute(route) {
    await openSettings(chrome, route);
    window.close();
  }

  el.addKey.addEventListener('click', () => openRoute('settings/provider'));
  el.openSettings.addEventListener('click', () => openRoute(null));

  async function loadUsage() {
    const stats = await client.send({ action: MSG.GET_USAGE });
    const today = stats?.today;
    if (!today || typeof today !== 'object') return;
    el.todaySessions.textContent = String(today.sessions || 0);
    el.todayCost.textContent = formatCost(today.estimatedCost || 0);
  }

  // Load. Subscribe first, so a change while the first read runs is read again after it.

  client.onExternalChange(() => {
    if (loading) changedWhileLoading = true;
    else if (loaded) reread();
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
  if (loaded && changedWhileLoading) reread();
  await loadUsage();

  return {
    get settings() { return settings; },
    get loaded() { return loaded; },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup({ chrome: globalThis.chrome, document, window });
  });
}
