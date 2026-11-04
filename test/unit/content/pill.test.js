// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pill, PILL_SIZE, MINI_SIZE, SIGHT_THRESHOLD, SIGHT_DELAY_MS, STATUS_MS, TARGET_LANGUAGES } from '../../../src/content/pill.js';
import { computePillPosition, EDGE } from '../../../src/content/position.js';

// A path, not a URL literal: jsdom replaces the global URL, and the web transform rewrites
// `new URL('<literal>', import.meta.url)` into a dev-server address.
const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), 'utf8');
const CSS_TEXT = read('../../../src/content/pill.css');
const VIEWPORT = { width: 1024, height: 768 }; // jsdom's innerWidth and innerHeight
const FIELD = { top: 100, left: 400, width: 300, height: 30 };
const BOTTOM_FIELD = { top: 730, left: 400, width: 300, height: 30 };
const HOSTILE = '<img src=x onerror=alert(1)>';

function handlers() {
  return {
    onRec: vi.fn(), onStatusClick: vi.fn(), onMenuOpen: vi.fn(),
    onMode: vi.fn(), onUseActive: vi.fn(), onProvider: vi.fn(), onTargetLang: vi.fn(),
  };
}

function makePill() {
  const h = handlers();
  const pill = new Pill(h, { shadowMode: 'open' });
  return { pill, h };
}

function settings(overrides = {}) {
  return {
    provider: 'openai',
    hasKey: { openai: true, gemini: false },
    activeMode: 'default',
    translateTargetLang: 'Greek',
    hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
    pillGap: 8,
    modes: {
      default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
      translate: { name: 'Translate', icon: '🌐', prompt: 'x', builtIn: true, hasLanguageOption: true },
    },
    ...overrides,
  };
}

const q = (pill, selector) => pill.root.querySelector(selector);
const statusEl = (pill) => q(pill, '[role="status"]');
const rect = (width, height) => () => ({ top: 0, left: 0, right: width, bottom: height, width, height });
const STATUS_SIZE = { width: 120, height: 29 };
const MENU_SIZE = { width: 248, height: 300 };
const pxValue = (value) => parseInt(value, 10);

/** The status as rendered at its mocked size; "above" is lifted by its own height in CSS. */
function statusRect(pill, { width, height } = STATUS_SIZE) {
  const el = statusEl(pill);
  const top = pxValue(el.style.top) - (el.dataset.side === 'above' ? height : 0);
  return { top, left: pxValue(el.style.left), width, height };
}

/** The open menu as rendered at its mocked size, capped by its max-height. */
function menuRect(pill, { width, height } = MENU_SIZE) {
  const el = q(pill, '.menu');
  return { top: pxValue(el.style.top), left: pxValue(el.style.left), width, height: Math.min(height, pxValue(el.style.maxHeight)) };
}

function pillRect(pill) {
  const el = q(pill, '.pill');
  return { top: pxValue(el.style.top), left: pxValue(el.style.left), ...PILL_SIZE };
}

const overlaps = (a, b) => a.top < b.top + b.height && b.top < a.top + a.height
  && a.left < b.left + b.width && b.left < a.left + a.width;

/** Asserts the status, at `size`, lies fully inside the viewport. */
function expectStatusOnScreen(pill, size = STATUS_SIZE) {
  const { top, height } = statusRect(pill, size);
  const label = `status ${statusEl(pill).dataset.side} at ${top}`;
  expect(top, label).toBeGreaterThanOrEqual(EDGE);
  expect(top + height, label).toBeLessThanOrEqual(VIEWPORT.height - EDGE);
}

/** Asserts the status covers neither the pill nor, while it is open, the menu. */
function expectStatusClear(pill) {
  const status = statusRect(pill);
  expect(overlaps(status, pillRect(pill)), 'status over the pill').toBe(false);
  if (pill.menuOpen) expect(overlaps(status, menuRect(pill)), 'status over the menu').toBe(false);
}

beforeEach(() => {
  document.documentElement.querySelectorAll('voicetype-host').forEach((el) => el.remove());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mount', () => {
  it('appends one host to documentElement with the all: initial prefix and the top z-index', () => {
    const { pill } = makePill();
    pill.mount();
    pill.mount();
    const hosts = document.documentElement.querySelectorAll('voicetype-host');
    expect(hosts).toHaveLength(1);
    expect(pill.host).toBe(hosts[0]);
    expect(pill.host.parentNode).toBe(document.documentElement);
    expect(pill.host.style.cssText).toMatch(/^all: initial; position: fixed; top: 0(px)?; left: 0(px)?; z-index: 2147483647;/);
    expect(pill.root.mode).toBe('open');
  });

  it('uses a closed shadow root by default', () => {
    const pill = new Pill(handlers());
    pill.mount();
    expect(pill.host.shadowRoot).toBeNull();
    expect(pill.root.mode).toBe('closed');
  });

  it('adopts the stylesheet when constructable sheets are supported', () => {
    const { pill } = makePill();
    pill.mount();
    expect(pill.root.adoptedStyleSheets).toHaveLength(1);
    expect(pill.root.querySelector('style')).toBeNull();
  });

  it('falls back to a style element holding pill.css when replaceSync is missing', () => {
    const replaceSync = CSSStyleSheet.prototype.replaceSync;
    delete CSSStyleSheet.prototype.replaceSync;
    try {
      const { pill } = makePill();
      pill.mount();
      expect(pill.root.querySelector('style').textContent).toBe(CSS_TEXT);
    } finally {
      CSSStyleSheet.prototype.replaceSync = replaceSync;
    }
  });

  it('keeps the host invisible until show()', () => {
    const { pill } = makePill();
    pill.mount();
    expect(pill.visible).toBe(false);
    expect(q(pill, '.vt').hidden).toBe(true);
  });
});

