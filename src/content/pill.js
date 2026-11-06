// The in-page UI: a closed Shadow DOM pill with its status line and menu.
// User data (mode names and icons, statuses) is only ever set with textContent.
import css from './pill.css';
import { computePillPosition, computeMenuPlacement, computeMiniPosition, EDGE } from './position.js';
import { buildMenuSections } from './pill-menu.js';
import { createRaiser } from './pill-raise.js';
import { createSightWatcher } from './pill-sight.js';
import { PILL_STYLES, MINI_SIZES, REC_COLORS } from '../shared/defaults.js';
import { finite } from '../shared/numbers.js';

export { TARGET_LANGUAGES } from '../shared/defaults.js';
export { RAISE_MS } from './pill-raise.js';
export { SIGHT_DELAY_MS } from './pill-sight.js';

/**
 * @typedef {import('./position.js').Box} Box
 * @typedef {import('../shared/messages.js').ContentSettings} ContentSettings
 * @typedef {'idle'|'recording'|'processing'|'done'|'error'} PillState
 * @typedef {{ onRec: () => void, onStatusClick: () => void, onMenuOpen: () => void,
 *   onMode: (key: string) => void, onUseActive: () => void, onProvider: (id: string) => void,
 *   onTargetLang: (lang: string) => void, onHistory: (action: 'insert'|'copy'|'undo') => void,
 *   onSight?: (seen: boolean) => void, onRaised?: () => void, onZoom?: () => void }} PillHandlers
 * Without onSight the pill watches nothing. onZoom: the zoom moved the field, and no watcher hears that.
 * @typedef {{ todayCost: number, todaySessions: number, totalCost: number }} PillUsage
 * @typedef {{ refined: boolean }} PillRecent Only what the menu needs: the text stays with the controller.
 */

/** Size of the expanded pill; `.pill` in pill.css has the same width and height. */
export const PILL_SIZE = Object.freeze({ width: 140, height: 30 });

/** Size of the Minimal indicator by `miniSize`; `.mini` in pill.css has the same widths and heights. */
export const MINI_BOXES = Object.freeze({
  small: Object.freeze({ width: 92, height: 28 }),
  medium: Object.freeze({ width: 124, height: 34 }),
  large: Object.freeze({ width: 150, height: 40 }),
  xlarge: Object.freeze({ width: 184, height: 46 }),
});

/** How long a non-sticky status stays, by tone. */
export const STATUS_MS = Object.freeze({ error: 6000, warning: 6000, info: 2500, success: 2500 });

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

