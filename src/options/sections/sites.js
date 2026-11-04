// Sites: the table of site rules and the Add site form. Rules change only through SET_SITE_RULE,
// never through a settings save, so an old copy cannot overwrite newer rules (V18). Rows stay in
// place across renders, and only Add or Enter stores what the form holds: its text is a draft.
import { siteKey } from '../../shared/sites.js';
import { fillModeSelect } from '../../ui/form.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */
/** @typedef {{ root: HTMLTableRowElement, hide: HTMLInputElement, mode: HTMLSelectElement, remove: HTMLButtonElement }} Row */

const NOT_LOADED = 'Settings are not loaded. Nothing was saved.';
const SAVE_ERROR = 'Could not save settings.';
const NOT_A_HOST = 'Enter a hostname or a URL, such as example.com.';
const EMPTY_RULE = 'Turn on Hide pill or choose a mode.';

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createSitesSection(ctx) {
  const { $, document } = ctx;
  const el = {
    form: $('site-add'), host: $('site-add-host'), hide: $('site-add-hide'), mode: $('site-add-mode'),
    error: $('site-add-error'), table: $('site-table'), empty: $('site-empty'),
  };
  const body = el.table.tBodies[0];
  /** @type {Map<string, Row>} */
  const rows = new Map();
  let adding = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {string} text empty hides the line */
  function showError(text) {
    el.error.textContent = text;
    el.error.hidden = !text;
  }

  /**
   * @param {string} host
   * @param {Row} row
   * @param {boolean} [restore] write the focused control too, to undo the edit it just made
   */
  function paintRow(host, row, restore = false) {
    const { siteRules, modes } = ctx.settings();
    const { hidePill, mode } = siteRules[host];
    const focused = document.activeElement;
    if (restore || focused !== row.hide) row.hide.checked = hidePill;
    if (restore || focused !== row.mode) {
      fillModeSelect(row.mode, modes, { useActive: true });
      row.mode.value = Object.hasOwn(modes, mode) ? mode : '';
    }
  }

  /**
   * Send only what the edit changed: the other control may be stale, and the worker keeps the stored value.
   * @param {string} host
   * @param {Row} row
   * @param {{ hidePill: boolean }|{ mode: string|null }} edit
   */
  async function saveRow(host, row, edit) {
    if (!ctx.loaded()) {
      paintRow(host, row, true);
      ctx.toast(NOT_LOADED, 'error');
      return;
    }
    const result = await ctx.saveSiteRule({ host, ...edit });
    if (result.success) return;
    if (rows.get(host) === row) paintRow(host, row, true);
    ctx.toast(result.error || SAVE_ERROR, 'error');
  }

  // The row goes when the re-read reaches render, which also moves the focus.
  async function removeRule(host) {
    if (!ctx.loaded()) {
      ctx.toast(NOT_LOADED, 'error');
      return;
    }
    const result = await ctx.saveSiteRule({ host, hidePill: false, mode: null });
    if (result.success) ctx.toast(`Removed ${host}`, 'success');
    else ctx.toast(result.error || SAVE_ERROR, 'error');
  }

  /**
   * @param {string} host
   * @returns {Row}
   */
  function createRow(host) {
    const root = element('tr');
    const site = element('th', '', host);
    site.scope = 'row';

    const hide = element('input');
    hide.type = 'checkbox';
    hide.setAttribute('aria-label', `Hide pill on ${host}`);
    const check = element('label', 'check');
    check.append(hide, element('span', 'site-hide-label', 'Hide pill'));
    const hideCell = element('td');
    hideCell.append(check);

    const mode = element('select');
    mode.setAttribute('aria-label', `Mode on ${host}`);
    const modeCell = element('td');
    modeCell.append(mode);

    const remove = element('button', 'btn btn-danger', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${host}`);
    const removeCell = element('td');
    removeCell.append(remove);

    root.append(site, hideCell, modeCell, removeCell);
    const row = { root, hide, mode, remove };
    hide.addEventListener('change', () => saveRow(host, row, { hidePill: hide.checked }));
    mode.addEventListener('change', () => saveRow(host, row, { mode: mode.value || null }));
    // Focus moves to the next row, so a held key would remove one rule after another.
    remove.addEventListener('keydown', (event) => {
      if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
    });
    // The next row slides in, and the rest of a double click would land on it.
    remove.addEventListener('click', (event) => {
      if (event.detail > 1) return;
      removeRule(host);
    });
    return row;
  }

  function renderRows(hosts) {
    const kept = new Set(hosts);
    let focusedHost = null;
    for (const [host, row] of rows) {
      if (kept.has(host)) continue;
      if (row.root.contains(document.activeElement)) focusedHost = host;
      rows.delete(host);
      row.root.remove();
    }
    // Last to first, so a new row knows the next one. A kept row never moves, which keeps focus.
    let next = null;
    for (const host of hosts.toReversed()) {
      if (!rows.has(host)) {
        rows.set(host, createRow(host));
        body.insertBefore(rows.get(host).root, next);
      }
      paintRow(host, rows.get(host));
      next = rows.get(host).root;
    }
    if (focusedHost === null) return;
    (rows.get(hosts.find((host) => host > focusedHost))?.remove ?? el.host).focus();
  }

  function renderAddMode(modes) {
    if (document.activeElement === el.mode) return;
    const chosen = el.mode.value;
    fillModeSelect(el.mode, modes, { useActive: true });
    el.mode.value = Object.hasOwn(modes, chosen) ? chosen : '';
  }

  function render() {
    const { siteRules, modes } = ctx.settings();
    // Sorted here because a replaced rule moves to the end of the object's key order.
    const hosts = Object.keys(siteRules).toSorted();
    renderRows(hosts);
    renderAddMode(modes);
    el.table.hidden = hosts.length === 0;
    // Fallback settings hold no rules, and that says nothing about the stored ones.
    el.empty.hidden = hosts.length > 0 || !ctx.loaded();
  }

  async function add() {
    if (adding) return;
    showError('');
    if (!ctx.loaded()) {
      ctx.toast(NOT_LOADED, 'error');
      return;
    }
    const text = el.host.value;
    const host = siteKey(text);
    if (host === null) {
      showError(NOT_A_HOST);
      return;
    }
    if (Object.hasOwn(ctx.settings().siteRules, host)) {
      showError(`${host} already has a rule.`);
      return;
    }
    const rule = { hidePill: el.hide.checked, mode: el.mode.value || null };
    if (!rule.hidePill && rule.mode === null) {
      showError(EMPTY_RULE);
      return;
    }
    adding = true;
    const result = await ctx.saveSiteRule({ host, ...rule });
    adding = false;
    if (!result.success) {
      showError(result.error || SAVE_ERROR);
      return;
    }
    ctx.toast(`Added ${host}`, 'success');
    // Text typed while the save ran is the next draft.
    if (el.host.value !== text) return;
    el.host.value = '';
    el.hide.checked = true;
    el.mode.value = '';
    el.host.focus();
  }

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    add();
  });
  el.form.addEventListener('input', () => showError(''));

  return { render };
}