describe('placement', () => {
  it('positions the pill with computePillPosition and mounts on first show', () => {
    const { pill } = makePill();
    pill.show(FIELD, { gap: 12 });
    const expected = computePillPosition({ anchor: FIELD, pill: PILL_SIZE, viewport: VIEWPORT, gap: 12 });
    const el = q(pill, '.pill');
    expect(pill.visible).toBe(true);
    expect(el.dataset.placement).toBe(expected.placement);
    expect(el.style.top).toBe(`${Math.round(expected.top)}px`);
    expect(el.style.left).toBe(`${Math.round(expected.left)}px`);
  });

  it('uses the corner without an anchor', () => {
    const { pill } = makePill();
    pill.show(null);
    expect(q(pill, '.pill').dataset.placement).toBe('corner');
  });

  it('hides for an anchor outside the viewport and comes back on reposition', () => {
    const { pill } = makePill();
    pill.show({ top: -500, left: 400, width: 300, height: 30 });
    expect(pill.visible).toBe(false);
    expect(q(pill, '.vt').hidden).toBe(true);
    pill.reposition(FIELD);
    expect(pill.visible).toBe(true);
  });

  it('hide() hides, and reposition() does not bring it back', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.hide();
    expect(pill.visible).toBe(false);
    pill.reposition(FIELD);
    expect(pill.visible).toBe(false);
  });

  describe('field scrolled out of view', () => {
    const OFFSCREEN = { top: -3000, left: 400, width: 300, height: 30 };
    const CORNER = computePillPosition({ anchor: null, pill: PILL_SIZE, viewport: VIEWPORT, gap: 8 });

    afterEach(() => {
      vi.useRealTimers();
    });

    function expectAtCorner(pill) {
      const el = q(pill, '.pill');
      expect(pill.visible).toBe(true);
      expect(q(pill, '.vt').hidden).toBe(false);
      expect(el.dataset.placement).toBe('corner');
      expect(el.style.top).toBe(`${CORNER.top}px`);
      expect(el.style.left).toBe(`${CORNER.left}px`);
    }

    function expectHidden(pill) {
      expect(pill.visible).toBe(false);
      expect(q(pill, '.vt').hidden).toBe(true);
    }

    it('a recording that starts there shows at the corner at once', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      expectHidden(pill);
      pill.setState('recording');
      expectAtCorner(pill);
    });

    it.each(['processing', 'done', 'error'])('so does %s', (state) => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setState(state);
      expectAtCorner(pill);
    });

    it('a field scrolled away during a recording leaves the pill at the corner', () => {
      const { pill } = makePill();
      pill.show(FIELD);
      pill.setState('recording');
      pill.reposition(OFFSCREEN);
      expectAtCorner(pill);
    });

    it('an idle pill with no status stays hidden', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setState('idle');
      expectHidden(pill);
      pill.reposition({ ...OFFSCREEN, top: -2000 });
      expectHidden(pill);
    });

    it('a recording that ends there hides again', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setState('recording');
      pill.setState('idle');
      expectHidden(pill);
    });

    it('a sticky status shows and stays clickable, and hides once it is cleared', () => {
      const { pill, h } = makePill();
      pill.show(OFFSCREEN);
      pill.setStatus('Could not insert.', { tone: 'error', sticky: true, clickable: true });
      expectAtCorner(pill);
      statusEl(pill).click();
      expect(h.onStatusClick).toHaveBeenCalledTimes(1);
      pill.clearStatus();
      expectHidden(pill);
    });

    it('a timed status hides again when it runs out', () => {
      vi.useFakeTimers();
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setStatus('Saved', { tone: 'info' });
      expectAtCorner(pill);
      vi.advanceTimersByTime(STATUS_MS.info);
      expectHidden(pill);
    });

    it('the status keeps the pill up while the state goes back to idle', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setState('done');
      pill.setStatus('Could not insert.', { tone: 'error', sticky: true, clickable: true });
      pill.setState('idle');
      expectAtCorner(pill);
    });

    it('scrolling back returns the pill to the field', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.setState('recording');
      pill.reposition(FIELD);
      const expected = computePillPosition({ anchor: FIELD, pill: PILL_SIZE, viewport: VIEWPORT, gap: 8 });
      const el = q(pill, '.pill');
      expect(pill.visible).toBe(true);
      expect(el.dataset.placement).toBe(expected.placement);
      expect(el.style.top).toBe(`${Math.round(expected.top)}px`);
      expect(el.style.left).toBe(`${Math.round(expected.left)}px`);
    });

    it('a state change leaves a pill on screen where it is', () => {
      const { pill } = makePill();
      pill.show(FIELD);
      const before = pillRect(pill);
      pill.setState('recording');
      expect(pillRect(pill)).toEqual(before);
    });

    it('a pill hidden by hide() stays hidden through a state or a status', () => {
      const { pill } = makePill();
      pill.show(OFFSCREEN);
      pill.hide();
      pill.setState('recording');
      pill.setStatus('x', { sticky: true });
      expect(pill.visible).toBe(false);
      expect(q(pill, '.vt').hidden).toBe(true);
    });
  });
});

describe('state and level', () => {
  it('sets data-state and the REC aria-label', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const rec = q(pill, '.rec');
    expect(rec.getAttribute('aria-label')).toBe('Start recording');
    for (const state of ['recording', 'processing', 'done', 'error', 'idle']) {
      pill.setState(state);
      expect(q(pill, '.pill').dataset.state).toBe(state);
      expect(rec.getAttribute('aria-label')).toBe(state === 'recording' ? 'Stop recording' : 'Start recording');
    }
    pill.setState('bogus');
    expect(q(pill, '.pill').dataset.state).toBe('idle');
  });

  it('shows an mm:ss timer from the moment recording starts', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    const label = q(pill, '.rec-label');
    expect(label.textContent).toBe('REC');
    pill.setState('recording');
    expect(label.textContent).toBe('00:00');
    vi.advanceTimersByTime(3000);
    expect(label.textContent).toBe('00:03');
    vi.advanceTimersByTime(62000);
    expect(label.textContent).toBe('01:05');
    pill.setState('processing');
    expect(vi.getTimerCount()).toBe(0);
    pill.setState('idle');
    expect(label.textContent).toBe('REC');
  });

  it('uses inline SVG icons for its own controls and swaps mic for stop', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const icon = () => q(pill, '.rec svg').getAttribute('data-icon');
    expect(q(pill, '.rec svg').namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(icon()).toBe('mic');
    pill.setState('recording');
    expect(icon()).toBe('stop');
    expect(q(pill, '.more svg').getAttribute('data-icon')).toBe('dots');
  });

  it('clamps the level into --vt-level', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    const level = () => q(pill, '.pill').style.getPropertyValue('--vt-level');
    pill.setLevel(0.5);
    expect(level()).toBe('0.5');
    pill.setLevel(7);
    expect(level()).toBe('1');
    pill.setLevel(-1);
    expect(level()).toBe('0');
    pill.setLevel(Number.NaN);
    expect(level()).toBe('0');
  });
});

