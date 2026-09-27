// The in-page UI: a closed Shadow DOM pill with its status line and menu.
// User data (mode names and icons, statuses) is only ever set with textContent.
import css from './pill.css';
import { computePillPosition, computeMenuPlacement, EDGE } from './position.js';
import { formatChord } from '../shared/chord.js';
import { formatCost } from '../shared/pricing.js';
import { PROVIDERS } from '../shared/models.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {import('../shared/defaults.js').PublicSettings} PublicSettings
 * @typedef {'idle'|'recording'|'processing'|'done'|'error'} PillState
 * @typedef {{ onRec: () => void, onStatusClick: () => void, onMenuOpen: () => void,
 *   onMode: (key: string) => void, onProvider: (id: string) => void, onTargetLang: (lang: string) => void }} PillHandlers
 * @typedef {{ todayCost: number, todaySessions: number, totalCost: number }} PillUsage
 */

/** Size of the expanded pill; `.pill` in pill.css has the same width and height. */
export const PILL_SIZE = Object.freeze({ width: 140, height: 30 });

/** How long a non-sticky status stays, by tone. */
export const STATUS_MS = Object.freeze({ error: 6000, warning: 6000, info: 2500, success: 2500 });

/** Translate targets offered in the menu. */
export const TARGET_LANGUAGES = Object.freeze([
  Object.freeze({ code: 'EN', name: 'English' }),
  Object.freeze({ code: 'EL', name: 'Greek' }),
  Object.freeze({ code: 'ES', name: 'Spanish' }),
  Object.freeze({ code: 'FR', name: 'French' }),
  Object.freeze({ code: 'DE', name: 'German' }),
]);

const HOST_CSS = 'all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647; '
  + 'display: block; width: 0; height: 0; overflow: visible; pointer-events: none;';
const STATES = new Set(['idle', 'recording', 'processing', 'done', 'error']);
/** Placements whose slot is right-aligned (pill.css): the pill grows and the status extends leftwards. */
const GROWS_LEFT = new Set(['left', 'inside', 'corner']);
const MENU_GAP = 6;
const MENU_WIDTH = 248;
const STATUS_GAP = 6;
/** Least room reserved for a status (one line); also its height when it cannot be measured. */
const STATUS_ROOM = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Material Symbols paths on a 24 x 24 grid (Apache License 2.0). */
const ICONS = Object.freeze({
  mic: 'M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z',
  stop: 'M7 7h10v10H7z',
  dots: 'M6 10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  alert: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  globe: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95c-.32-1.25-.78-2.45-1.38-3.56 1.84.63 3.37 1.91 4.33 3.56zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56-1.84-.63-3.37-1.9-4.33-3.56zm2.95-8H5.08c.96-1.66 2.49-2.93 4.33-3.56C8.81 5.55 8.35 6.75 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95c-.96 1.65-2.49 2.93-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
});

/** @param {number} value */
const finite = (value) => (Number.isFinite(value) ? value : 0);

/** @param {number} ms */
function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

/** @param {Window|null} win */
function isMac(win) {
  const nav = win?.navigator;
  return /mac/i.test(nav?.userAgentData?.platform || nav?.platform || '');
}

export class Pill {
  #handlers;
  #doc;
  #shadowMode;
  #els;
  #host = null;
  #root = null;
  #destroyed = false;
  #shown = false;
  #offscreen = false;
  /** @type {(Box & { placement: string })|null} */
  #box = null;
  #gap = 8;
  #state = 'idle';
  #startedAt = 0;
  #timerId = null;
  #statusTimer = null;
  #statusClickable = false;
  #terminal = false;
  #menuOpen = false;
  #menuPlacement = 'below';

  /**
   * @param {PillHandlers} handlers
   * @param {{ doc?: Document, shadowMode?: 'open'|'closed' }} [options] `open` is for tests only.
   */
  constructor(handlers, { doc = document, shadowMode = 'closed' } = {}) {
    this.#handlers = handlers;
    this.#doc = doc;
    this.#shadowMode = shadowMode;
    this.#els = this.#build();
  }

  /** @returns {ShadowRoot|null} test hook; the page cannot reach a closed root from its own world. */
  get root() {
    return this.#root;
  }

  /** @returns {HTMLElement|null} */
  get host() {
    return this.#host;
  }

  /** @returns {boolean} */
  get visible() {
    return this.#shown && !this.#offscreen && !this.#destroyed;
  }