/** @param {number} ms */
function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export class Pill {
  #handlers;
  #doc;
  #shadowMode;
  #statusAtField;
  #els;
  #host = null;
  #root = null;
  #destroyed = false;
  #shown = false;
  #offscreen = false;
  /**
   * The box last placed at (null: the corner), for a re-place when what the pill shows changes.
   * @type {Box|null}
   */
  #anchor = null;
  /** @type {(Box & { placement: string })|null} */
  #box = null;
  #gap = 8;
  /** Another pill shows an indicator at this one's place: a Minimal status keeps clear of it. */
  #indicatorReserved = false;
  #style = 'dot';
  /** A key of MINI_BOXES. */
  #miniSize = 'small';
  /** Minimal stands beside its field, not at the bottom centre; off for Hide pill and for the mirror. */
  #beside = false;
  /** The page zoom cancelled on `.vt`. */
  #zoom = 1;
  /** The page zoom #anchor was read at: a place cancels a change before anyone reads the field again. */
  #anchorZoom = 1;
  /** A place is raising: it goes on with the box it holds, so that raise asks for no other. */
  #placing = false;
  #state = 'idle';
  #startedAt = 0;
  #timerId = null;
  #raiser = createRaiser({ raise: () => this.raise() });
  #statusTimer = null;
  #statusClickable = false;
  #terminal = false;
  #menuOpen = false;
  /** The open menu as rendered: its side of the pill and its vertical extent. */
  #menuBox = { placement: 'below', top: 0, bottom: 0 };
  #sight;

  /**
   * @param {PillHandlers} handlers An empty object is only valid for a Minimal pill, which has no controls.
   * @param {{ doc?: Document, shadowMode?: 'open'|'closed', statusAtField?: boolean }} [options] `open` is
   *   for tests only. statusAtField: a Minimal status stands by the field, as the bottom of a frame can be
   *   far out of the window.
   */
  constructor(handlers, { doc = document, shadowMode = 'closed', statusAtField = false } = {}) {
    this.#handlers = handlers;
    this.#doc = doc;
    this.#shadowMode = shadowMode;
    this.#statusAtField = statusAtField;
    this.#sight = createSightWatcher({ doc, onSight: (seen) => this.#handlers.onSight(seen) });
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
    // Closed, :host still paints it in place; only a raise (raise()) takes it to the top layer.
    host.setAttribute('popover', 'manual');
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
    // A pill at a field has a watcher; nothing else tells the corner or Minimal the window changed.
    doc.defaultView?.addEventListener('resize', this.#onResize);
    doc.addEventListener('fullscreenchange', this.#onFullscreen, true);
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
    this.#anchorZoom = this.#pageZoom();
    this.#place(anchor);
  }

  /** @param {Box|null} anchor */
  reposition(anchor) {
    if (this.#destroyed || !this.#shown) return;
    this.#anchorZoom = this.#pageZoom();
    this.#place(anchor);
  }

  hide() {
    if (this.#destroyed) return;
    this.closeMenu();
    this.#shown = false;
    this.#els.wrap.hidden = true;
    this.#syncRaising();
  }

  /** Back on top of everything the page opened since: the last one into the top layer paints on top. */
  raise() {
    if (!this.#host || this.#destroyed) return;
    try {
      // A page can take the host out or replace the root under a recording.
      if (!this.#host.isConnected) this.#doc.documentElement?.append(this.#host);
      this.#host.hidePopover();
      this.#host.showPopover();
    } catch {
      // A page can leave no root or refuse the show; z-index still holds against all but the top layer.
    }
    this.#cancelZoom();
    if (!this.#placing && this.#pageZoom() !== this.#anchorZoom) {
      this.#anchorZoom = this.#pageZoom();
      this.#handlers.onZoom?.();
      this.#replace();
    }
    this.#handlers.onRaised?.();
  }

  /** @param {'pill'|'dot'|'minimal'} style anything else is ignored */
  setStyle(style) {
    if (this.#destroyed || !PILL_STYLES.includes(style)) return;
    this.#style = style;
    this.#els.wrap.dataset.style = style;
    if (style === 'minimal') this.closeMenu();
    this.#replace();
    this.#syncSight();
  }

  /**
   * How Minimal looks and where it stands, and the recording colour of every style.
   * @param {{ miniSize?: string, recColor?: string, beside?: boolean }} [look] a value that is not
   *   known is ignored
   */
  setLook({ miniSize, recColor, beside } = {}) {
    if (this.#destroyed) return;
    const { wrap } = this.#els;
    if (MINI_SIZES.includes(miniSize)) {
      this.#miniSize = miniSize;
      wrap.dataset.miniSize = miniSize;
    }
    if (REC_COLORS.includes(recColor)) wrap.dataset.rec = recColor;
    if (typeof beside === 'boolean') this.#beside = beside;
    this.#replace();
  }

  /**
   * Hold the indicator's place for another pill, drawing nothing: only a Minimal status moves.
   * @param {boolean} on
   */
  reserveIndicator(on) {
    if (this.#destroyed) return;
    this.#indicatorReserved = on;
    this.#replace();
  }

  /**
   * @param {PillState} state
   * @param {{ elapsedMs?: number }} [options] where a clock started by this call begins
   */
  setState(state, { elapsedMs = 0 } = {}) {
    if (this.#destroyed || !STATES.has(state)) return;
    const previous = this.#state;
    this.#state = state;
    const { pill, mini, rec, recIcon, recLabel } = this.#els;
    pill.dataset.state = state;
    mini.dataset.state = state;
    mini.setAttribute('aria-label', state === 'processing' ? 'VoiceType is processing' : 'VoiceType is recording');
    rec.setAttribute('aria-label', state === 'recording' ? 'Stop recording' : 'Start recording');
    this.#replace();
    // A page listener on the raise can end this pill: no clock or observer starts after that.
    if (this.#destroyed) return;
    this.#syncSight();
    if (state === 'recording') {
      setIcon(recIcon, 'stop');
      if (previous !== 'recording') {
        this.#startedAt = Date.now() - finite(elapsedMs);
        this.#showElapsed();
        clearInterval(this.#timerId);
        this.#timerId = setInterval(() => this.#showElapsed(), 250);
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
    const rounded = String(Math.round(value * 1000) / 1000);
    const { pill, mini } = this.#els;
    for (const el of [pill, mini]) el.style.setProperty('--vt-level', rounded);
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
    this.#replace();
  }

  clearStatus() {
    if (this.#destroyed || this.#terminal) return;
    this.#resetStatus();
  }

  /**
   * @param {ContentSettings} settings
   * @param {PillUsage|null} usage
   * @param {PillRecent|null} [recent]
   */
  renderMenu(settings, usage, recent = null) {
    if (this.#destroyed || !settings || typeof settings !== 'object') return;
    const modes = settings.modes && typeof settings.modes === 'object' ? settings.modes : {};
    const wanted = settings.site?.mode;
    const siteMode = typeof wanted === 'string' && Object.hasOwn(modes, wanted) ? wanted : null;
    const active = siteMode ?? (Object.hasOwn(modes, settings.activeMode) ? settings.activeMode : 'default');
    const activeMode = Object.hasOwn(modes, active) && modes[active] && typeof modes[active] === 'object' ? modes[active] : null;
    const { mode, modeIcon, menu } = this.#els;
    const modeName = typeof activeMode?.name === 'string' ? activeMode.name : active;
    modeIcon.textContent = typeof activeMode?.icon === 'string' ? activeMode.icon : '';
    mode.title = modeName;
    mode.setAttribute('aria-label', `Mode: ${modeName}${siteMode === null ? '' : ', this site'}. Open the VoiceType menu`);

    const helpers = { el: this.#el.bind(this), icon: this.#icon.bind(this), doc: this.#doc };
    menu.replaceChildren(...buildMenuSections(helpers, { modes, active, marked: siteMode !== null, activeMode, settings, usage, recent }));
    if (this.#menuOpen) {
      this.#placeMenu();
      this.#placeStatus();
    }
  }

  openMenu() {
    if (this.#destroyed || this.#menuOpen || !this.visible || this.#style === 'minimal') return;
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
    this.#raiser.stop();
    clearTimeout(this.#statusTimer);
    this.#timerId = null;
    this.#statusTimer = null;
    this.#sight.disconnect();
    this.#doc.defaultView?.removeEventListener('resize', this.#onResize);
    this.#doc.removeEventListener('fullscreenchange', this.#onFullscreen, true);
    this.#host?.remove();
    this.#shown = false;
    this.#destroyed = true;
  }

  #onResize = () => {
    if (this.#anchor === null || this.#style === 'minimal') this.#replace();
  };

  #onFullscreen = () => {
    if (this.#raiser.running) this.raise();
  };

  /** Raise while there is something to show. An idle pill stays out: under a modal it would be a dead control. */
  #syncRaising() {
    const wanted = this.#shown && this.#hasContent();
    if (wanted === this.#raiser.running) return;
    if (wanted) {
      this.#raiser.start();
      return;
    }
    this.#raiser.stop();
    try {
      this.#host.hidePopover();
    } catch {
      // The page took the host out: it is out of the top layer already.
    }
  }

  /**
   * Watch the indicator that shows, for recording and processing only: statuses stay in the frame.
   * This asks the browser, as `visible` cannot: it holds in Minimal for a done or error with no status.
   * The target is the indicator's centre: the browser's cover test counts any box shadow, a page's or
   * our own menu's, so the whole indicator would read as covered with a shadow on its edge.
   */
  #syncSight() {
    const live = this.#state === 'recording' || this.#state === 'processing';
    const { pillSight, miniSight } = this.#els;
    const showing = this.#style === 'minimal' ? miniSight : pillSight;
    this.#sight.sync(live && this.#handlers.onSight ? showing : null);
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

  #showElapsed() {
    const text = formatElapsed(Date.now() - this.#startedAt);
    this.#els.recLabel.textContent = text;
    this.#els.miniTime.textContent = text;
  }

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

  /** A recording or a status has to be seen, so a field out of view is no reason to hide it. */
  #hasContent() {
    return this.#state !== 'idle' || !this.#els.status.hasAttribute('data-empty');
  }

  #pageZoom() {
    return this.#host.currentCSSZoom ?? 1;
  }

  /**
   * Zoom multiplies down the tree, so `all: initial` on the host does not stop one on the page root,
   * and it would scale every px here. Cancelled on `.vt`, they are viewport px, like the field's box
   * and #viewport(), which the root's zoom leaves as they are.
   */
  #cancelZoom() {
    const zoom = this.#pageZoom();
    if (zoom === this.#zoom) return;
    this.#zoom = zoom;
    this.#els.wrap.style.zoom = String(1 / zoom);
  }

  /** What the pill shows changed: with its field out of view, that decides corner or hidden. */
  #replace() {
    if (this.#shown) this.#place(this.#anchor, { keepMenu: true });
  }

  /**
   * @param {Box|null} anchor
   * @param {{ keepMenu?: boolean }} [options] keepMenu: place the menu only if the pill moved, as measuring resets its scroll
   */
  #place(anchor, { keepMenu = false } = {}) {
    this.#anchor = anchor;
    this.#cancelZoom();
    this.#placing = true;
    this.#syncRaising();
    this.#placing = false;
    if (this.#style === 'minimal') {
      this.#placeIndicator();
      return;
    }
    const { wrap, pill } = this.#els;
    const input = { pill: PILL_SIZE, viewport: this.#viewport(), gap: this.#gap };
    let pos = computePillPosition({ ...input, anchor });
    if (pos.placement === 'hidden' && this.#hasContent()) pos = computePillPosition({ ...input, anchor: null });
    if (pos.placement === 'hidden') {
      this.#offscreen = true;
      this.closeMenu();
      wrap.hidden = true;
      return;
    }
    const last = this.#box;
    this.#offscreen = false;
    this.#box = { top: pos.top, left: pos.left, width: PILL_SIZE.width, height: PILL_SIZE.height, placement: pos.placement };
    pill.dataset.placement = pos.placement;
    pill.style.top = `${Math.round(pos.top)}px`;
    pill.style.left = `${Math.round(pos.left)}px`;
    wrap.hidden = false;
    const moved = last?.top !== pos.top || last?.left !== pos.left;
    if (this.#menuOpen && (moved || !keepMenu)) this.#placeMenu();
    this.#placeStatus();
  }

  /**
   * Minimal shows beside its field when the look says so and there is room, else at the bottom
   * centre, and only with something to show.
   */
  #placeIndicator() {
    const { wrap, mini } = this.#els;
    if (!this.#hasContent()) {
      this.#offscreen = true;
      wrap.hidden = true;
      return;
    }
    const size = MINI_BOXES[this.#miniSize];
    const pos = computeMiniPosition({ anchor: this.#beside ? this.#anchor : null, indicator: size, viewport: this.#viewport(), gap: this.#gap });
    this.#offscreen = false;
    this.#box = { top: pos.top, left: pos.left, ...size, placement: pos.placement };
    mini.style.top = `${Math.round(pos.top)}px`;
    mini.style.left = `${Math.round(pos.left)}px`;
    wrap.hidden = false;
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
    const top = Math.round(pos.top);
    const maxHeight = Math.floor(pos.maxHeight);
    this.#menuBox = { placement: pos.placement, top, bottom: top + Math.min(rect.height, maxHeight) };
    menu.dataset.placement = pos.placement;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.round(pos.left)}px`;
    menu.style.maxHeight = `${maxHeight}px`;
  }

  /**
   * The box a pill would have at the field, for a Minimal status that stands there: only while the
   * indicator is at the bottom centre, as a beside one is at the field already.
   * @returns {(Box & { placement: string })|null} null with no field, or none in view: the bottom centre applies
   */
  #statusFieldBox() {
    if (!this.#statusAtField || this.#style !== 'minimal' || !this.#anchor || this.#box?.placement !== 'minimal') return null;
    const pos = computePillPosition({ anchor: this.#anchor, pill: PILL_SIZE, viewport: this.#viewport(), gap: this.#gap });
    return pos.placement === 'hidden' ? null : { ...pos, ...PILL_SIZE };
  }

  /**
   * The status prefers the side opposite an open menu, else above for the above, corner and
   * minimal placements and below otherwise. Without room there it takes the other side, or past
   * the menu's far edge while the menu is open; failing that it is clamped into the viewport.
   * On Minimal it is centred, and with no indicator showing or reserved it takes the indicator's
   * place. A clamp there still keeps the bottom edge in a frame shorter than the status.
   * A Minimal status follows the rule of the other styles against an indicator beside a field, and
   * against the field box of #statusFieldBox.
   */
  #placeStatus() {
    const box = this.#statusFieldBox() ?? this.#box;
    if (!box) return;
    const { status } = this.#els;
    const viewport = this.#viewport();
    const { width, height: measured } = status.getBoundingClientRect();
    const height = Math.max(measured, STATUS_ROOM);
    const minimal = box.placement === 'minimal';
    const indicated = this.#state === 'recording' || this.#state === 'processing' || this.#indicatorReserved;
    const tops = {
      below: box.top + box.height + STATUS_GAP,
      above: minimal && !indicated ? box.top + box.height - height : box.top - STATUS_GAP - height,
    };
    const fits = (top) => top >= EDGE && top + height <= viewport.height - EDGE;
    let preferred;
    let fallback;
    if (this.#menuOpen) {
      const menu = this.#menuBox;
      preferred = menu.placement === 'below' ? 'above' : 'below';
      // The other side holds the menu, so the fallback is past its far edge.
      fallback = menu.placement === 'below'
        ? { side: 'below', top: menu.bottom + STATUS_GAP }
        : { side: 'above', top: menu.top - STATUS_GAP - height };
    } else {
      preferred = box.placement === 'above' || box.placement === 'corner' || minimal ? 'above' : 'below';
      const other = preferred === 'below' ? 'above' : 'below';
      fallback = { side: other, top: tops[other] };
    }
    let side = preferred;
    let top = tops[preferred];
    if (!fits(top)) {
      if (fits(fallback.top)) ({ side, top } = fallback);
      else top = Math.max(EDGE, Math.min(top, viewport.height - height - EDGE));
    }
    status.dataset.side = side;
    let wanted = box.left;
    if (minimal) wanted = box.left + (box.width - width) / 2;
    else if (GROWS_LEFT.has(box.placement)) wanted = box.left + box.width - width;
    const left = Math.max(EDGE, Math.min(wanted, viewport.width - width - EDGE));
    status.style.left = `${Math.round(left)}px`;
    // "above" is lifted by its own height in CSS (translateY(-100%)), so it is placed by its bottom edge.
    const bottom = minimal ? Math.min(top + height, viewport.height - EDGE) : top + height;
    status.style.top = `${Math.round(side === 'above' ? bottom : top)}px`;
  }

  #resetStatus() {
    clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    const { status, statusText } = this.#els;
    statusText.textContent = '';
    status.setAttribute('data-empty', '');
    status.removeAttribute('data-clickable');
    this.#statusClickable = false;
    this.#replace();
  }

  #build() {
    const el = (tag, className, attrs = {}) => this.#el(tag, className, attrs);
    const wrap = el('div', 'vt');
    wrap.hidden = true;
    wrap.dataset.style = 'dot';
    wrap.dataset.miniSize = 'small';
    wrap.dataset.rec = 'red';

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
    const pillSight = el('span', 'sight', { 'aria-hidden': 'true' });
    pill.append(body, pillSight);

    const status = el('div', 'status', { role: 'status', 'aria-live': 'polite', 'data-empty': '' });
    status.dataset.tone = 'info';
    status.dataset.side = 'below';
    const statusIcon = this.#icon('alert', 'status-icon');
    const statusText = el('span', 'status-text');
    status.append(statusIcon, statusText);

    const menu = el('div', 'menu', { id: 'vt-menu', role: 'group', 'aria-label': 'VoiceType menu' });
    menu.hidden = true;

    const mini = el('div', 'mini', { role: 'img', 'aria-label': 'VoiceType is recording' });
    mini.dataset.state = 'idle';
    const levels = el('span', 'levels', { 'aria-hidden': 'true' });
    // Ten, the most a size shows: pill.css hides the rest.
    levels.append(...Array.from({ length: 10 }, () => el('span', 'lvl')));
    const miniTime = el('span', 'mini-time', { 'aria-hidden': 'true' });
    const miniSight = el('span', 'sight', { 'aria-hidden': 'true' });
    mini.append(levels, this.#icon('dots', 'mini-dots'), miniTime, miniSight);

    wrap.append(pill, status, mini, menu);

    rec.addEventListener('click', () => this.#handlers.onRec());
    mode.addEventListener('click', () => this.#toggleMenu());
    more.addEventListener('click', () => this.#toggleMenu());
    status.addEventListener('click', () => {
      if (this.#statusClickable) this.#handlers.onStatusClick();
    });
    menu.addEventListener('click', (event) => {
      const button = event.target?.closest?.('button');
      if (!button || !menu.contains(button)) return;
      const { useActive, mode: modeKey, provider, lang, history } = button.dataset;
      if (history !== undefined) {
        this.closeMenu();
        this.#handlers.onHistory(history);
      } else if (useActive !== undefined) this.#handlers.onUseActive();
      else if (modeKey !== undefined) this.#handlers.onMode(modeKey);
      else if (provider !== undefined) this.#handlers.onProvider(provider);
      else if (lang !== undefined) this.#handlers.onTargetLang(lang);
    });

    return { wrap, pill, pillSight, mini, miniSight, miniTime, mode, modeIcon, rec, recIcon, recLabel, more, status, statusIcon, statusText, menu };
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