describe('status', () => {
  it('is a polite live region', () => {
    const { pill } = makePill();
    pill.mount();
    expect(statusEl(pill).getAttribute('aria-live')).toBe('polite');
  });

  it.each([
    ['error', 6000],
    ['warning', 6000],
    ['info', 2500],
    ['success', 2500],
  ])('clears a %s status after %i ms', (tone, ms) => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Hello', { tone });
    expect(STATUS_MS[tone]).toBe(ms);
    expect(statusEl(pill).textContent).toBe('Hello');
    expect(statusEl(pill).dataset.tone).toBe(tone);
    vi.advanceTimersByTime(ms - 1);
    expect(statusEl(pill).textContent).toBe('Hello');
    vi.advanceTimersByTime(1);
    expect(statusEl(pill).textContent).toBe('');
    expect(statusEl(pill).hasAttribute('data-empty')).toBe(true);
  });

  it('keeps a sticky status until it is replaced or cleared', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Stay', { tone: 'error', sticky: true });
    vi.advanceTimersByTime(60000);
    expect(statusEl(pill).textContent).toBe('Stay');
    pill.clearStatus();
    expect(statusEl(pill).textContent).toBe('');
  });

  it('locks a terminal status against later updates', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('VoiceType was turned off or updated. Reload this page.', { tone: 'error', terminal: true });
    pill.setStatus('Done $0.01', { tone: 'success' });
    pill.clearStatus();
    vi.advanceTimersByTime(60000);
    expect(statusEl(pill).textContent).toBe('VoiceType was turned off or updated. Reload this page.');
    expect(statusEl(pill).dataset.tone).toBe('error');
  });

  it('calls onStatusClick only while the status is clickable', () => {
    const { pill, h } = makePill();
    pill.show(FIELD);
    pill.setStatus('Plain', { tone: 'info' });
    statusEl(pill).click();
    expect(h.onStatusClick).not.toHaveBeenCalled();
    pill.setStatus('Could not insert. Click here to copy the text.', { tone: 'error', sticky: true, clickable: true });
    statusEl(pill).click();
    expect(h.onStatusClick).toHaveBeenCalledTimes(1);
    pill.setStatus('Copied to clipboard.', { tone: 'success' });
    statusEl(pill).click();
    expect(h.onStatusClick).toHaveBeenCalledTimes(1);
  });

  it('renders markup in a status as literal text', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus(HOSTILE, { tone: 'error' });
    expect(statusEl(pill).textContent).toBe(HOSTILE);
    expect(pill.root.querySelector('img')).toBeNull();
  });

  it('aligns the status with the side the pill grows from', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStatus('Hello');
    const slot = q(pill, '.pill');
    const px = (value) => `${value}px`;
    // jsdom has no layout, so the status is 0 px wide and its left edge lands on the aligned slot edge.
    expect(slot.dataset.placement).toBe('left');
    expect(statusEl(pill).style.left).toBe(px(parseInt(slot.style.left, 10) + PILL_SIZE.width));
    pill.show({ top: 0, left: 0, width: 1024, height: 768 });
    expect(slot.dataset.placement).toBe('inside');
    expect(statusEl(pill).style.left).toBe(px(parseInt(slot.style.left, 10) + PILL_SIZE.width));
    pill.show({ top: 100, left: 10, width: 300, height: 30 });
    expect(slot.dataset.placement).toBe('right');
    expect(statusEl(pill).style.left).toBe(slot.style.left);
  });

  it('sits on the side opposite an open menu', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.setStatus('Hello');
    expect(statusEl(pill).dataset.side).toBe('below');
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('below');
    expect(statusEl(pill).dataset.side).toBe('above');
    pill.closeMenu();
    expect(statusEl(pill).dataset.side).toBe('below');

    q(pill, '.menu').getBoundingClientRect = rect(MENU_SIZE.width, MENU_SIZE.height);
    statusEl(pill).getBoundingClientRect = rect(STATUS_SIZE.width, STATUS_SIZE.height);
    pill.show(BOTTOM_FIELD);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('above');
    expectStatusOnScreen(pill);
    expectStatusClear(pill);
  });

  it('keeps the status on screen for an above pill near the top', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show({ top: 50, left: 100, width: 800, height: 30 });
    statusEl(pill).getBoundingClientRect = rect(STATUS_SIZE.width, STATUS_SIZE.height);
    q(pill, '.menu').getBoundingClientRect = rect(MENU_SIZE.width, MENU_SIZE.height);
    pill.setStatus('Hello');
    expect(q(pill, '.pill').dataset.placement).toBe('above');
    expect(pxValue(q(pill, '.pill').style.top)).toBeLessThan(35);
    expectStatusOnScreen(pill);
    expectStatusClear(pill);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('below');
    expectStatusOnScreen(pill);
    expectStatusClear(pill);
  });

  it('keeps the status on screen in the corner, with and without the menu', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(null);
    statusEl(pill).getBoundingClientRect = rect(STATUS_SIZE.width, STATUS_SIZE.height);
    q(pill, '.menu').getBoundingClientRect = rect(MENU_SIZE.width, MENU_SIZE.height);
    pill.setStatus('Hello');
    expect(q(pill, '.pill').dataset.placement).toBe('corner');
    expectStatusOnScreen(pill);
    expectStatusClear(pill);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('above');
    expectStatusOnScreen(pill);
    expectStatusClear(pill);
  });

  it('clamps a status that fits on neither side into the viewport', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    statusEl(pill).getBoundingClientRect = rect(300, 740);
    pill.setStatus('A very long message');
    expectStatusOnScreen(pill, { width: 300, height: 740 });
  });
});

