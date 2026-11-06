// End-to-end coverage for site rules in the built extension: a hidden site in every frame, the
// hotkey on it, a site mode across frames, the pill menu, the popup and the Sites page acting
// on an open tab, and the popup's size. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { freshSettings } from '../../src/shared/defaults.js';
import { siteKey } from '../../src/shared/sites.js';
import { SITE_KEYS } from '../fixtures/site-keys.js';
import {
  launchExtension, seedSettings, openFields, pillQuery, pillStatus, waitForPill, clickPill, focusField,
  indicatorShown, startWithHotkey, dictateWithHotkey, PORT, TRANSCRIPT, DUMMY_KEY, STOP, MINI, HOTKEY, RECORD_MS,
} from './helpers.js';
import { decodePng } from './png.js';

const REFINED = 'refined transcript';
const HIDE_ONLY = Object.freeze({ hidePill: true, mode: null });
const EMAIL_SITE = Object.freeze({ hidePill: false, mode: 'email' });
const OTHER_HOST_RULE = Object.freeze({ hidePill: true, mode: 'email' });
/** How long a field stays clicked before the pill counts as not coming. */
const NO_PILL_MS = 500;
/** The acceptance budget of a change made in the popup. */
const PILL_SYNC_MS = 1000;
/** Longer than the success status (2.5 s) that keeps the pill up after a dictation. */
const STATUS_GONE_MS = 5000;
const TAG = '.item-tag';
const MODE_BUTTON = 'button.mode';
const USE_ACTIVE = '[data-use-active]';
/** See frames.spec.js: a click right after a scroll can miss an out-of-process frame. */
const VIEWPORT = { width: 1280, height: 2000 };
/** The popup's width, and the height it stays under with a site and a key (V77). */
const POPUP_WIDTH = 320;
const POPUP_MAX_HEIGHT = 460;
/** Chrome stops a popup growing at this height, and shows a scrollbar past it. */
const POPUP_CAP_HEIGHT = 600;
/** Chromium maps every *.localhost name to the loopback the fixture server listens on. */
const LONG_HOST = 'a-very-long-site-name-for-the-popup-to-trim.example.localhost';
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;
const SAME_ORIGIN_FRAME = `http://localhost:${PORT}/frame.html`;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
/** @type {{ method: string, auth: string|null }[]} */
let providerCalls = [];
/** @type {{ instructions: string, input: string }[]} */
let refineCalls = [];
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, extensionId, providerCalls, refineCalls, close } = await launchExtension({ refineText: REFINED }));
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(() => {
  providerCalls.length = 0;
  refineCalls.length = 0;
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind; the launch page stays.
  for (const page of context.pages()) {
    if (/^(http|chrome-extension):/.test(page.url())) await page.close();
  }
});

const extensionUrl = (path) => `chrome-extension://${extensionId}/${path}`;

/** @param {Record<string, { hidePill: boolean, mode: string|null }>} siteRules */
const seedRules = (siteRules) => seedSettings(serviceWorker, DUMMY_KEY, { siteRules });

/** The stored settings, as the service worker reads them. */
const storedSettings = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

const storedRules = async () => (await storedSettings()).siteRules;

/** The fixture page with real focus and nothing below the fold. */
async function openPage() {
  const page = await openFields(context, { focusEmulation: false });
  await page.setViewportSize(VIEWPORT);
  return page;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} url
 */
async function frameAt(page, url) {
  await expect.poll(() => page.frames().some((f) => f.url() === url), { message: `frame ${url}` }).toBe(true);
  return page.frames().find((f) => f.url() === url);
}

/** @param {import('@playwright/test').Page|import('@playwright/test').Frame} target */
async function pillShown(target) {
  const box = await pillQuery(target, '.body');
  return Boolean(box && box.width > 0 && box.height > 0);
}

/** @param {import('@playwright/test').Page} page */
const openMenu = (page) => clickPill(page, MODE_BUTTON);

