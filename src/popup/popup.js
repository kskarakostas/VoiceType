// VoiceType popup: a quick panel over the settings page. A trusted extension page: it reads the
// full settings, saves only the field an edit changed (provider or activeMode) or the current
// site's rule, and re-reads when stored settings change. Everything else lives on the settings
// page, which it opens (V6). Copy last copies the newest dictation (V29), and the arrow beside it
// lists the newest few (V76).
import { formatCount } from '../options/home-stats.js';
import { MSG } from '../shared/messages.js';
import { formatCost } from '../shared/pricing.js';
import { fillModeSelect } from '../ui/form.js';
import { createSettingsClient } from '../ui/settings-client.js';
import { createSettingsState } from '../ui/settings-state.js';
import { formatSpoken } from './format.js';
import { openSettings } from './open-settings.js';
import { createRecent } from './recent.js';
import { createSiteBlock } from './site-block.js';

/** @typedef {import('../shared/defaults.js').Settings} Settings */

const LOAD_ERROR = 'Could not load settings. Close and reopen the popup.';
const OPEN_ERROR = 'Could not open settings.';
const COPY_ERROR = 'Could not copy.';

/**
 * Wire the quick panel, load settings and today's usage, and save the provider, the active mode
 * and the current site's rule.
 * @param {{ chrome: typeof globalThis.chrome, document: Document, window: Window }} env
 * @returns {Promise<{ readonly settings: Settings, readonly loaded: boolean }>}
 */
export async function initPopup({ chrome, document, window }) {
  const $ = (id) => document.getElementById(id);
  const client = createSettingsClient({ chrome });

  const el = {
    ready: $('status-ready'), addKey: $('add-key'), banner: $('banner'), bannerText: $('banner-text'),
    provider: $('provider'), mode: $('active-mode'),
    todaySessions: $('today-sessions'), todayWords: $('today-words'), todaySpoken: $('today-spoken'), todayCost: $('today-cost'),
    copyRow: $('copy-row'), copyLast: $('copy-last'), openSettings: $('open-settings'), toast: $('toast'),
  };

  let toastTimer;
  /** @type {Array<{ text: string }>} */
  let entries = [];
  let lastLoads = 0;

  function toast(text, tone = 'info') {
    el.toast.textContent = text;
    el.toast.dataset.tone = tone;
    el.toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, tone === 'error' ? 6000 : 2500);
  }

  const copy = (text) => window.navigator.clipboard.writeText(text);
  const recent = createRecent({ document, toast, copy });
  const state = createSettingsState({ client, render, toast });
  const { commit } = state;
  const block = createSiteBlock({ chrome, document, state, client, toast });

  function render() {
    const settings = state.settings();
    // Without loaded settings neither status is known; the banner explains.
    const ready = Boolean(settings.keys[settings.provider]?.trim());
    el.ready.hidden = !state.loaded() || !ready;
    el.addKey.hidden = !state.loaded() || ready;
    el.provider.value = settings.provider;
    fillModeSelect(el.mode, settings.modes);
    el.mode.value = settings.activeMode;
    block.render();
    renderCopyLast();
  }

  // Off drops the text as well: the worker has cleared it, so it must not come back when on returns.
  function renderCopyLast() {
    const { keepHistory } = state.settings();
    if (!keepHistory) entries = [];
    el.copyRow.hidden = !keepHistory;
    el.copyLast.disabled = entries.length === 0;
    recent.render(entries, keepHistory);
  }

  el.provider.addEventListener('change', () => {
    const key = el.provider.value;
    commit((s) => { s.provider = key; });
  });

  el.mode.addEventListener('change', () => {
    const key = el.mode.value;
    commit((s) => { s.activeMode = key; }, `Mode: ${state.settings().modes[key]?.name ?? key}`);
  });

  // The popup closes once the settings tab is open, and stays open to show a failure.
  async function openRoute(route) {
    try {
      await openSettings(chrome, route);
    } catch {
      toast(OPEN_ERROR, 'error');
      return;
    }
    window.close();
  }

  el.addKey.addEventListener('click', () => openRoute('settings/provider'));
  el.openSettings.addEventListener('click', () => openRoute(null));

  el.copyLast.addEventListener('click', async () => {
    try {
      await copy(entries[0].text);
      toast('Copied to clipboard.', 'success');
    } catch {
      toast(COPY_ERROR, 'error');
    }
  });

  async function loadUsage() {
    const stats = await client.send({ action: MSG.GET_USAGE });
    const today = stats?.today;
    if (!today || typeof today !== 'object') return;
    el.todaySessions.textContent = String(today.sessions || 0);
    el.todayWords.textContent = formatCount(today.words || 0);
    el.todaySpoken.textContent = formatSpoken(today.audioSeconds || 0);
    el.todayCost.textContent = formatCost(today.estimatedCost || 0);
  }

  // Only the newest load paints: a slow reply must not bring back text a clear removed.
  async function loadLast() {
    const id = ++lastLoads;
    const reply = await client.send({ action: MSG.GET_HISTORY });
    if (id !== lastLoads) return;
    entries = Array.isArray(reply?.entries) ? reply.entries : [];
    renderCopyLast();
  }

  // Load.

  if (!(await state.start())) {
    el.bannerText.textContent = LOAD_ERROR;
    el.banner.hidden = false;
  }
  await block.start();
  await loadUsage();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && Object.hasOwn(changes, 'history')) loadLast();
  });
  await loadLast();

  return {
    get settings() { return state.settings(); },
    get loaded() { return state.loaded(); },
  };
}

if (globalThis.chrome?.runtime) {
  document.addEventListener('DOMContentLoaded', () => {
    initPopup({ chrome: globalThis.chrome, document, window });
  });
}
