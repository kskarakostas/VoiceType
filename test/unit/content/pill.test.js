// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pill, PILL_SIZE, STATUS_MS, TARGET_LANGUAGES } from '../../../src/content/pill.js';
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
    onMode: vi.fn(), onProvider: vi.fn(), onTargetLang: vi.fn(),
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

/** Asserts the status, `height` px tall, lies fully inside the viewport. "above" is lifted by its own height in CSS. */
function expectStatusOnScreen(pill, height) {
  const el = statusEl(pill);
  const top = parseInt(el.style.top, 10) - (el.dataset.side === 'above' ? height : 0);
  const label = `status ${el.dataset.side} at ${top}`;
  expect(top, label).toBeGreaterThanOrEqual(EDGE);
  expect(top + height, label).toBeLessThanOrEqual(VIEWPORT.height - EDGE);
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
    pill.setStatus('VoiceType was updated. Reload this page.', { tone: 'error', terminal: true });
    pill.setStatus('Done $0.01', { tone: 'success' });
    pill.clearStatus();
    vi.advanceTimersByTime(60000);
    expect(statusEl(pill).textContent).toBe('VoiceType was updated. Reload this page.');
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

    q(pill, '.menu').getBoundingClientRect = rect(248, 300);
    statusEl(pill).getBoundingClientRect = rect(120, 29);
    pill.show(BOTTOM_FIELD);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('above');
    expectStatusOnScreen(pill, 29);
  });

  it('keeps the status on screen for an above pill near the top', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show({ top: 50, left: 100, width: 800, height: 30 });
    statusEl(pill).getBoundingClientRect = rect(120, 29);
    q(pill, '.menu').getBoundingClientRect = rect(248, 300);
    pill.setStatus('Hello');
    expect(q(pill, '.pill').dataset.placement).toBe('above');
    expect(parseInt(q(pill, '.pill').style.top, 10)).toBeLessThan(35);
    expectStatusOnScreen(pill, 29);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('below');
    expectStatusOnScreen(pill, 29);
  });

  it('keeps the status on screen in the corner, with and without the menu', () => {
    const { pill } = makePill();
    pill.renderMenu(settings(), null);
    pill.show(null);
    statusEl(pill).getBoundingClientRect = rect(120, 29);
    q(pill, '.menu').getBoundingClientRect = rect(248, 300);
    pill.setStatus('Hello');
    expect(q(pill, '.pill').dataset.placement).toBe('corner');
    expectStatusOnScreen(pill, 29);
    pill.openMenu();
    expect(q(pill, '.menu').dataset.placement).toBe('above');
    expectStatusOnScreen(pill, 29);
  });

  it('clamps a status that fits on neither side into the viewport', () => {
    const { pill } = makePill();
    pill.show(FIELD);
    statusEl(pill).getBoundingClientRect = rect(300, 740);
    pill.setStatus('A very long message');
    expectStatusOnScreen(pill, 740);
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