/**
 * The popup as a tab behind the fixture: a background tab's `{ active: true, currentWindow: true }`
 * is the fixture tab, so the real code path runs.
 * @param {import('@playwright/test').Page} fixture
 */
async function openPopupOver(fixture) {
  const popup = await context.newPage();
  await popup.goto(extensionUrl('popup.html'));
  await fixture.bringToFront();
  await popup.reload();
  return popup;
}

/** The settings page at Sites, with the stored settings loaded. */
async function openSitesPage() {
  const page = await context.newPage();
  await page.goto(extensionUrl('options.html#settings/sites'));
  await expect(page.locator('#site-add-mode option[value="email"]')).toBeAttached();
  await expect(page.locator('#banner')).toBeHidden();
  return page;
}

test('a hidden site shows no idle pill in the top frame or its iframes', async () => {
  await seedRules({ localhost: HIDE_ONLY });
  const page = await openPage();
  const frames = [await frameAt(page, CROSS_ORIGIN_FRAME), await frameAt(page, SAME_ORIGIN_FRAME)];
  const targets = [
    { target: page, field: page.locator('#ta') },
    ...frames.map((frame) => ({ target: frame, field: frame.locator('#frame-ta') })),
  ];

  for (const { target, field } of targets) {
    await field.click();
    await page.waitForTimeout(NO_PILL_MS);
    expect(await pillShown(target)).toBe(false);
    expect(await indicatorShown(target)).toBe(false);
  }

  // The same clicks show the pill once the rule is gone, so the checks above are not vacuous.
  await seedRules({});
  for (const { target, field } of targets) await focusField(target, field);
});

test('the hotkey records on a hidden site with a visible indicator', async () => {
  await seedRules({ localhost: HIDE_ONLY });
  const page = await openPage();
  const textarea = page.locator('#ta');
  await textarea.click();
  expect(await indicatorShown(page)).toBe(false);

  await startWithHotkey(page, page, { indicator: MINI });

  const indicator = await pillQuery(page, MINI);
  expect(indicator.width).toBe(92);
  expect(Math.abs(indicator.x - VIEWPORT.width / 2)).toBeLessThanOrEqual(1);
  expect((await pillQuery(page, STOP))?.width ?? 0).toBe(0);

  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);

  await expect(textarea).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  await expect.poll(() => pillStatus(page), { timeout: STATUS_GONE_MS }).toBe('');
  expect(await indicatorShown(page)).toBe(false);
});

for (const [name, siteRules, indicator] of [['a hidden site', { localhost: HIDE_ONLY }, MINI], ['a normal site', {}, STOP]]) {
  test(`a recording with its field scrolled out shows the pill on ${name}`, async () => {
    await seedRules(siteRules);
    const page = await openPage();
    await page.locator('#ta').click();
    await page.evaluate(() => {
      document.body.style.paddingBottom = '8000px';
      window.scrollTo(0, 6000);
    });

    await startWithHotkey(page, page, { indicator });

    expect(await page.evaluate(() => document.activeElement.id)).toBe('ta');
    await waitForPill(page, indicator);
  });
}

test('a site mode applies to a dictation started in a cross-origin iframe', async () => {
  await seedRules({ localhost: EMAIL_SITE });
  const page = await openPage();
  const frame = await frameAt(page, CROSS_ORIGIN_FRAME);
  const field = frame.locator('#frame-ta');
  await focusField(frame, field);

  await dictateWithHotkey(page, frame);

  await expect(field).toHaveValue(REFINED);
  expect(refineCalls).toHaveLength(1);
  expect(refineCalls[0].instructions).toBe(freshSettings().modes.email.prompt);
  expect(refineCalls[0].input).toBe(TRANSCRIPT);
  expect((await storedSettings()).activeMode).toBe('default');
});

