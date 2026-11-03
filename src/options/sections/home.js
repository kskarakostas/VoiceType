// Home: this week's dictation stats. Loads GET_USAGE on mount and whenever the usage log changes
// or the tab becomes visible, and renders homeView's strings with textContent only.
import { MSG } from '../../shared/messages.js';
import { homeView } from '../home-stats.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */
/** @typedef {import('../home-stats.js').HomeView} HomeView */

const DAY_STATE_TEXT = { dictated: 'dictated', missed: 'not dictated', upcoming: 'still to come' };

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createHomeSection(ctx) {
  const { $, document } = ctx;
  const el = {
    error: $('home-error'), empty: $('home-empty'), stats: $('home-stats'),
    saved: $('home-saved'), savedDetail: $('home-saved-detail'),
    wordsWeek: $('home-words-week'), wordsTotal: $('home-words-total'),
    speed: $('home-speed'), refined: $('home-refined'),
    days: $('home-days'), daysCount: $('home-days-count'),
    costWeek: $('home-cost-week'), costPer1k: $('home-cost-per-1k'),
  };
  /** Requests started so far; a reply to an older one is dropped. */
  let requests = 0;

  /** @param {HomeView} view */
  function show(view) {
    el.error.hidden = view.state !== 'error';
    el.empty.hidden = view.state !== 'empty';
    el.stats.hidden = view.state !== 'noWords' && view.state !== 'full';
    for (const key of ['saved', 'savedDetail', 'wordsWeek', 'wordsTotal', 'speed', 'refined', 'daysCount', 'costWeek', 'costPer1k']) {
      el[key].textContent = view[key];
    }
    el.days.replaceChildren(...view.days.map((day) => {
      const li = document.createElement('li');
      const label = `${day.name}, ${DAY_STATE_TEXT[day.state]}`;
      li.textContent = day.label;
      li.dataset.state = day.state;
      li.title = label;
      li.setAttribute('aria-label', label);
      if (day.today) li.setAttribute('aria-current', 'date');
      return li;
    }));
  }

  async function load() {
    const request = ++requests;
    const reply = await ctx.send({ action: MSG.GET_USAGE });
    if (request === requests) show(homeView(reply));
  }

  load();
  ctx.onUsageChange(load);

  // Home does not depend on settings.
  return { render() {} };
}