describe('menu', () => {
  it('renders a mode named like markup as literal text and creates no element (M3)', () => {
    const { pill } = makePill();
    const s = settings({
      activeMode: 'evil',
      modes: { ...settings().modes, evil: { name: HOSTILE, icon: '<b>x</b>', prompt: 'p', builtIn: false } },
    });
    pill.renderMenu(s, null);
    pill.show(FIELD);
    const names = [...pill.root.querySelectorAll('.item-name')].map((el) => el.textContent);
    expect(names).toContain(HOSTILE);
    expect(q(pill, '.mode-icon').textContent).toBe('<b>x</b>');
    expect(pill.root.querySelector('img')).toBeNull();
    expect(pill.root.querySelector('b')).toBeNull();
  });

  it('marks the active mode with aria-checked and reports clicks', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ activeMode: 'translate' }), null);
    pill.show(FIELD);
    const items = [...pill.root.querySelectorAll('[data-mode]')];
    expect(items.map((el) => el.dataset.mode)).toEqual(['default', 'translate']);
    expect(items.map((el) => el.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(q(pill, '.mode-icon').textContent).toBe('🌐');
    items[0].click();
    expect(h.onMode).toHaveBeenCalledWith('default');
  });

  it('lists the built-in modes before custom modes, whatever the key order', () => {
    const { pill } = makePill();
    const custom = (name) => ({ name, icon: '🎯', prompt: 'p', builtIn: false });
    // chrome.storage hands objects back with their keys sorted: custom_ before default.
    pill.renderMenu(settings({
      modes: {
        custom_10: custom('Later'),
        custom_9: custom('Earlier'),
        default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
        email: { name: 'Email', icon: '📧', prompt: 'e', builtIn: true },
        instruct: { name: 'Instruct', icon: '💡', prompt: 'i', builtIn: true },
        translate: { name: 'Translate', icon: '🌐', prompt: 'x', builtIn: true, hasLanguageOption: true },
      },
    }), null);
    pill.show(FIELD);
    const items = [...pill.root.querySelectorAll('[data-mode]')];
    expect(items.map((el) => el.dataset.mode)).toEqual(['default', 'email', 'translate', 'instruct', 'custom_9', 'custom_10']);
    expect(items.map((el) => el.querySelector('.item-name').textContent)).toEqual(['Default', 'Email', 'Translate', 'Instruct', 'Earlier', 'Later']);
  });

  it('shows the translate row only when the active mode has a language option', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ activeMode: 'default' }), null);
    pill.show(FIELD);
    expect(pill.root.querySelectorAll('[data-lang]')).toHaveLength(0);

    pill.renderMenu(settings({ activeMode: 'translate', translateTargetLang: 'Greek' }), null);
    const chips = [...pill.root.querySelectorAll('[data-lang]')];
    expect(chips.map((el) => el.dataset.lang)).toEqual(['English', 'Greek', 'Spanish', 'French', 'German']);
    expect(chips.map((el) => el.dataset.lang)).toEqual(TARGET_LANGUAGES.map((l) => l.name));
    expect(chips.find((el) => el.getAttribute('aria-checked') === 'true').dataset.lang).toBe('Greek');
    chips[3].click();
    expect(h.onTargetLang).toHaveBeenCalledWith('French');
  });

  describe('site mode', () => {
    const modes = {
      default: { name: 'Default', icon: '🎤', prompt: '', builtIn: true },
      email: { name: 'Email', icon: '📧', prompt: 'e', builtIn: true },
      translate: { name: 'Translate', icon: '🌐', prompt: 'x', builtIn: true, hasLanguageOption: true },
    };
    const rendered = (overrides) => {
      const made = makePill();
      made.pill.renderMenu(settings({ modes, activeMode: 'default', ...overrides }), null);
      made.pill.show(FIELD);
      return made;
    };
    const item = (pill, key) => q(pill, `[data-mode="${key}"]`);

    it('marks the site mode', () => {
      const { pill } = rendered({ site: { hidePill: false, mode: 'email' } });
      expect(item(pill, 'email').getAttribute('aria-checked')).toBe('true');
      expect(item(pill, 'default').getAttribute('aria-checked')).toBe('false');
      expect(item(pill, 'email').querySelector('.item-tag').textContent).toBe('This site');
      expect(pill.root.querySelectorAll('.item-tag')).toHaveLength(1);
      const first = q(pill, '.item');
      expect(first.querySelector('.item-name').textContent).toBe('Use active mode');
      expect(first.getAttribute('aria-checked')).toBe('false');
      expect(first.getAttribute('role')).toBe('radio');
      expect(first.getAttribute('type')).toBe('button');
      expect(q(pill, '.mode-icon').textContent).toBe('📧');
      expect(q(pill, '.mode').getAttribute('aria-label')).toBe('Mode: Email, this site. Open the VoiceType menu');
    });

    it.each([
      ['site absent', {}],
      ['a hide-only rule', { site: { hidePill: true, mode: null } }],
      ['a mode not in modes', { site: { hidePill: false, mode: 'gone' } }],
      ['an inherited key', { site: { hidePill: false, mode: 'constructor' } }],
    ])('no marking without a mode rule: %s', (_, overrides) => {
      const { pill } = rendered({ activeMode: 'email', ...overrides });
      expect(q(pill, '.item-tag')).toBeNull();
      expect(q(pill, '[data-use-active]')).toBeNull();
      expect(item(pill, 'email').getAttribute('aria-checked')).toBe('true');
      expect(q(pill, '.mode').getAttribute('aria-label')).toBe('Mode: Email. Open the VoiceType menu');
    });

    it('Use active mode calls onUseActive and not onMode', () => {
      const { pill, h } = rendered({ site: { hidePill: false, mode: 'email' } });
      q(pill, '[data-use-active]').click();
      expect(h.onUseActive).toHaveBeenCalledTimes(1);
      expect(h.onMode).not.toHaveBeenCalled();
      item(pill, 'default').click();
      expect(h.onMode).toHaveBeenCalledWith('default');
      expect(h.onUseActive).toHaveBeenCalledTimes(1);
    });

    it('the Translate section follows the site mode', () => {
      const { pill } = rendered({ site: { hidePill: false, mode: 'translate' } });
      expect(pill.root.querySelectorAll('[data-lang]')).toHaveLength(TARGET_LANGUAGES.length);
      const other = rendered({ activeMode: 'translate', site: { hidePill: false, mode: 'email' } });
      expect(other.pill.root.querySelectorAll('[data-lang]')).toHaveLength(0);
    });

    it('a hostile mode name stays text', () => {
      const { pill } = rendered({
        modes: { ...modes, evil: { name: HOSTILE, icon: '<b>x</b>', prompt: 'p', builtIn: false } },
        site: { hidePill: false, mode: 'evil' },
      });
      const marked = item(pill, 'evil');
      expect(marked.querySelector('.item-name').textContent).toBe(HOSTILE);
      expect(marked.querySelector('.item-tag').textContent).toBe('This site');
      expect(q(pill, '.mode').getAttribute('aria-label')).toBe(`Mode: ${HOSTILE}, this site. Open the VoiceType menu`);
      expect(pill.root.querySelector('img')).toBeNull();
      expect(pill.root.querySelector('b')).toBeNull();
    });

    it('the tag has a style of at least 12 px', () => {
      const rule = CSS_TEXT.match(/\.item-tag \{[^}]*\}/)?.[0];
      expect(rule).toBeDefined();
      expect(pxValue(rule.match(/font-size: (\d+)px/)[1])).toBeGreaterThanOrEqual(12);
    });
  });

  it('shows "no key" on a provider without a key and reports clicks', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings({ provider: 'openai', hasKey: { openai: true, gemini: false } }), null);
    pill.show(FIELD);
    const openai = q(pill, '[data-provider="openai"]');
    const gemini = q(pill, '[data-provider="gemini"]');
    expect(openai.getAttribute('aria-checked')).toBe('true');
    expect(openai.textContent).toBe('OpenAI');
    expect(gemini.getAttribute('aria-checked')).toBe('false');
    expect(gemini.textContent).toBe('Geminino key');
    expect(q(pill, '[data-provider="gemini"] .chip-hint').textContent).toBe('no key');
    gemini.click();
    expect(h.onProvider).toHaveBeenCalledWith('gemini');
  });

  it('formats the usage line with formatCost and omits it without usage', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), { todayCost: 0.012, todaySessions: 3, totalCost: 0.21 });
    pill.show(FIELD);
    expect(q(pill, '.usage').textContent).toBe('Today $0.01 (3), all time $0.21');
    pill.renderMenu(settings(), { todayCost: 0.004, todaySessions: 1, totalCost: 0 });
    expect(q(pill, '.usage').textContent).toBe('Today <$0.01 (1), all time $0.00');
    pill.renderMenu(settings(), null);
    expect(q(pill, '.usage')).toBeNull();
  });

  it('shows the hotkey hint', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    expect(q(pill, '.hint kbd').textContent).toBe('Ctrl+Shift+Space');
    expect(q(pill, '.hint span').textContent).toBe('tap to toggle, hold to talk');
  });

  it('makes every control a type=button button', () => {
    const { pill } = makePill();
    pill.renderMenu(settings({ activeMode: 'translate' }), { todayCost: 0, todaySessions: 0, totalCost: 0 });
    pill.show(FIELD);
    const buttons = [...pill.root.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) expect(button.getAttribute('type')).toBe('button');
  });

  it('caps the menu to the room on its side, measuring it uncapped each time', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    const menu = q(pill, '.menu');
    const measuredWith = [];
    menu.getBoundingClientRect = () => {
      measuredWith.push(menu.style.maxHeight);
      return rect(248, 700)();
    };
    pill.openMenu();
    // Pill at 100: 628 px below, 90 px above; neither fits 700, so below, capped.
    expect(menu.dataset.placement).toBe('below');
    expect(menu.style.top).toBe('136px');
    expect(menu.style.maxHeight).toBe('628px');
    pill.reposition(BOTTOM_FIELD);
    // Pill at 730: 720 px above fits 700, clear of the pill.
    expect(menu.dataset.placement).toBe('above');
    expect(menu.style.top).toBe('24px');
    expect(menu.style.maxHeight).toBe('720px');
    expect(measuredWith).toEqual(['', '']);
  });

  it('a state or status change leaves a placed menu alone, so its scroll stays', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    const menu = q(pill, '.menu');
    let measures = 0;
    menu.getBoundingClientRect = () => {
      measures += 1;
      return rect(248, 700)();
    };
    pill.openMenu();
    expect(measures).toBe(1);
    pill.setState('recording');
    pill.setStatus('Saved', { sticky: true });
    pill.clearStatus();
    expect(measures).toBe(1);
    expect(menu.style.maxHeight).toBe('628px');
    // A pill that does move takes its menu along.
    pill.reposition(BOTTOM_FIELD);
    expect(measures).toBe(2);
  });

  it('opens from the menu button, calls onMenuOpen, and closes on Escape', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    q(pill, '.more').click();
    expect(pill.menuOpen).toBe(true);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
    expect(q(pill, '.more').getAttribute('aria-expanded')).toBe('true');
    expect(q(pill, '.menu').hidden).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(pill.menuOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(q(pill, '.menu').hidden).toBe(true);
    const later = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });

  it('closes on a mousedown outside the pill but not inside it', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.openMenu();
    q(pill, '[data-mode="default"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    expect(pill.menuOpen).toBe(true);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(pill.menuOpen).toBe(false);
  });

  it('does not open while hidden, and hide() closes it', () => {
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.mount();
    pill.openMenu();
    expect(pill.menuOpen).toBe(false);
    pill.show(FIELD);
    pill.openMenu();
    pill.hide();
    expect(pill.menuOpen).toBe(false);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
  });
});