test('a hide-only rule leaves the mode global', async () => {
  await seedRules({ localhost: HIDE_ONLY });
  const page = await openPage();
  const frame = await frameAt(page, CROSS_ORIGIN_FRAME);
  const field = frame.locator('#frame-ta');
  await field.click();

  await dictateWithHotkey(page, frame, { indicator: MINI });

  await expect(field).toHaveValue(TRANSCRIPT);
  expect(providerCalls).toHaveLength(1);
  expect(refineCalls).toHaveLength(0);
});

test('the pill marks the site mode and Use active mode clears the rule', async () => {
  await seedRules({ localhost: EMAIL_SITE });
  const page = await openFields(context);
  await focusField(page, page.locator('#ta'));

  await openMenu(page);
  const tag = await waitForPill(page, `[data-mode="email"] ${TAG}`);
  expect(tag.text).toBe('This site');

  await clickPill(page, USE_ACTIVE);

  await expect.poll(storedRules).toEqual({});
  await expect.poll(() => pillQuery(page, TAG)).toBeNull();
  expect(await pillQuery(page, USE_ACTIVE)).toBeNull();
  expect(await pillQuery(page, 'button[aria-label^="Mode: Default."]')).not.toBeNull();
});

test('picking a mode in the pill updates the site, not the global mode', async () => {
  await seedRules({ localhost: EMAIL_SITE });
  const page = await openFields(context);
  await focusField(page, page.locator('#ta'));

  await openMenu(page);
  await clickPill(page, '[data-mode="translate"]');

  await expect.poll(storedRules).toEqual({ localhost: { hidePill: false, mode: 'translate' } });
  await expect.poll(() => pillQuery(page, `[data-mode="translate"] ${TAG}`)).not.toBeNull();
  expect((await storedSettings()).activeMode).toBe('default');
});

test('the popup hides the pill on the open page within a second', async () => {
  await seedRules({ localhost: EMAIL_SITE });
  const fixture = await openFields(context);
  await focusField(fixture, fixture.locator('#ta'));

  const popup = await openPopupOver(fixture);
  await expect(popup.locator('#site-host')).toHaveText('localhost');
  await expect(popup.locator('#site-unavailable')).toBeHidden();
  await expect(popup.locator('#site-mode')).toHaveValue('email');
  await expect(popup.locator('#site-hide')).not.toBeChecked();
  expect(await pillShown(fixture)).toBe(true);

  await popup.locator('#site-hide').check();

  await expect.poll(() => pillShown(fixture), { timeout: PILL_SYNC_MS }).toBe(false);
  expect(await storedRules()).toEqual({ localhost: { hidePill: true, mode: 'email' } });
});

test('the popup is under 460 px tall at 320 px, with a long site name on one line and no sideways scroll', async () => {
  await seedRules({});
  const fixture = await openFields(context);
  await fixture.goto(`http://${LONG_HOST}:${PORT}/fields.html`);
  const popup = await openPopupOver(fixture);
  await popup.setViewportSize({ width: POPUP_WIDTH, height: 800 });
  await expect(popup.locator('#site-host')).toHaveText(LONG_HOST);
  await expect(popup.locator('#status-ready')).toBeVisible();

  const layout = await popup.evaluate(() => {
    const box = (id) => document.getElementById(id).getBoundingClientRect();
    const host = document.getElementById('site-host');
    const middle = (id) => box(id).top + box(id).height / 2;
    return {
      height: document.body.getBoundingClientRect().height,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      title: host.title,
      cut: host.scrollWidth > host.clientWidth,
      hostHeight: box('site-host').height,
      lineHeight: parseFloat(getComputedStyle(host).lineHeight),
      hostMiddle: middle('site-host'),
      hideMiddle: middle('site-hide'),
      modeMiddle: middle('site-mode'),
    };
  });
  expect(layout.height).toBeLessThan(POPUP_MAX_HEIGHT);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.title).toBe(LONG_HOST);
  expect(layout.cut).toBe(true);
  expect(layout.hostHeight).toBeLessThanOrEqual(layout.lineHeight + 1);
  expect(Math.abs(layout.hideMiddle - layout.hostMiddle)).toBeLessThan(layout.lineHeight);
  expect(Math.abs(layout.modeMiddle - layout.hostMiddle)).toBeLessThan(layout.lineHeight);
});

