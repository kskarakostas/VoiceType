// Settings, Usage and data: the usage table with Refresh and Clear history, and Reset to defaults.
// Ported from the 2.2 popup unchanged in behaviour, except that Reset follows V21: it keeps the
// keys, provider, spoken languages, dictionary and site rules, and resets every other field.
import { MSG } from '../../shared/messages.js';
import { PROVIDERS } from '../../shared/models.js';
import { formatCost } from '../../shared/pricing.js';
import { freshSettings } from '../../shared/defaults.js';
import { createInlineConfirm } from '../../ui/form.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const RESET_PROMPT = 'Click again to reset. Custom modes will be deleted.';

/** Seconds as m:ss, or h:mm:ss from one hour up. */
function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createUsageSection(ctx) {
  const { $ } = ctx;
  const providerIds = Object.keys(PROVIDERS);
  const el = { refreshUsage: $('refresh-usage'), clearUsage: $('clear-usage'), reset: $('reset') };

  function fillUsage(prefix, bucket, costField) {
    $(`usage-${prefix}-sessions`).textContent = String(bucket?.sessions || 0);
    $(`usage-${prefix}-audio`).textContent = formatTime(bucket?.audioSeconds || 0);
    $(`usage-${prefix}-cost`).textContent = formatCost(bucket?.[costField] || 0);
  }

  async function loadUsage() {
    const stats = await ctx.send({ action: MSG.GET_USAGE });
    if (!stats?.total || typeof stats.total !== 'object') return false;
    fillUsage('today', stats.today, 'estimatedCost');
    fillUsage('week', stats.last7Days, 'estimatedCost');
    fillUsage('total', stats.total, 'estimatedCost');
    for (const id of providerIds) fillUsage(id, stats.total.byProvider?.[id], 'cost');
    return true;
  }

  el.refreshUsage.addEventListener('click', async () => {
    if (!(await loadUsage())) ctx.toast('Could not load usage.', 'error');
  });

  createInlineConfirm(el.clearUsage, {
    prompt: 'Click again to clear usage history',
    setTimeout: ctx.setTimer,
    clearTimeout: ctx.clearTimer,
    onConfirm: async () => {
      const response = await ctx.send({ action: MSG.CLEAR_USAGE });
      if (response?.success !== true) {
        ctx.toast('Could not clear usage history.', 'error');
        return;
      }
      await loadUsage();
      ctx.toast('Usage history cleared', 'success');
    },
  });

  // The patch carries only the fields that differ from the defaults. Custom modes go with
  // `modes`; on save the service worker drops a deleted mode from the site rules that used it,
  // and a rule left with neither a mode nor a hidden pill.
  createInlineConfirm(el.reset, {
    prompt: RESET_PROMPT,
    setTimeout: ctx.setTimer,
    clearTimeout: ctx.clearTimer,
    onConfirm: () => {
      ctx.beforeReset();
      return ctx.commit((s) => {
        const kept = {
          keys: { ...s.keys }, provider: s.provider, languages: [...s.languages],
          dictionary: structuredClone(s.dictionary), siteRules: structuredClone(s.siteRules),
        };
        Object.assign(s, freshSettings(), kept);
      }, 'Settings reset');
    },
  });

  loadUsage();

  // The table does not depend on settings; it loads once and on Refresh or Clear history.
  return { render() {} };
}