describe('styles', () => {
  const INDICATOR = { top: '724px', left: '466px' }; // bottom centre of jsdom's 1024 x 768
  const STATUS_200 = rect(200, 40);
  const vt = (pill) => q(pill, '.vt');
  const mini = (pill) => q(pill, '.mini');
  const at = (el) => ({ top: el.style.top, left: el.style.left });
  /** The CSS rule holding a declaration, selector included. */
  const ruleWith = (declaration) => CSS_TEXT.match(new RegExp(`[^{}]*\\{[^{}]*${declaration}[^{}]*\\}`))?.[0];

  function minimal() {
    const made = makePill();
    made.pill.setStyle('minimal');
    return made;
  }

  it('starts as dot', () => {
    const { pill } = makePill();
    pill.mount();
    expect(vt(pill).dataset.style).toBe('dot');
    const dot = q(pill, '.dot');
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(dot.querySelector('button')).toBeNull();
  });

  it('setStyle ignores an unknown value', () => {
    const { pill } = makePill();
    pill.mount();
    pill.setStyle('pill');
    for (const value of ['huge', undefined, null, 'constructor']) pill.setStyle(value);
    expect(vt(pill).dataset.style).toBe('pill');
  });

  it('setStyle does nothing after destroy', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.destroy();
    pill.setStyle('minimal');
    expect(vt(pill).dataset.style).toBe('dot');
    expect(pill.visible).toBe(false);
  });

  it('CSS: pill expands at idle', () => {
    expect(ruleWith('padding: 0 3px')).toContain(".vt[data-style='pill'] .body");
    expect(ruleWith('width: 0;\\s+opacity: 0')).toContain(".vt[data-style='pill'] .dot");
    expect(ruleWith('max-width: 134px')).toContain(".vt[data-style='pill'] .bar");
  });

  it('CSS: minimal has no pill, and the indicator shows only while recording or processing', () => {
    expect(CSS_TEXT).toMatch(/\.vt\[data-style='minimal'\] \.pill \{\s*display: none;\s*\}/);
    expect(CSS_TEXT.match(/^\.mini \{[^}]*\}/m)[0]).toMatch(/\bdisplay: none;/);
    expect(CSS_TEXT).toMatch(/\.vt\[data-style='minimal'\] \.mini:is\(\[data-state='recording'\], \[data-state='processing'\]\) \{\s*display: flex;/);
  });

  it('the indicator follows the status, so it paints over one in a short frame', () => {
    const { pill } = makePill();
    pill.mount();
    const children = [...vt(pill).children];
    expect(children.indexOf(mini(pill))).toBeGreaterThan(children.indexOf(statusEl(pill)));
  });

  it('MINI_SIZE matches .mini in pill.css', () => {
    const rule = CSS_TEXT.match(/^\.mini \{[^}]*\}/m)[0];
    expect(MINI_SIZE).toEqual({ width: 92, height: 28 });
    expect(rule).toContain(`width: ${MINI_SIZE.width}px;`);
    expect(rule).toContain(`height: ${MINI_SIZE.height}px;`);
  });

  it('minimal: show with nothing to show stays hidden', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    expect(vt(pill).hidden).toBe(true);
    expect(pill.visible).toBe(false);
  });

  it.each([['a field', FIELD], ['a field at the bottom', BOTTOM_FIELD], ['no field', null], ['a field out of view', { ...FIELD, top: -3000 }]])(
    'minimal: recording shows the indicator at the bottom centre with %s',
    (_, anchor) => {
      const { pill } = minimal();
      pill.show(anchor);
      pill.setState('recording');
      expect(pill.visible).toBe(true);
      expect(vt(pill).hidden).toBe(false);
      expect(at(mini(pill))).toEqual(INDICATOR);
    },
  );

  it('minimal: reposition ignores the field', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    pill.reposition(BOTTOM_FIELD);
    expect(at(mini(pill))).toEqual(INDICATOR);
    pill.reposition(null);
    expect(at(mini(pill))).toEqual(INDICATOR);
  });

  it('minimal: a recording that ends hides again', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    pill.setState('idle');
    expect(vt(pill).hidden).toBe(true);
    expect(pill.visible).toBe(false);
  });

  it('leaving minimal goes back to the stored field', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    pill.reposition(BOTTOM_FIELD);
    pill.setStyle('dot');
    const expected = computePillPosition({ anchor: BOTTOM_FIELD, pill: PILL_SIZE, viewport: VIEWPORT, gap: 8 });
    expect(pillRect(pill)).toMatchObject({ top: Math.round(expected.top), left: Math.round(expected.left) });
    expect(q(pill, '.pill').dataset.placement).toBe(expected.placement);
    expect(pill.visible).toBe(true);
  });

  it('leaving minimal shows the idle pill that had nothing to show there', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    expect(pill.visible).toBe(false);
    pill.setStyle('pill');
    expect(pill.visible).toBe(true);
    expect(vt(pill).hidden).toBe(false);
  });

  it('entering minimal hides an idle pill', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setStyle('minimal');
    expect(pill.visible).toBe(false);
    expect(vt(pill).hidden).toBe(true);
  });

  it('minimal: processing swaps bars for dots', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    expect(mini(pill).dataset.state).toBe('recording');
    expect(mini(pill).getAttribute('role')).toBe('img');
    expect(mini(pill).getAttribute('aria-label')).toBe('VoiceType is recording');
    pill.setState('processing');
    expect(mini(pill).dataset.state).toBe('processing');
    expect(mini(pill).getAttribute('aria-label')).toBe('VoiceType is processing');
    expect(CSS_TEXT).toMatch(/\.mini\[data-state='processing'\] :is\(\.levels, \.mini-time\) \{\s*display: none;\s*\}/);
    expect(CSS_TEXT).toMatch(/\.mini\[data-state='processing'\] \.mini-dots \{[^}]*vt-pulse/);
  });

  it('the indicator holds four level bars, the dots and the time, hidden from assistive tech', () => {
    const { pill } = minimal();
    pill.mount();
    expect(mini(pill).querySelectorAll('.levels .lvl')).toHaveLength(4);
    expect(q(pill, '.levels').getAttribute('aria-hidden')).toBe('true');
    expect(q(pill, '.mini-dots').getAttribute('data-icon')).toBe('dots');
    expect(q(pill, '.mini-time').getAttribute('aria-hidden')).toBe('true');
  });

  it('minimal: elapsed time counts on the indicator', () => {
    vi.useFakeTimers();
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    expect(q(pill, '.mini-time').textContent).toBe('00:00');
    vi.advanceTimersByTime(2000);
    expect(q(pill, '.mini-time').textContent).toBe('00:02');
  });

  it('elapsedMs starts the clock there', () => {
    vi.useFakeTimers();
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording', { elapsedMs: 65000 });
    expect(q(pill, '.mini-time').textContent).toBe('01:05');
    expect(q(pill, '.rec-label').textContent).toBe('01:05');
    vi.advanceTimersByTime(2000);
    expect(q(pill, '.mini-time').textContent).toBe('01:07');
  });

  it('a non-finite elapsedMs starts the clock at zero', () => {
    vi.useFakeTimers();
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording', { elapsedMs: Number.NaN });
    expect(q(pill, '.mini-time').textContent).toBe('00:00');
  });

  it('elapsedMs does not move a clock already running', () => {
    vi.useFakeTimers();
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    vi.advanceTimersByTime(2000);
    pill.setState('recording', { elapsedMs: 65000 });
    vi.advanceTimersByTime(1000);
    expect(q(pill, '.mini-time').textContent).toBe('00:03');
  });

  it.each(['idle', 'done', 'error'])('minimal: a status shows without an indicator, centred, in its place (%s)', (state) => {
    const { pill } = minimal();
    pill.show(FIELD);
    statusEl(pill).getBoundingClientRect = STATUS_200;
    pill.setStatus('Done', { tone: 'success', sticky: true });
    pill.setState(state);
    expect(statusEl(pill).dataset.side).toBe('above');
    expect(statusEl(pill).style.left).toBe('412px');
    expect(statusEl(pill).style.top).toBe('752px');
  });

  it.each(['recording', 'processing'])('minimal: a status while %s sits above the indicator', (state) => {
    const { pill } = minimal();
    pill.show(FIELD);
    statusEl(pill).getBoundingClientRect = STATUS_200;
    pill.setState(state);
    pill.setStatus('Almost at the limit', { tone: 'warning', sticky: true });
    expect(statusEl(pill).dataset.side).toBe('above');
    expect(statusEl(pill).style.left).toBe('412px');
    expect(statusEl(pill).style.top).toBe('718px');
  });

  describe('reserveIndicator', () => {
    /** A Minimal pill at a field with a status up and no recording of its own. */
    function withStatus() {
      const { pill } = minimal();
      pill.show(FIELD);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setStatus('Busy', { tone: 'error', sticky: true });
      return pill;
    }

    it('lifts a status above the indicator, and takes it back', () => {
      const pill = withStatus();
      expect(statusEl(pill).style.top).toBe('752px');
      pill.reserveIndicator(true);
      expect(statusEl(pill).dataset.side).toBe('above');
      expect(statusEl(pill).style.left).toBe('412px');
      expect(statusEl(pill).style.top).toBe('718px');
      pill.reserveIndicator(false);
      expect(statusEl(pill).style.top).toBe('752px');
    });

    it('applies to a status that comes later', () => {
      const { pill } = minimal();
      pill.reserveIndicator(true);
      pill.show(FIELD);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setStatus('Busy', { tone: 'error', sticky: true });
      expect(statusEl(pill).style.top).toBe('718px');
    });

    it('draws no indicator of its own', () => {
      const pill = withStatus();
      pill.reserveIndicator(true);
      expect(mini(pill).dataset.state).toBe('idle');
    });

    it('shows nothing with nothing to show', () => {
      const { pill } = minimal();
      pill.show(FIELD);
      pill.reserveIndicator(true);
      expect(vt(pill).hidden).toBe(true);
      expect(pill.visible).toBe(false);
    });

    it.each(['pill', 'dot'])('leaves %s as it is', (style) => {
      const place = (reserved) => {
        const { pill } = makePill();
        pill.setStyle(style);
        pill.show(FIELD);
        statusEl(pill).getBoundingClientRect = STATUS_200;
        pill.setStatus('Busy', { tone: 'error', sticky: true });
        pill.reserveIndicator(reserved);
        return { pill: at(q(pill, '.pill')), status: at(statusEl(pill)), side: statusEl(pill).dataset.side };
      };
      expect(place(true)).toEqual(place(false));
    });

    it('is inert after destroy', () => {
      const pill = withStatus();
      pill.destroy();
      expect(() => pill.reserveIndicator(true)).not.toThrow();
    });
  });

  it('minimal: a status too wide for a small viewport stays inside it', () => {
    const { innerWidth } = window;
    window.innerWidth = 150;
    try {
      const { pill } = minimal();
      pill.show(FIELD);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setStatus('Hello', { sticky: true });
      expect(statusEl(pill).style.left).toBe(`${EDGE}px`);
    } finally {
      window.innerWidth = innerWidth;
    }
  });

  it('minimal: openMenu does nothing', () => {
    const { pill, h } = minimal();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.setState('recording');
    pill.openMenu();
    expect(pill.menuOpen).toBe(false);
    expect(q(pill, '.menu').hidden).toBe(true);
    expect(h.onMenuOpen).not.toHaveBeenCalled();
  });

  it("setStyle('minimal') closes an open menu", () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.openMenu();
    pill.setStyle('minimal');
    expect(pill.menuOpen).toBe(false);
    expect(q(pill, '.menu').hidden).toBe(true);
  });

  it('minimal: a clickable status calls onStatusClick', () => {
    const { pill, h } = minimal();
    pill.show(FIELD);
    pill.setStatus('Could not insert. Click here to copy the text.', { tone: 'error', sticky: true, clickable: true });
    statusEl(pill).click();
    expect(h.onStatusClick).toHaveBeenCalledTimes(1);
  });

  it('CSS: a plain status takes no pointer in minimal', () => {
    expect(CSS_TEXT).toMatch(/\.vt\[data-style='minimal'\] \.status:not\(\[data-clickable\]\) \{\s*pointer-events: none;\s*\}/);
  });

  it('CSS: the indicator takes no pointer', () => {
    expect(CSS_TEXT.match(/^\.mini \{[^}]*\}/m)[0]).toMatch(/\bpointer-events: none;/);
  });

  it('CSS: reduced motion keeps the bars static', () => {
    const reduced = CSS_TEXT.slice(CSS_TEXT.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.lvl \{\s*transform: none !important;\s*\}/);
  });

  it('setStyle while recording keeps the state and the clock', () => {
    vi.useFakeTimers();
    const { pill } = makePill();
    pill.show(FIELD);
    pill.setState('recording');
    vi.advanceTimersByTime(2000);
    pill.setStyle('minimal');
    vi.advanceTimersByTime(1000);
    expect(q(pill, '.pill').dataset.state).toBe('recording');
    expect(mini(pill).dataset.state).toBe('recording');
    expect(q(pill, '.mini-time').textContent).toBe('00:03');
    expect(vi.getTimerCount()).toBe(1);
    pill.setStyle('pill');
    vi.advanceTimersByTime(1000);
    expect(q(pill, '.rec-label').textContent).toBe('00:04');
  });

  it('setLevel reaches the indicator', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setState('recording');
    pill.setLevel(0.5);
    expect(mini(pill).style.getPropertyValue('--vt-level')).toBe('0.5');
    expect(q(pill, '.pill').style.getPropertyValue('--vt-level')).toBe('0.5');
    pill.setState('processing');
    expect(mini(pill).style.getPropertyValue('--vt-level')).toBe('0');
  });

  it('right-to-left: placement does not depend on the page direction', () => {
    const placed = (dir, style) => {
      document.documentElement.dir = dir;
      const { pill } = makePill();
      pill.setStyle(style);
      pill.show(FIELD);
      pill.setState('recording');
      const box = at(q(pill, style === 'minimal' ? '.mini' : '.pill'));
      pill.destroy();
      return box;
    };
    try {
      for (const style of ['pill', 'dot', 'minimal']) expect(placed('rtl', style), style).toEqual(placed('ltr', style));
    } finally {
      document.documentElement.dir = '';
    }
    expect(CSS_TEXT.match(/^\.vt \{([^}]*)\}/m)[1]).toMatch(/^\s*direction: ltr;$/m);
  });

  describe('a window resize', () => {
    const { innerHeight } = window;
    const resizeTo = (height) => {
      window.innerHeight = height;
      window.dispatchEvent(new Event('resize'));
    };

    afterEach(() => {
      window.innerHeight = innerHeight;
    });

    it("moves Minimal's indicator", () => {
      const { pill } = minimal();
      pill.show(FIELD);
      pill.setState('recording');
      resizeTo(500);
      expect(mini(pill).style.top).toBe('456px');
    });

    it('moves a pill at the corner', () => {
      const { pill } = makePill();
      pill.show(null);
      resizeTo(500);
      expect(q(pill, '.pill').style.top).toBe('454px');
    });

    it('leaves a pill at a field to its watcher, so an open menu stays open', () => {
      const { pill } = makePill();
      pill.renderMenu(settings(), null);
      pill.show(BOTTOM_FIELD);
      pill.openMenu();
      resizeTo(500);
      expect(pill.menuOpen).toBe(true);
    });

    it('moves the status with what it sits on', () => {
      const { pill } = minimal();
      pill.show(FIELD);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setState('recording');
      pill.setStatus('Almost at the limit', { sticky: true });
      resizeTo(500);
      expect(statusEl(pill).style.top).toBe('450px');
    });

    it('leaves a hidden pill hidden', () => {
      const { pill } = makePill();
      pill.show(null);
      pill.hide();
      resizeTo(500);
      expect(vt(pill).hidden).toBe(true);
      expect(pill.visible).toBe(false);
    });

    it('stops reaching a destroyed pill', () => {
      const add = vi.spyOn(window, 'addEventListener');
      const remove = vi.spyOn(window, 'removeEventListener');
      const { pill } = makePill();
      pill.show(null);
      const listener = add.mock.calls.find(([type]) => type === 'resize')?.[1];
      expect(listener).toBeTypeOf('function');
      pill.destroy();
      expect(remove).toHaveBeenCalledWith('resize', listener);
      add.mockRestore();
      remove.mockRestore();
    });
  });

  describe('a status by the field in a subframe', () => {
    /** Beside the field, then beside it with no room on the left, then above it, then below it. */
    const ANCHORS = [
      ['left', { top: 300, left: 400, width: 200, height: 30 }],
      ['right', { top: 300, left: 40, width: 200, height: 30 }],
      ['above', { top: 300, left: 40, width: 960, height: 30 }],
      ['below', { top: 10, left: 40, width: 960, height: 30 }],
    ];
    const OUT_OF_VIEW = { top: 2000, left: 400, width: 200, height: 30 };

    /** A pill with the status up: Minimal in a subframe unless the options say otherwise. */
    function statusAt(anchor, { style = 'minimal', statusAtField = true, h = handlers(), status = {} } = {}) {
      const pill = new Pill(h, { shadowMode: 'open', statusAtField });
      pill.setStyle(style);
      pill.show(anchor);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setStatus('Add an API key in VoiceType settings.', { tone: 'error', sticky: true, ...status });
      return pill;
    }
    const placed = (pill) => {
      const { top, left } = statusEl(pill).style;
      return { top, left, side: statusEl(pill).dataset.side };
    };

    it.each(ANCHORS)('takes the side and alignment Dot uses: %s', (_, anchor) => {
      expect(placed(statusAt(anchor))).toEqual(placed(statusAt(anchor, { style: 'dot', statusAtField: false })));
    });

    it('sits at the field, far from the bottom centre', () => {
      const pill = statusAt(ANCHORS[0][1]);
      expect(statusEl(pill).dataset.side).toBe('below');
      expect(statusEl(pill).style.top).toBe('336px');
    });

    it('with no anchor it stays at the bottom centre', () => {
      expect(placed(statusAt(null))).toEqual(placed(statusAt(null, { statusAtField: false })));
      expect(statusEl(statusAt(null)).style.top).toBe('752px');
    });

    it('with the anchor out of view it stays at the bottom centre', () => {
      expect(placed(statusAt(OUT_OF_VIEW))).toEqual(placed(statusAt(OUT_OF_VIEW, { statusAtField: false })));
      expect(statusEl(statusAt(OUT_OF_VIEW)).style.top).toBe('752px');
    });

    it('with the option off it stays at the bottom centre, the frame 0 rule', () => {
      const pill = statusAt(ANCHORS[0][1], { statusAtField: false });
      expect(statusEl(pill).style.left).toBe('412px');
      expect(statusEl(pill).style.top).toBe('752px');
    });

    it('is off by default', () => {
      const { pill } = minimal();
      pill.show(ANCHORS[0][1]);
      statusEl(pill).getBoundingClientRect = STATUS_200;
      pill.setStatus('Hello', { sticky: true });
      expect(statusEl(pill).style.top).toBe('752px');
    });

    it('follows the field, and falls back when the field leaves the view', () => {
      const pill = statusAt(ANCHORS[0][1]);
      pill.reposition({ ...ANCHORS[0][1], top: 100 });
      expect(statusEl(pill).style.top).toBe('136px');
      pill.reposition(OUT_OF_VIEW);
      expect(statusEl(pill).style.top).toBe('752px');
    });

    it('leaves the indicator at the bottom centre', () => {
      const pill = statusAt(ANCHORS[0][1]);
      pill.setState('recording');
      expect(q(pill, '.mini').style.top).toBe(INDICATOR.top);
      expect(q(pill, '.mini').style.left).toBe(INDICATOR.left);
      expect(statusEl(pill).style.top).toBe('336px');
    });

    it('stays clickable', () => {
      const h = handlers();
      const pill = statusAt(ANCHORS[0][1], { h, status: { clickable: true } });
      expect(statusEl(pill).hasAttribute('data-clickable')).toBe(true);
      statusEl(pill).click();
      expect(h.onStatusClick).toHaveBeenCalledTimes(1);
    });

    it.each(['pill', 'dot'])('%s does not change', (style) => {
      const [, anchor] = ANCHORS[0];
      expect(placed(statusAt(anchor, { style }))).toEqual(placed(statusAt(anchor, { style, statusAtField: false })));
    });
  });

  describe('a status in a short frame', () => {
    const { innerHeight } = window;
    const TALL = 58; // two lines

    afterEach(() => {
      window.innerHeight = innerHeight;
    });

    /** The status of a pill of `style` at `height` tall in a frame `frame` tall. */
    function statusIn(frame, height, { style = 'minimal', state = 'idle' } = {}) {
      window.innerHeight = frame;
      const { pill } = makePill();
      pill.setStyle(style);
      pill.show(null);
      statusEl(pill).getBoundingClientRect = rect(STATUS_200().width, height);
      pill.setState(state);
      pill.setStatus('Hello', { sticky: true });
      return statusEl(pill);
    }

    describe.each([[30, 29], [30, TALL], [60, 29], [60, TALL]])('%i px, a status %i px tall', (frame, height) => {
      it.each(['idle', 'done', 'recording', 'processing'])('minimal keeps its bottom edge inside (%s)', (state) => {
        const status = statusIn(frame, height, { state });
        expect(status.dataset.side).toBe('above');
        expect(pxValue(status.style.top)).toBeLessThanOrEqual(frame - EDGE);
      });
    });

    it.each([['idle', '752px'], ['recording', '718px']])('a 768 px frame is unchanged (%s)', (state, top) => {
      const status = statusIn(768, 29, { state });
      expect(status.dataset.side).toBe('above');
      expect(status.style.top).toBe(top);
    });

    it.each(['pill', 'dot'])('%s placement does not change', (style) => {
      const status = statusIn(30, 29, { style });
      expect(status.dataset.side).toBe('above');
      expect(status.style.top).toBe(`${EDGE + 40}px`);
    });
  });

  it('a user string in a status is text', () => {
    const { pill } = minimal();
    pill.show(FIELD);
    pill.setStatus(HOSTILE, { tone: 'error', sticky: true });
    expect(statusEl(pill).textContent).toBe(HOSTILE);
    expect(q(pill, '.status img')).toBeNull();
  });
});