/**
 * Stores dictations as the worker would, newest first.
 * @param {string[]} texts
 */
const seedHistory = (texts) => serviceWorker.evaluate(
  (list) => chrome.storage.session.set({ history: list.map((text, i) => ({ id: `e${i}`, raw: text, text, mode: 'default', host: null, ts: Date.now() - i })) }),
  texts,
);

const clearHistory = () => serviceWorker.evaluate(() => chrome.storage.session.remove('history'));

test('the open list of 5 dictations fits the popup at 320 px with no scrollbar, one line a row, and the arrow shares Copy last\'s border', async () => {
  await seedRules({});
  await seedHistory([
    `a long first line ${'that runs on '.repeat(40)}`, 'two\nlines', 'three', 'four', 'five', 'six, past the newest 5',
  ]);
  try {
    const fixture = await openFields(context);
    await fixture.goto(`http://${LONG_HOST}:${PORT}/fields.html`);
    const popup = await openPopupOver(fixture);
    await popup.setViewportSize({ width: POPUP_WIDTH, height: POPUP_CAP_HEIGHT });
    await expect(popup.locator('#site-host')).toHaveText(LONG_HOST);
    const toggle = popup.locator('#recent-toggle');
    await expect(toggle).toBeVisible();

    const joint = () => popup.evaluate(() => {
      const box = (id) => document.getElementById(id).getBoundingClientRect();
      const copy = getComputedStyle(document.getElementById('copy-last'));
      const arrow = getComputedStyle(document.getElementById('recent-toggle'));
      return {
        gap: box('recent-toggle').left - box('copy-last').right,
        copyRight: [copy.borderTopRightRadius, copy.borderBottomRightRadius],
        arrowLeft: [arrow.borderTopLeftRadius, arrow.borderBottomLeftRadius],
        copyHeight: box('copy-last').height,
        arrowHeight: box('recent-toggle').height,
      };
    });
    const closed = await joint();
    // One border between the two: the arrow's left edge sits 1 px over Copy last's right edge.
    expect(closed.gap).toBe(-1);
    expect(closed.copyRight).toEqual(['0px', '0px']);
    expect(closed.arrowLeft).toEqual(['0px', '0px']);
    expect(closed.arrowHeight).toBe(closed.copyHeight);

    // The ring of a focused Copy last runs over the arrow, and the arrow must not paint over it:
    // 3 px past Copy last's edge, the ring's colour shows, not the arrow's.
    await toggle.focus();
    await popup.keyboard.press('Shift+Tab');
    await expect(popup.locator('#copy-last')).toBeFocused();
    const copyBox = await popup.locator('#copy-last').boundingBox();
    const shot = decodePng(await popup.screenshot());
    const pixel = (x) => {
      const at = (Math.round(copyBox.y + copyBox.height / 2) * shot.width + Math.round(x)) * shot.channels;
      return [...shot.data.subarray(at, at + 3)];
    };
    const edge = copyBox.x + copyBox.width;
    expect(pixel(edge + 3)).not.toEqual(pixel(edge + 8));

    await toggle.click();
    await expect(popup.locator('#recent-list button')).toHaveCount(5);
    const open = await popup.evaluate(() => {
      const rows = [...document.querySelectorAll('#recent-list button')];
      return {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyHeight: document.body.getBoundingClientRect().height,
        heights: rows.map((row) => row.getBoundingClientRect().height),
        cut: rows.map((row) => row.scrollWidth > row.clientWidth),
      };
    });
    expect(open.bodyHeight).toBeLessThan(POPUP_CAP_HEIGHT);
    expect(open.scrollHeight).toBeLessThanOrEqual(open.clientHeight);
    expect(open.scrollWidth).toBeLessThanOrEqual(open.clientWidth);
    expect(new Set(open.heights).size).toBe(1);
    expect(open.cut).toEqual([true, false, false, false, false]);
    // A half turn once the glide ends: the icon points up.
    const turn = () => popup.evaluate(() => getComputedStyle(document.querySelector('#recent-toggle svg')).transform);
    await expect.poll(turn).toBe('matrix(-1, 0, 0, -1, 0, 0)');

    // Copy last is whole again, with its own rounded corners, when the arrow goes.
    await seedHistory(['only one']);
    await expect(toggle).toBeHidden();
    await expect(popup.locator('#recent-list')).toBeHidden();
    expect((await joint()).copyRight).toEqual(['7px', '7px']);

    // Reduced motion keeps the turn and drops the glide.
    await seedHistory(['one', 'two']);
    await expect(toggle).toBeVisible();
    const glide = () => popup.evaluate(() => getComputedStyle(document.querySelector('#recent-toggle svg')).transitionDuration);
    expect(await glide()).not.toBe('0s');
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    expect(await glide()).toBe('0s');
  } finally {
    await clearHistory();
  }
});