  /** @returns {boolean} */
  get menuOpen() {
    return this.#menuOpen;
  }

  /** Create the host and its shadow root. Idempotent; show() calls it. */
  mount() {
    if (this.#host || this.#destroyed) return;
    const doc = this.#doc;
    const host = doc.createElement('voicetype-host');
    host.style.cssText = HOST_CSS;
    const root = host.attachShadow({ mode: this.#shadowMode });
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (typeof Sheet?.prototype?.replaceSync === 'function') {
      const sheet = new Sheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
    } else {
      const style = doc.createElement('style');
      style.textContent = css;
      root.append(style);
    }
    root.append(this.#els.wrap);
    // Keep focus (and the caret) in the page field whatever is clicked in the pill.
    root.addEventListener('mousedown', (event) => event.preventDefault());
    doc.documentElement.append(host);
    this.#host = host;
    this.#root = root;
  }

  /**
   * @param {Box|null} anchor viewport box of the field, or null for the bottom-right corner
   * @param {{ gap?: number }} [options]
   */
  show(anchor, { gap = 8 } = {}) {
    if (this.#destroyed) return;
    this.mount();
    this.#gap = Number.isFinite(gap) && gap >= 0 ? gap : 8;
    this.#shown = true;
    this.#place(anchor);
  }

  /** @param {Box|null} anchor */
  reposition(anchor) {
    if (this.#destroyed || !this.#shown) return;
    this.#place(anchor);
  }

  hide() {
    if (this.#destroyed) return;
    this.closeMenu();
    this.#shown = false;
    this.#els.wrap.hidden = true;
  }

  /** @param {PillState} state */
  setState(state) {
    if (this.#destroyed || !STATES.has(state)) return;
    const previous = this.#state;
    this.#state = state;
    const { pill, rec, recIcon, recLabel } = this.#els;
    pill.dataset.state = state;
    rec.setAttribute('aria-label', state === 'recording' ? 'Stop recording' : 'Start recording');
    if (state === 'recording') {
      setIcon(recIcon, 'stop');
      if (previous !== 'recording') {
        this.#startedAt = Date.now();
        recLabel.textContent = formatElapsed(0);
        clearInterval(this.#timerId);
        this.#timerId = setInterval(() => {
          recLabel.textContent = formatElapsed(Date.now() - this.#startedAt);
        }, 250);
      }
      return;
    }
    clearInterval(this.#timerId);
    this.#timerId = null;
    this.setLevel(0);
    setIcon(recIcon, state === 'processing' ? 'dots' : 'mic');
    recLabel.textContent = state === 'processing' ? '' : 'REC';
  }

  /** @param {number} level 0 to 1; anything else is clamped */
  setLevel(level) {
    if (this.#destroyed) return;
    const value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.#els.pill.style.setProperty('--vt-level', String(Math.round(value * 1000) / 1000));
  }

  /**
   * @param {string} text
   * @param {{ tone?: 'info'|'success'|'warning'|'error', sticky?: boolean, clickable?: boolean, terminal?: boolean }} [options]
   */
  setStatus(text, { tone = 'info', sticky = false, clickable = false, terminal = false } = {}) {
    if (this.#destroyed || this.#terminal) return;
    const safeTone = Object.hasOwn(STATUS_MS, tone) ? tone : 'info';
    const { status, statusText, statusIcon } = this.#els;
    clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    statusText.textContent = String(text ?? '');
    status.dataset.tone = safeTone;
    setIcon(statusIcon, safeTone === 'success' ? 'check' : 'alert');
    status.removeAttribute('data-empty');
    this.#statusClickable = Boolean(clickable);
    status.toggleAttribute('data-clickable', this.#statusClickable);
    if (terminal) this.#terminal = true;
    else if (!sticky) this.#statusTimer = setTimeout(() => this.#resetStatus(), STATUS_MS[safeTone]);
    this.#placeStatus();
  }

  clearStatus() {
    if (this.#destroyed || this.#terminal) return;
    this.#resetStatus();
  }

  /**
   * @param {PublicSettings} settings
   * @param {PillUsage|null} usage
   */
  renderMenu(settings, usage) {
    if (this.#destroyed || !settings || typeof settings !== 'object') return;
    const modes = settings.modes && typeof settings.modes === 'object' ? settings.modes : {};
    const active = Object.hasOwn(modes, settings.activeMode) ? settings.activeMode : 'default';
    const activeMode = Object.hasOwn(modes, active) && modes[active] && typeof modes[active] === 'object' ? modes[active] : null;
    const { mode, modeIcon, menu } = this.#els;
    const modeName = typeof activeMode?.name === 'string' ? activeMode.name : active;
    modeIcon.textContent = typeof activeMode?.icon === 'string' ? activeMode.icon : '';
    mode.title = modeName;
    mode.setAttribute('aria-label', `Mode: ${modeName}. Open the VoiceType menu`);

    const sections = [this.#modesSection(modes, active)];
    if (activeMode?.hasLanguageOption) sections.push(this.#translateSection(settings.translateTargetLang));
    sections.push(this.#providerSection(settings), this.#footerSection(settings, usage));
    menu.replaceChildren(...sections);
    if (this.#menuOpen) {
      this.#placeMenu();
      this.#placeStatus();
    }
  }

  openMenu() {
    if (this.#destroyed || this.#menuOpen || !this.visible) return;
    this.#menuOpen = true;
    const { pill, menu, mode, more } = this.#els;
    pill.dataset.menu = 'open';
    menu.hidden = false;
    mode.setAttribute('aria-expanded', 'true');
    more.setAttribute('aria-expanded', 'true');
    const win = this.#doc.defaultView;
    win.addEventListener('keydown', this.#onKeyDown, true);
    win.addEventListener('mousedown', this.#onOutsideDown, true);
    this.#placeMenu();
    this.#placeStatus();
    this.#handlers.onMenuOpen();
  }

  closeMenu() {
    if (!this.#menuOpen) return;
    this.#menuOpen = false;
    const { pill, menu, mode, more } = this.#els;
    delete pill.dataset.menu;
    menu.hidden = true;
    mode.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-expanded', 'false');
    const win = this.#doc.defaultView;
    win.removeEventListener('keydown', this.#onKeyDown, true);
    win.removeEventListener('mousedown', this.#onOutsideDown, true);
    this.#placeStatus();
  }

  /** Remove the host and stop every timer and listener. The instance is inert afterwards. */
  destroy() {
    if (this.#destroyed) return;
    this.closeMenu();
    clearInterval(this.#timerId);
    clearTimeout(this.#statusTimer);
    this.#timerId = null;
    this.#statusTimer = null;
    this.#host?.remove();
    this.#shown = false;
    this.#destroyed = true;
  }

  #onKeyDown = (event) => {
    if (event.key !== 'Escape' || !this.#menuOpen) return;
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu();
  };

  #onOutsideDown = (event) => {
    if (!event.composedPath().includes(this.#host)) this.closeMenu();
  };

  #toggleMenu() {
    if (this.#menuOpen) this.closeMenu();
    else this.openMenu();
  }

  #viewport() {
    const win = this.#doc.defaultView;
    const de = this.#doc.documentElement;
    // clientWidth leaves out a page scrollbar; innerWidth is the fallback where layout is unavailable.
    return {
      width: Math.min(win.innerWidth, de.clientWidth || win.innerWidth),
      height: Math.min(win.innerHeight, de.clientHeight || win.innerHeight),
    };
  }

  /** @param {Box|null} anchor */
  #place(anchor) {
    const { wrap, pill } = this.#els;
    const pos = computePillPosition({ anchor, pill: PILL_SIZE, viewport: this.#viewport(), gap: this.#gap });
    if (pos.placement === 'hidden') {
      this.#offscreen = true;
      this.closeMenu();
      wrap.hidden = true;
      return;
    }
    this.#offscreen = false;
    this.#box = { top: pos.top, left: pos.left, width: PILL_SIZE.width, height: PILL_SIZE.height, placement: pos.placement };
    pill.dataset.placement = pos.placement;
    pill.style.top = `${Math.round(pos.top)}px`;
    pill.style.left = `${Math.round(pos.left)}px`;
    wrap.hidden = false;
    if (this.#menuOpen) this.#placeMenu();
    this.#placeStatus();
  }

  #placeMenu() {
    const box = this.#box;
    if (!box) return;
    const { menu } = this.#els;
    // Measure the menu's own height, not the cap from its previous placement.
    menu.style.maxHeight = '';
    const rect = menu.getBoundingClientRect();
    const pos = computeMenuPlacement({
      pill: box,
      menu: { width: rect.width || MENU_WIDTH, height: rect.height },
      viewport: this.#viewport(),
      gap: MENU_GAP,
    });
    this.#menuPlacement = pos.placement;
    menu.dataset.placement = pos.placement;
    menu.style.top = `${Math.round(pos.top)}px`;
    menu.style.left = `${Math.round(pos.left)}px`;
    menu.style.maxHeight = `${Math.floor(pos.maxHeight)}px`;
  }

  /**
   * The status prefers the side opposite an open menu, else above for the above and corner
   * placements and below otherwise. It takes the other side when the preferred one has no
   * room, and is clamped into the viewport when neither has.
   */
  #placeStatus() {
    const box = this.#box;
    if (!box) return;
    const { status } = this.#els;
    const viewport = this.#viewport();
    const { width, height: measured } = status.getBoundingClientRect();
    const height = Math.max(measured, STATUS_ROOM);
    const tops = { below: box.top + box.height + STATUS_GAP, above: box.top - STATUS_GAP - height };
    const fits = (side) => tops[side] >= EDGE && tops[side] + height <= viewport.height - EDGE;
    let preferred;
    if (this.#menuOpen) preferred = this.#menuPlacement === 'below' ? 'above' : 'below';
    else preferred = box.placement === 'above' || box.placement === 'corner' ? 'above' : 'below';
    const other = preferred === 'below' ? 'above' : 'below';
    const side = fits(preferred) || !fits(other) ? preferred : other;
    const top = fits(side) ? tops[side] : Math.max(EDGE, Math.min(tops[side], viewport.height - height - EDGE));
    status.dataset.side = side;
    const wanted = GROWS_LEFT.has(box.placement) ? box.left + box.width - width : box.left;
    const left = Math.max(EDGE, Math.min(wanted, viewport.width - width - EDGE));
    status.style.left = `${Math.round(left)}px`;
    // "above" is lifted by its own height in CSS (translateY(-100%)), so it is placed by its bottom edge.
    status.style.top = `${Math.round(side === 'above' ? top + height : top)}px`;
  }

  #resetStatus() {
    clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    const { status, statusText } = this.#els;
    statusText.textContent = '';
    status.setAttribute('data-empty', '');
    status.removeAttribute('data-clickable');
    this.#statusClickable = false;
  }

  #build() {
    const el = (tag, className, attrs = {}) => this.#el(tag, className, attrs);
    const wrap = el('div', 'vt');
    wrap.hidden = true;

    const pill = el('div', 'pill');
    pill.dataset.state = 'idle';
    const body = el('div', 'body');
    const dot = el('span', 'dot', { 'aria-hidden': 'true' });
    const bar = el('div', 'bar');
    const mode = el('button', 'mode', { type: 'button', 'aria-label': 'Open the VoiceType menu', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'vt-menu' });
    const modeIcon = el('span', 'mode-icon', { 'aria-hidden': 'true' });
    mode.append(modeIcon);
    const rec = el('button', 'rec', { type: 'button', 'aria-label': 'Start recording' });
    const recIcon = this.#icon('mic');
    const recLabel = el('span', 'rec-label', { 'aria-hidden': 'true' });
    recLabel.textContent = 'REC';
    rec.append(recIcon, recLabel);
    const more = el('button', 'more', { type: 'button', 'aria-label': 'VoiceType menu', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'vt-menu' });
    more.append(this.#icon('dots'));
    bar.append(mode, el('span', 'sep', { 'aria-hidden': 'true' }), rec, el('span', 'sep', { 'aria-hidden': 'true' }), more);
    body.append(dot, bar);
    pill.append(body);

    const status = el('div', 'status', { role: 'status', 'aria-live': 'polite', 'data-empty': '' });
    status.dataset.tone = 'info';
    status.dataset.side = 'below';
    const statusIcon = this.#icon('alert', 'status-icon');
    const statusText = el('span', 'status-text');
    status.append(statusIcon, statusText);

    const menu = el('div', 'menu', { id: 'vt-menu', role: 'group', 'aria-label': 'VoiceType menu' });
    menu.hidden = true;

    wrap.append(pill, status, menu);

    rec.addEventListener('click', () => this.#handlers.onRec());
    mode.addEventListener('click', () => this.#toggleMenu());
    more.addEventListener('click', () => this.#toggleMenu());
    status.addEventListener('click', () => {
      if (this.#statusClickable) this.#handlers.onStatusClick();
    });
    menu.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button');
      if (!button || !menu.contains(button)) return;
      const { mode: modeKey, provider, lang } = button.dataset;
      if (modeKey !== undefined) this.#handlers.onMode(modeKey);
      else if (provider !== undefined) this.#handlers.onProvider(provider);
      else if (lang !== undefined) this.#handlers.onTargetLang(lang);
    });

    return { wrap, pill, mode, modeIcon, rec, recIcon, recLabel, more, status, statusIcon, statusText, menu };
  }

  #modesSection(modes, active) {
    const section = this.#section('Mode');
    const list = this.#el('div', 'list', { role: 'radiogroup', 'aria-label': 'Mode' });
    for (const [key, mode] of Object.entries(modes)) {
      if (!mode || typeof mode !== 'object') continue;
      const item = this.#el('button', 'item', { type: 'button', role: 'radio', 'aria-checked': String(key === active) });
      item.dataset.mode = key;
      const icon = this.#el('span', 'item-icon', { 'aria-hidden': 'true' });
      icon.textContent = typeof mode.icon === 'string' ? mode.icon : '';
      const name = this.#el('span', 'item-name');
      name.textContent = typeof mode.name === 'string' ? mode.name : key;
      item.append(icon, name, this.#icon('check', 'item-check'));
      list.append(item);
    }
    section.append(list);
    return section;
  }

  #translateSection(current) {
    const section = this.#section('Translate to', 'globe');
    const row = this.#el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Translate to' });
    for (const { code, name } of TARGET_LANGUAGES) {
      const chip = this.#el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(current === name), 'aria-label': name, title: name });
      chip.dataset.lang = name;
      chip.textContent = code;
      row.append(chip);
    }
    section.append(row);
    return section;
  }

  #providerSection(settings) {
    const section = this.#section('Provider');
    const row = this.#el('div', 'seg', { role: 'radiogroup', 'aria-label': 'Provider' });
    const hasKey = settings.hasKey && typeof settings.hasKey === 'object' ? settings.hasKey : {};
    for (const [id, provider] of Object.entries(PROVIDERS)) {
      const chip = this.#el('button', 'chip', { type: 'button', role: 'radio', 'aria-checked': String(settings.provider === id) });
      chip.dataset.provider = id;
      const name = this.#el('span', 'chip-name');
      name.textContent = provider.label;
      chip.append(name);
      if (hasKey[id] !== true) {
        const hint = this.#el('span', 'chip-hint');
        hint.textContent = 'no key';
        chip.append(hint);
      }
      row.append(chip);
    }
    section.append(row);
    return section;
  }

  #footerSection(settings, usage) {
    const section = this.#el('div', 'section footer');
    if (usage && typeof usage === 'object') {
      const line = this.#el('p', 'usage');
      line.textContent = `Today ${formatCost(finite(usage.todayCost))} (${finite(usage.todaySessions)}), all time ${formatCost(finite(usage.totalCost))}`;
      section.append(line);
    }
    const hotkey = settings.hotkey;
    if (hotkey && typeof hotkey === 'object' && typeof hotkey.code === 'string') {
      const hint = this.#el('p', 'hint');
      const keys = this.#el('kbd');
      keys.textContent = formatChord(hotkey, { mac: isMac(this.#doc.defaultView) });
      const text = this.#el('span');
      text.textContent = 'tap to toggle, hold to talk';
      hint.append(keys, text);
      section.append(hint);
    }
    return section;
  }

  #section(title, iconName) {
    const section = this.#el('div', 'section');
    const label = this.#el('p', 'label');
    if (iconName) label.append(this.#icon(iconName));
    label.append(title);
    section.append(label);
    return section;
  }

  #el(tag, className, attrs = {}) {
    const node = this.#doc.createElement(tag);
    if (className) node.className = className;
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  #icon(name, className) {
    const svg = this.#doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (className) svg.setAttribute('class', className);
    svg.append(this.#doc.createElementNS(SVG_NS, 'path'));
    setIcon(svg, name);
    return svg;
  }
}

/** @param {SVGSVGElement} svg @param {keyof typeof ICONS} name */
function setIcon(svg, name) {
  svg.setAttribute('data-icon', name);
  svg.firstChild.setAttribute('d', ICONS[name]);
}