describe('sight', () => {
  /** @type {{ callback: (entries: object[]) => void, options: object, targets: Element[], disconnect: import('vitest').Mock }[]} */
  let observers;

  class FakeObserver {
    targets = [];
    disconnect = vi.fn();

    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      observers.push(this);
    }

    observe(el) {
      this.targets.push(el);
    }
  }

  const entry = (seen, ratio = seen ? 1 : 0) => ({ isIntersecting: seen, intersectionRatio: ratio });
  const report = (...entries) => observers.at(-1).callback(entries);

  function watched() {
    const onSight = vi.fn();
    const pill = new Pill({ ...handlers(), onSight }, { shadowMode: 'open' });
    pill.show(null);
    return { pill, onSight };
  }

  beforeEach(() => {
    observers = [];
    window.IntersectionObserver = FakeObserver;
  });

  afterEach(() => {
    delete window.IntersectionObserver;
  });

  it('no handler, no observer', () => {
    const { pill } = makePill();
    pill.show(null);
    pill.setState('recording');
    pill.setStyle('minimal');
    expect(observers).toEqual([]);
  });

  it('watches only while recording or processing', () => {
    const { pill } = watched();
    expect(observers).toEqual([]);
    pill.setState('recording');
    expect(observers).toHaveLength(1);
    pill.setState('processing');
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnect).not.toHaveBeenCalled();
    pill.setState('idle');
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it.each(['done', 'error'])('stops watching at %s: statuses stay in the frame', (state) => {
    const { pill } = watched();
    pill.setState('processing');
    pill.setState(state);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('watches the element that shows', () => {
    const { pill } = watched();
    pill.setState('recording');
    expect(observers[0].targets).toEqual([q(pill, '.pill')]);
    pill.setStyle('minimal');
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(observers[1].targets).toEqual([q(pill, '.mini')]);
    pill.setStyle('pill');
    expect(observers[2].targets).toEqual([q(pill, '.pill')]);
  });

  it('starts on .mini when Minimal is set first', () => {
    const { pill } = watched();
    pill.setStyle('minimal');
    expect(observers).toEqual([]);
    pill.setState('recording');
    expect(observers[0].targets).toEqual([q(pill, '.mini')]);
  });

  it('keeps its observer when a style change leaves the same element', () => {
    const { pill } = watched();
    pill.setStyle('pill');
    pill.setState('recording');
    pill.setStyle('dot');
    expect(observers).toHaveLength(1);
    expect(observers[0].disconnect).not.toHaveBeenCalled();
  });

  it('threshold is SIGHT_THRESHOLD, and it tracks visibility as often as the browser allows', () => {
    const { pill } = watched();
    pill.setState('recording');
    expect(SIGHT_THRESHOLD).toBe(0.5);
    expect(SIGHT_DELAY_MS).toBe(100);
    expect(observers[0].options).toEqual({ threshold: SIGHT_THRESHOLD, trackVisibility: true, delay: SIGHT_DELAY_MS });
  });

  it('in the viewport but reported not visible counts as out of sight', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report({ ...entry(true), isVisible: false });
    expect(onSight.mock.calls).toEqual([[false]]);
    report({ ...entry(true), isVisible: true });
    expect(onSight.mock.calls).toEqual([[false], [true]]);
  });

  it('a browser with no isVisible judges by the viewport alone', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report(entry(false));
    report(entry(true));
    expect(onSight.mock.calls).toEqual([[false], [true]]);
  });

  it('reports only changes', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    for (const seen of [true, true, false, false, true]) report(entry(seen));
    expect(onSight.mock.calls).toEqual([[false], [true]]);
  });

  it('takes the last entry of a batch', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report(entry(false), entry(true));
    expect(onSight).not.toHaveBeenCalled();
    report(entry(true), entry(false));
    expect(onSight.mock.calls).toEqual([[false]]);
  });

  it('counts an element under the threshold as out of sight', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report(entry(true, SIGHT_THRESHOLD - 0.01));
    expect(onSight.mock.calls).toEqual([[false]]);
    report(entry(true, SIGHT_THRESHOLD));
    expect(onSight.mock.calls).toEqual([[false], [true]]);
  });

  it('a new recording starts from seen', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report(entry(false));
    pill.setState('idle');
    pill.setState('recording');
    report(entry(true));
    expect(onSight.mock.calls).toEqual([[false]]);
    report(entry(false));
    expect(onSight.mock.calls).toEqual([[false], [false]]);
  });

  it('a retarget during a recording keeps what was reported', () => {
    const { pill, onSight } = watched();
    pill.setState('recording');
    report(entry(false));
    pill.setStyle('minimal');
    report(entry(false));
    expect(onSight.mock.calls).toEqual([[false]]);
  });

  it('destroy disconnects', () => {
    const { pill } = watched();
    pill.setState('recording');
    pill.destroy();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('page isolation', () => {
  it('prevents the default of every mousedown inside the root', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.openMenu();
    for (const selector of ['.rec', '.more', '[data-mode="default"]', '[role="status"]']) {
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
      q(pill, selector).dispatchEvent(down);
      expect(down.defaultPrevented, selector).toBe(true);
    }
    const outside = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(outside);
    expect(outside.defaultPrevented).toBe(false);
  });

  it('calls onRec from the REC button', () => {
    const { pill, h } = makePill();
    pill.show(FIELD);
    q(pill, '.rec').click();
    expect(h.onRec).toHaveBeenCalledTimes(1);
  });

  it('pins text direction on .vt so an rtl page cannot flip the pill', () => {
    const vtRule = CSS_TEXT.match(/^\.vt \{([^}]*)\}/m)[1];
    expect(vtRule).toMatch(/^\s*direction: ltr;$/m);
    expect(vtRule).toMatch(/^\s*unicode-bidi: isolate;$/m);
  });

  it('never uses an HTML string sink', () => {
    const source = read('../../../src/content/pill.js');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('destroy', () => {
  it('clears every timer, removes the host and turns later calls into no-ops', () => {
    vi.useFakeTimers();
    const { pill, h } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(FIELD);
    pill.setState('recording');
    pill.setStatus('Hello', { tone: 'info' });
    pill.openMenu();
    expect(vi.getTimerCount()).toBe(2);
    const host = pill.host;
    pill.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(host.isConnected).toBe(false);
    expect(pill.visible).toBe(false);
    expect(pill.menuOpen).toBe(false);
    pill.show(FIELD);
    pill.setStatus('Again', { tone: 'error' });
    pill.setState('recording');
    expect(vi.getTimerCount()).toBe(0);
    expect(document.documentElement.querySelector('voicetype-host')).toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(h.onMenuOpen).toHaveBeenCalledTimes(1);
  });
});