test('in forced colours the popup keeps the edge of every control', async () => {
  await seedRules({});
  await seedHistory(['first', 'second']);
  const fixture = await openFields(context);
  const popup = await openPopupOver(fixture);
  await popup.emulateMedia({ forcedColors: 'active' });
  await expect(popup.locator('#site-mode')).toBeVisible();
  await expect(popup.locator('#recent-toggle')).toBeVisible();

  const edges = () => popup.evaluate(() => {
    const canvas = getComputedStyle(document.body).backgroundColor;
    return [...document.querySelectorAll('select, button')].filter((el) => el.offsetParent !== null).map((el) => {
      const style = getComputedStyle(el);
      return {
        id: el.id,
        drawn: style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0 && style.borderTopColor !== canvas,
      };
    });
  });
  const withKey = await edges();
  expect(withKey.map((e) => e.id)).toEqual(['provider', 'active-mode', 'site-mode', 'copy-last', 'recent-toggle', 'open-settings']);
  expect(withKey.filter((e) => !e.drawn)).toEqual([]);

  // The open list keeps the border round it and the hairline between its rows.
  await popup.locator('#recent-toggle').click();
  const list = await popup.evaluate(() => {
    const canvas = getComputedStyle(document.body).backgroundColor;
    const drawn = (el, side) => {
      const style = getComputedStyle(el);
      return style[`border${side}Style`] !== 'none' && parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Color`] !== canvas;
    };
    const items = [...document.querySelectorAll('#recent-list li')];
    return { frame: drawn(document.getElementById('recent-list'), 'Top'), hairline: drawn(items[1], 'Top') };
  });
  expect(list).toEqual({ frame: true, hairline: true });

  // With no key, Add API key takes the place of Ready. The key comes back for the next case.
  await seedSettings(serviceWorker, '');
  try {
    await popup.reload();
    await expect(popup.locator('#add-key')).toBeVisible();
    const withoutKey = await edges();
    expect(withoutKey.map((e) => e.id)).toContain('add-key');
    expect(withoutKey.filter((e) => !e.drawn)).toEqual([]);
  } finally {
    await seedRules({});
    await clearHistory();
  }
});

test('the Sites page adds, edits and removes a rule, and an open tab follows', async () => {
  const other = { 'a.test': OTHER_HOST_RULE };
  await seedRules(other);
  const fixture = await openFields(context);
  await focusField(fixture, fixture.locator('#ta'));
  const page = await openSitesPage();

  const host = page.locator('#site-add-host');
  await host.fill('localhost');
  await host.press('Enter');

  await expect.poll(storedRules).toEqual({ ...other, localhost: HIDE_ONLY });
  await expect.poll(() => pillShown(fixture)).toBe(false);
  await expect(host).toHaveValue('');
  const row = page.locator('#site-table tbody tr', { hasText: 'localhost' });
  await expect(row).toHaveCount(1);

  // The mode first: without Hide pill a rule with no mode is no rule.
  await row.getByLabel('Mode on localhost').selectOption('email');
  await expect.poll(storedRules).toEqual({ ...other, localhost: { hidePill: true, mode: 'email' } });
  await row.getByLabel('Hide pill on localhost').uncheck();

  await expect.poll(storedRules).toEqual({ ...other, localhost: EMAIL_SITE });
  await expect.poll(() => pillShown(fixture)).toBe(true);
  await expect.poll(() => pillQuery(fixture, 'button[aria-label^="Mode: Email, this site."]')).not.toBeNull();

  await row.getByRole('button', { name: 'Remove localhost' }).click();

  await expect.poll(storedRules).toEqual(other);
  await expect(row).toHaveCount(0);
  await expect.poll(() => pillQuery(fixture, 'button[aria-label^="Mode: Default."]')).not.toBeNull();
});

test('a mode pick changes only this site\'s rule', async () => {
  const other = { 'a.test': OTHER_HOST_RULE };
  await seedRules({ ...other, localhost: EMAIL_SITE });
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await dictateWithHotkey(page, page);
  await expect(textarea).toHaveValue(REFINED);
  await openMenu(page);
  await clickPill(page, '[data-mode="translate"]');

  await expect.poll(storedRules).toEqual({ ...other, localhost: { hidePill: false, mode: 'translate' } });
});

test('a stale Sites select leaves a mode picked in the pill alone when Hide pill changes', async () => {
  await seedRules({ localhost: { hidePill: false, mode: 'email' } });
  const fixture = await openFields(context);
  await focusField(fixture, fixture.locator('#ta'));
  const sites = await openSitesPage();
  const row = sites.locator('#site-table tbody tr', { hasText: 'localhost' });
  const select = row.getByLabel('Mode on localhost');
  await select.selectOption('default');
  await expect.poll(storedRules).toEqual({ localhost: { hidePill: false, mode: 'default' } });
  await select.focus();

  await fixture.bringToFront();
  await focusField(fixture, fixture.locator('#ta'));
  await openMenu(fixture);
  await clickPill(fixture, '[data-mode="translate"]');
  await expect.poll(storedRules).toEqual({ localhost: { hidePill: false, mode: 'translate' } });

  await sites.bringToFront();
  await expect(select).toHaveValue('default');
  await row.getByLabel('Hide pill on localhost').check();

  await expect.poll(storedRules).toEqual({ localhost: { hidePill: true, mode: 'translate' } });
});

test('siteKey answers the same in Chromium, whose URL parser is not Node\'s', async () => {
  const page = await openFields(context);
  const inputs = SITE_KEYS.map(([input]) => input);

  const keys = await page.evaluate(({ source, inputs: all }) => {
    const inBrowser = (0, eval)(`(${source})`);
    return all.map((input) => inBrowser(input));
  }, { source: siteKey.toString(), inputs });

  expect(inputs.map((input, i) => [input, keys[i]])).toEqual(SITE_KEYS.map((row) => [...row]));
});

test('the Sites page refuses text that is not a host', async () => {
  const other = { 'a.test': OTHER_HOST_RULE };
  await seedRules(other);
  const page = await openSitesPage();
  const host = page.locator('#site-add-host');

  await host.fill('not a host');
  await host.press('Enter');

  await expect(page.locator('#site-add-error')).toHaveText('Enter a hostname or a URL, such as example.com.');
  await expect(host).toHaveValue('not a host');
  expect(await storedRules()).toEqual(other);
});
