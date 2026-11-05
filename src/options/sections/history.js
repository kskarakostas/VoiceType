// History: the keepHistory switch and the recent dictations, each with Copy and, when a mode
// changed it, Copy original, which is Copy instruction on an edit. The worker holds the entries and clears them when the switch goes off
// (V27, V29). Entry text is set with textContent only.
import { MSG } from '../../shared/messages.js';
import { EDIT_MODE, EDIT_MODE_LABEL } from '../../shared/defaults.js';
import { createInlineConfirm } from '../../ui/form.js';
import { sameList } from '../../ui/lists.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */
/** @typedef {import('../../background/history.js').Entry} Entry */

const NO_HOST = 'This device';
const OFF_TEXT = 'History is off.';
const EMPTY_TEXT = 'No dictations yet.';
const LOAD_ERROR = 'Could not load history.';
const COPY_ERROR = 'Could not copy.';

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createHistorySection(ctx) {
  const { $, document } = ctx;
  const el = {
    keep: $('keep-history'), list: $('history-list'), empty: $('history-empty'), clear: $('clear-history'), heading: $('h-history'),
  };
  // Rows are kept per entry and updated in place: a reload under a press never replaces the button.
  const rows = new Map();
  /** @type {Entry[]|null} null when the list could not be read */
  let entries = [];
  let loads = 0;

  async function copy(text, doneText) {
    try {
      await ctx.window.navigator.clipboard.writeText(text);
      ctx.toast(doneText, 'success');
    } catch {
      ctx.toast(COPY_ERROR, 'error');
    }
  }

  function createButton(label, ariaLabel, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = label;
    button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', onClick);
    return button;
  }

  /** @param {Entry} entry */
  function createRow(entry) {
    const time = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const item = document.createElement('li');
    item.className = 'history-entry';
    const meta = document.createElement('p');
    meta.className = 'history-meta';
    const text = document.createElement('p');
    text.className = 'history-text';
    text.textContent = entry.text;
    const actions = document.createElement('div');
    actions.className = 'history-actions';
    actions.append(createButton('Copy', `Copy dictation from ${time}`, () => copy(entry.text, 'Copied to clipboard.')));
    if (entry.raw !== entry.text) {
      const edit = entry.mode === EDIT_MODE;
      const label = edit ? 'Copy instruction' : 'Copy original';
      actions.append(createButton(label, `${label} from ${time}`, () => copy(entry.raw, edit ? 'Instruction copied.' : 'Original text copied.')));
    }
    item.append(meta, text, actions);
    return { item, meta, time };
  }

  /** @param {Entry[]} shown */
  function renderRows(shown) {
    const ids = new Set(shown.map((entry) => entry.id));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
    for (const entry of shown) {
      if (!rows.has(entry.id)) rows.set(entry.id, createRow(entry));
      const row = rows.get(entry.id);
      const mode = entry.mode === EDIT_MODE ? EDIT_MODE_LABEL : ctx.settings().modes[entry.mode]?.name ?? entry.mode;
      row.meta.textContent = [row.time, entry.host ?? NO_HOST, mode].join(' · ');
    }
    const items = shown.map((entry) => rows.get(entry.id).item);
    if (sameList(items, [...el.list.children])) return;
    const focused = el.list.contains(document.activeElement) ? document.activeElement : null;
    el.list.replaceChildren(...items);
    if (focused?.isConnected) focused.focus();
  }

  function render() {
    const { keepHistory } = ctx.settings();
    const shown = keepHistory ? entries ?? [] : [];
    el.keep.checked = keepHistory;
    renderRows(shown);
    el.list.hidden = shown.length === 0;
    el.empty.hidden = shown.length > 0;
    if (!keepHistory) el.empty.textContent = OFF_TEXT;
    else el.empty.textContent = entries ? EMPTY_TEXT : LOAD_ERROR;
    el.clear.disabled = shown.length === 0;
  }

  // Only the newest load paints: a slow reply must not bring back entries a clear removed.
  async function load() {
    const id = ++loads;
    const reply = await ctx.send({ action: MSG.GET_HISTORY });
    if (id !== loads) return;
    entries = Array.isArray(reply?.entries) ? reply.entries : null;
    render();
  }

  el.keep.addEventListener('change', () => ctx.commit((s) => { s.keepHistory = el.keep.checked; }));

  createInlineConfirm(el.clear, {
    prompt: 'Click again to clear history',
    setTimeout: ctx.setTimer,
    clearTimeout: ctx.clearTimer,
    onConfirm: async () => {
      const response = await ctx.send({ action: MSG.CLEAR_HISTORY });
      if (response?.success !== true) {
        ctx.toast('Could not clear history.', 'error');
        return;
      }
      await load();
      // A disabled button drops the focus to the body. Focus the user moved elsewhere stays there.
      const { activeElement } = document;
      if (el.clear.disabled && (activeElement === el.clear || activeElement === document.body)) el.heading.focus();
      ctx.toast('History cleared', 'success');
    },
  });

  ctx.chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'session' && Object.hasOwn(changes, 'history')) load();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
  load();

  return { render };
}
