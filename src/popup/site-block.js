// The popup's "This site" block: the active tab's host and its rule. Rules change only through
// SET_SITE_RULE, never through a settings save, so an old copy cannot overwrite newer rules (V18).
import { pageSite, ruleFor } from '../shared/sites.js';
import { fillModeSelect } from '../ui/form.js';

const SAVE_ERROR = 'Could not save settings.';

/**
 * @param {{
 *   chrome: typeof globalThis.chrome,
 *   document: Document,
 *   state: ReturnType<typeof import('../ui/settings-state.js').createSettingsState>,
 *   client: ReturnType<typeof import('../ui/settings-client.js').createSettingsClient>,
 *   toast: (text: string, tone?: 'info'|'success'|'error') => void,
 * }} env
 * @returns {{ start: () => Promise<void>, render: () => void }}
 */
export function createSiteBlock({ chrome, document, state, client, toast }) {
  const $ = (id) => document.getElementById(id);
  const el = {
    unavailable: $('site-unavailable'), controls: $('site-controls'), host: $('site-host'),
    hide: $('site-hide'), mode: $('site-mode'),
  };

  // Until the tab is known the block shows neither the controls nor the unavailable line.
  let started = false;
  let site = null;
  let url;

  /** @param {boolean} [restore] write the focused control too, to undo the edit it just made */
  function paint(restore = false) {
    if (!started) return;
    el.unavailable.hidden = site !== null;
    el.controls.hidden = site === null || !state.loaded();
    if (el.controls.hidden) return;
    const settings = state.settings();
    const rule = ruleFor(settings, url);
    el.host.textContent = site;
    const focused = document.activeElement;
    if (restore || focused !== el.hide) el.hide.checked = rule.hidePill;
    if (restore || focused !== el.mode) {
      fillModeSelect(el.mode, settings.modes, { useActive: true });
      el.mode.value = rule.mode ?? '';
    }
  }

  // Both values come from the controls: a re-read may not have arrived since the last edit.
  async function saveRule() {
    if (site === null || !state.loaded()) return;
    const result = await client.saveSiteRule({ host: site, hidePill: el.hide.checked, mode: el.mode.value || null });
    if (result.success) return;
    paint(true);
    toast(result.error || SAVE_ERROR, 'error');
  }

  el.hide.addEventListener('change', saveRule);
  el.mode.addEventListener('change', saveRule);

  /** Find the active tab's site and render once. A tab that cannot be read has no site. */
  async function start() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tab?.url;
      site = pageSite(url);
    } catch {
      site = null;
    }
    started = true;
    paint();
  }

  return { start, render: () => paint() };
}
