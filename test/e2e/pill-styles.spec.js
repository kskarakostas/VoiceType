// End-to-end coverage of the three pill styles in the built extension: each style on each kind of
// field, the Appearance page acting on an open tab, and the top frame indicator for a recording
// in a frame out of sight. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, pillCall, mirrorQuery, viewportBox, pillStatus, waitForPill, clickPill,
  focusField, indicatorShown, startWithHotkey, dictateWithHotkey, countPixels, PORT, TRANSCRIPT, DUMMY_KEY, STOP, STATUS, MINI,
  HOTKEY, RECORD_MS, RED,
} from './helpers.js';
import { MINI_SIZES, REC_COLORS } from '../../src/shared/defaults.js';
import { computeMiniPosition } from '../../src/content/position.js';

const STYLES = ['pill', 'dot', 'minimal'];
const HOLD = 'Return to the field to insert, or click here to copy.';
const IN_OTHER_FIELD = 'VoiceType is recording in another field of this page. Click back into it to stop.';
const SENTINEL = 'clipboard before the copy';
const HIDE_ONLY = Object.freeze({ hidePill: true, mode: null });
/** Long enough to see processing, and to click into another field meanwhile. */
const TRANSCRIPT_DELAY_MS = 1500;
/** See frames.spec.js: tall enough that no click scrolls. */
const VIEWPORT = { width: 1280, height: 2000 };
/** Set after the click: at scroll 0 both frames of fields.html are below this fold. */
const SHORT_VIEWPORT = { width: 1280, height: 500 };
/** With TALL_FRAME_PX, the bottom centre of the frame is far below the fold. */
const TALL_VIEWPORT = { width: 1280, height: 600 };
const TALL_FRAME_PX = 3000;
/** Where the indicator stands in a tall frame: Minimal by the field, a hidden site at the bottom of the frame. */
const TALL_FRAME_SITES = [
  ['Minimal', { pillStyle: 'minimal' }, 'field'],
  ['a hidden site', { siteRules: { localhost: HIDE_ONLY } }, 'bottom'],
];
/** Table 3 of the 3.3 spec, which a spec cannot import from pill.js: it imports its stylesheet. */
const MINI_BOXES = Object.freeze({
  small: { width: 92, height: 28, bars: 4, barWidth: 3, barHeight: 16, barGap: 2, font: 12 },
  medium: { width: 124, height: 34, bars: 6, barWidth: 4, barHeight: 22, barGap: 3, font: 13 },
  large: { width: 150, height: 40, bars: 8, barWidth: 4, barHeight: 28, barGap: 3, font: 14 },
  xlarge: { width: 184, height: 46, bars: 10, barWidth: 5, barHeight: 34, barGap: 3, font: 15 },
});
/** Table 4: the base colour as the browser computes it, then the tokens as written. */
const REC_LOOKS = Object.freeze({
  red: { rgb: [220, 38, 38], tokens: ['#dc2626', '#b91c1c', '239 68 68'] },
  vampire: { rgb: [219, 45, 74], tokens: ['#db2d4a', '#b9233d', '244 63 94'] },
  obsidian: { rgb: [139, 63, 232], tokens: ['#8b3fe8', '#7429d1', '139 92 246'] },
  emerald: { rgb: [10, 132, 97], tokens: ['#0a8461', '#086c50', '16 185 129'] },
  mocha: { rgb: [160, 96, 58], tokens: ['#a0603a', '#854e2e', '180 120 80'] },
});
const rgbText = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
/** More than the corners of a stray pixel, less than a bar of the smallest indicator at a low level. */
const MIN_COLOUR_PIXELS = 40;
/** Reaches into the 30 px pill and stops short of its centre. */
const EDGE_SHADOW_PX = 10;
/** Longer than the sight observer's delay, or a flip would go unreported. */
const FLIP_BEAT_MS = 200;
const OVERLAY = 'position: fixed; inset: 0; z-index: 2147483646; background: #fff;';
/** How long a field stays clicked before Minimal counts as showing nothing. */
const NO_PILL_MS = 500;
/** The acceptance budget of a change made in the settings. */
const PILL_SYNC_MS = 1000;
const REMOVED_FRAME_MS = 2000;
/** `.body` is wider only with the bar open: STOP alone proves nothing, as it has a box while clipped. */
const OPEN_WIDTH = 130;
const MINI_TIME = '.mini-time';
const CLOCK = /^\d\d:\d\d$/;
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;
const SAME_ORIGIN_FRAME = `http://localhost:${PORT}/frame.html`;
const FRAMES = [
  ['same-origin', SAME_ORIGIN_FRAME, '#same-frame'],
  ['cross-origin', CROSS_ORIGIN_FRAME, '#cross-frame'],
];
const TARGETS = [
  { name: 'a page textarea', field: '#ta', measures: true },
  { name: 'a shadow root input', field: '#shadow-input' },
  { name: 'a same-origin frame', frameUrl: SAME_ORIGIN_FRAME, field: '#frame-ta' },
  { name: 'a cross-origin frame', frameUrl: CROSS_ORIGIN_FRAME, field: '#frame-ta' },
  { name: 'hostile.html', path: 'hostile.html', field: '#hostile-ta', sameSize: true },
  { name: 'rtl.html', path: 'rtl.html', field: '#rtl-ta', sameSize: true },
];

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
/** @type {{ method: string, auth: string|null }[]} */
let providerCalls = [];
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, extensionId, providerCalls, close } = await launchExtension({ transcriptDelayMs: TRANSCRIPT_DELAY_MS }));
  // The page reads the clipboard, and seeds it so that a copy is visible.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(async () => {
  providerCalls.length = 0;
  await seedSettings(serviceWorker, DUMMY_KEY);
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind; the launch page stays.
  for (const page of context.pages()) {
    if (/^(http|chrome-extension):/.test(page.url())) await page.close();
  }
});

/** @param {'pill'|'dot'|'minimal'} pillStyle */
const seedStyle = (pillStyle) => seedSettings(serviceWorker, DUMMY_KEY, { pillStyle });

/**
 * A fixture page with real focus and nothing below the fold.
 * @param {string} [path] another fixture than fields.html
 */
async function openPage(path) {
  const page = await openFields(context, { focusEmulation: false });
  await page.setViewportSize(VIEWPORT);
  if (path) await page.goto(`http://localhost:${PORT}/${path}`);
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

/** @param {import('@playwright/test').Page} page */
const activeId = (page) => page.evaluate(() => document.activeElement?.id ?? '');

/**
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {string} selector
 */
const widthOf = async (target, selector) => (await pillQuery(target, selector))?.width ?? 0;

/** The box once two readings in a row agree: the pill animates between its sizes. */
async function settledBox(target, selector) {
  let last = null;
  let box = null;
  await expect.poll(async () => {
    box = await pillQuery(target, selector);
    const settled = box !== null && box.width > 0 && box.width === last?.width && box.height === last?.height;
    last = box;
    return settled;
  }, { message: `${selector} settled`, intervals: [100] }).toBe(true);
  return { width: box.width, height: box.height };
}

/**
 * Small at the bottom centre of a viewport: the rule of Hide pill and of the mirror, in a frame as in a page.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ x: number, y: number, width: number, height: number }} view
 */
function expectAtBottomCentre(box, view) {
  expect(box.width).toBe(92);
  expect(box.height).toBe(28);
  expect(Math.abs(box.x - (view.x + view.width / 2))).toBeLessThanOrEqual(1);
  expect(view.y + view.height - (box.y + box.height / 2)).toBeCloseTo(16, 3);
}

/**
 * Minimal stands where its rule puts it for this field: beside it a gap away, else at the bottom
 * centre. The rule is computeMiniPosition's; what is read here is that the page gives it the field's
 * box, the viewport and the gap.
 * @param {{ x: number, y: number, width: number, height: number }} indicator
 * @param {import('@playwright/test').Locator} field
 * @param {{ x: number, y: number, width: number, height: number }} view
 * @param {{ width: number, height: number }} [size]
 */
async function expectMinimalPlaced(indicator, field, view, size = MINI_BOXES.medium) {
  const box = await field.boundingBox();
  const want = computeMiniPosition({
    anchor: { top: box.y - view.y, left: box.x - view.x, width: box.width, height: box.height },
    indicator: size,
    viewport: { width: view.width, height: view.height },
    gap: 8,
  });
  expect(indicator.width).toBeCloseTo(size.width, 0);
  expect(indicator.height).toBeCloseTo(size.height, 0);
  expect(Math.abs(indicator.x - indicator.width / 2 - view.x - want.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(indicator.y - indicator.height / 2 - view.y - want.top)).toBeLessThanOrEqual(1);
}

/**
 * The whole of a box lies inside a frame's viewport. Both are in page coordinates, the box by its centre.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ x: number, y: number, width: number, height: number }} view
 */
function expectInFrame(box, view) {
  expect(box.x - box.width / 2).toBeGreaterThanOrEqual(view.x - 0.5);
  expect(box.y - box.height / 2).toBeGreaterThanOrEqual(view.y - 0.5);
  expect(box.x + box.width / 2).toBeLessThanOrEqual(view.x + view.width + 0.5);
  expect(box.y + box.height / 2).toBeLessThanOrEqual(view.y + view.height + 0.5);
}

/**
 * A button under a point, big enough to take a click on the indicator and on the status beside it. Its
 * mousedown keeps the focus in the field, so that a click leaves a recording as it is.
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number }} point
 */
function addButtonUnder(page, point) {
  return page.evaluate(({ x, y }) => {
    const button = document.createElement('button');
    button.id = 'under';
    button.dataset.clicks = '0';
    button.style.cssText = `position: fixed; left: ${x - 200}px; top: ${y - 120}px; width: 400px; height: 240px;`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1); });
    document.body.append(button);
  }, point);
}

/** @param {import('@playwright/test').Page} page */
const buttonClicks = (page) => page.evaluate(() => Number(document.getElementById('under').dataset.clicks));

/**
 * The bar of a recording is open, not only present behind the clip.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 */
async function expectBarOpen(target) {
  expect((await settledBox(target, '.body')).width).toBeGreaterThan(OPEN_WIDTH);
}

/**
 * Minimal shows nothing to wait for, so its field only gets the click.
 * @param {'pill'|'dot'|'minimal'} style
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {import('@playwright/test').Locator} field
 */
async function focusFor(style, target, field) {
  if (style === 'minimal') await field.click();
  else await focusField(target, field);
}

/** @param {'pill'|'dot'|'minimal'} style */
const recordingMark = (style) => (style === 'minimal' ? MINI : STOP);

/**
 * What a click in another window does to a page: a browser blur, and hasFocus false. Headless
 * Chromium keeps the focus of a page behind another tab or window, and drops it at this toggle.
 * @param {import('@playwright/test').Page} page opened with focusEmulation false, behind another tab
 */
async function loseWindowFocus(page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'the page lost the focus' }).toBe(false);
}

/** What each style measured on fields.html, for the two pages that must match it. */
const reference = new Map();

for (const style of STYLES) {
  for (const { name, path, frameUrl, field: selector, measures, sameSize } of TARGETS) {
    test(`${style} on ${name}: idle, hotkey start, hotkey stop`, async () => {
      await seedStyle(style);
      const page = await openPage(path);
      const target = frameUrl ? await frameAt(page, frameUrl) : page;
      const field = target.locator(selector);
      await focusFor(style, target, field);

      if (style === 'minimal') {
        await page.waitForTimeout(NO_PILL_MS);
        expect(await widthOf(target, '.body')).toBe(0);
        expect(await indicatorShown(target)).toBe(false);
      } else {
        const idleBody = (width) => (style === 'pill' ? width > OPEN_WIDTH : width > 0 && width <= 24);
        await expect.poll(async () => idleBody(await widthOf(target, '.body')), { message: `idle ${style}` }).toBe(true);
      }
      const idle = style === 'minimal' ? null : await settledBox(target, '.body');

      await startWithHotkey(page, target, { indicator: recordingMark(style) });

      if (style === 'minimal') {
        await expectMinimalPlaced(await pillQuery(target, MINI), field, await viewportBox(target));
        expect(await widthOf(target, STOP)).toBe(0);
      }
      const recording = await settledBox(target, style === 'minimal' ? MINI : '.body');
      if (style !== 'minimal') expect(recording.width).toBeGreaterThan(OPEN_WIDTH);

      if (measures) reference.set(style, { idle, recording });
      if (sameSize) expect({ idle, recording }).toEqual(reference.get(style));

      await page.waitForTimeout(RECORD_MS);
      await page.keyboard.press(HOTKEY);

      await expect(field).toHaveValue(TRANSCRIPT);
      await expect.poll(() => pillStatus(target)).toMatch(/^Done /);
      expect(providerCalls).toHaveLength(1);
    });
  }
}

test('Dot opens on hover and closes 300 ms after the pointer leaves', async () => {
  await seedStyle('dot');
  const page = await openPage();
  await focusField(page, page.locator('#ta'));
  const body = await waitForPill(page, '.body');

  await page.mouse.move(body.x, body.y);
  await expect.poll(() => widthOf(page, '.bar')).toBeGreaterThan(0);

  await page.mouse.move(10, 10);
  const left = Date.now();
  await expect.poll(() => widthOf(page, '.bar'), { timeout: 1000, intervals: [50] }).toBe(0);
  expect(Date.now() - left).toBeGreaterThanOrEqual(300);
});

test('Minimal lets a click through the indicator and a plain status', async () => {
  await seedStyle('minimal');
  const page = await openPage();
  const field = page.locator('#ta');
  await field.click();
  await startWithHotkey(page, page, { indicator: MINI });
  const indicator = await pillQuery(page, MINI);

  // Keeps the keyboard focus in the field, as a dictation that ends elsewhere has another status.
  await addButtonUnder(page, indicator);
  const clicks = () => buttonClicks(page);

  await page.mouse.click(indicator.x, indicator.y);

  expect(await clicks()).toBe(1);
  expect(await indicatorShown(page)).toBe(true);

  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);
  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  const status = await pillQuery(page, STATUS);

  await page.mouse.click(status.x, status.y);

  expect(await clicks()).toBe(2);
});

for (const [name, url] of FRAMES) {
  test(`Minimal: a clickable status copies without moving focus, ${name} frame`, async () => {
    await seedStyle('minimal');
    const page = await openPage();
    const frame = await frameAt(page, url);
    const frameField = frame.locator('#frame-ta');
    const pageField = page.locator('#ta');
    await frameField.click();

    await dictateWithHotkey(page, frame, { indicator: MINI });
    await pageField.click();

    await expect.poll(() => pillStatus(frame), { message: 'held status' }).toBe(HOLD);
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);

    const status = await pillQuery(frame, STATUS);
    await page.mouse.click(status.x, status.y);

    await expect.poll(() => pillStatus(frame)).toBe('Copied to clipboard.');
    expect(await frame.evaluate(() => document.hasFocus())).toBe(false);
    expect(await activeId(page)).toBe('ta');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSCRIPT);
    await expect(pageField).toHaveValue('');
    await expect(frameField).toHaveValue('');
  });
}

for (const [name, url] of FRAMES) {
  test(`a held status stays by the field on a switch to Minimal, and copies, ${name} frame`, async () => {
    await seedStyle('dot');
    const page = await openPage();
    const frame = await frameAt(page, url);
    await focusField(frame, frame.locator('#frame-ta'));
    await dictateWithHotkey(page, frame);
    await page.locator('#ta').click();
    await expect.poll(() => pillStatus(frame), { message: 'held status' }).toBe(HOLD);
    await page.waitForTimeout(NO_PILL_MS);
    const before = await pillQuery(frame, STATUS);

    await seedStyle('minimal');

    await expect.poll(() => widthOf(frame, '.body'), { timeout: PILL_SYNC_MS }).toBe(0);
    const status = await pillQuery(frame, STATUS);
    expect({ x: status.x, y: status.y }).toEqual({ x: before.x, y: before.y });

    await page.mouse.click(status.x, status.y);

    await expect.poll(() => pillStatus(frame)).toBe('Copied to clipboard.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSCRIPT);
  });
}

test('Minimal: the menu is unreachable', async () => {
  await seedStyle('minimal');
  const page = await openPage();
  const field = page.locator('#ta');
  await field.click();
  await page.waitForTimeout(NO_PILL_MS);
  // Where the other styles sit, and Minimal now: right of this field, which has no room on its left.
  const box = await field.boundingBox();
  const anchor = { x: box.x + box.width + 20, y: box.y + box.height / 2 };

  await page.mouse.click(anchor.x, anchor.y);

  expect(await pillQuery(page, '.menu')).toBeNull();

  // With the pill mounted, as above there may be nothing to find.
  await field.click();
  await startWithHotkey(page, page, { indicator: MINI });
  await page.mouse.click(anchor.x, anchor.y);

  expect(await pillQuery(page, '.menu')).not.toBeNull();
  expect(await widthOf(page, '.menu')).toBe(0);
});

test('a choice on the Appearance page reaches an open tab within a second', async () => {
  await seedStyle('dot');
  const fixture = await openFields(context);
  await focusField(fixture, fixture.locator('#ta'));
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html#settings/appearance`);
  await expect(settings.locator('input[name="pill-style"][value="dot"]')).toBeChecked();
  // Chromium barely ticks transitions in a background tab: Pill to Dot took 2 s there, 0.5 s in front.
  await fixture.bringToFront();
  const reaches = (check) => expect
    .poll(async () => check(await widthOf(fixture, '.body')), { timeout: PILL_SYNC_MS, intervals: [50] })
    .toBe(true);

  await settings.locator('.style-card', { has: settings.locator('input[value="pill"]') }).click();
  await reaches((width) => width > 130);

  await settings.keyboard.press('ArrowRight');
  await expect(settings.locator('input[name="pill-style"][value="dot"]')).toBeChecked();
  await reaches((width) => width > 0 && width <= 24);

  await settings.keyboard.press('ArrowRight');
  await expect(settings.locator('input[name="pill-style"][value="minimal"]')).toBeChecked();
  await reaches((width) => width === 0);
});

for (const recording of [false, true]) {
  test(`a switch to Minimal closes an open menu${recording ? ' during a recording' : ''}`, async () => {
    await seedStyle('dot');
    const page = await openPage();
    await focusField(page, page.locator('#ta'));
    if (recording) await startWithHotkey(page, page);
    await clickPill(page, 'button.mode');
    await waitForPill(page, '.menu');

    await seedStyle('minimal');

    await expect.poll(() => widthOf(page, '.menu'), { timeout: PILL_SYNC_MS }).toBe(0);
    expect(await widthOf(page, '.body')).toBe(0);

    // Hidden with the rest of the pill is not closed: the way back must find it closed.
    await seedStyle('dot');

    await waitForPill(page, '.body', PILL_SYNC_MS);
    expect(await widthOf(page, '.menu')).toBe(0);
  });
}

test('a page that lost the focus shows a new style on the way back to the field', async () => {
  await seedStyle('dot');
  const page = await openPage();
  const field = page.locator('#ta');
  await focusField(page, field);
  const other = await context.newPage();

  await loseWindowFocus(page);
  await expect.poll(() => widthOf(page, '.body'), { message: 'idle pill hidden' }).toBe(0);
  await seedStyle('pill');
  await page.waitForTimeout(NO_PILL_MS);
  expect(await widthOf(page, '.body')).toBe(0);

  await page.bringToFront();
  await field.click();

  await expect.poll(() => widthOf(page, '.body'), { timeout: PILL_SYNC_MS }).toBeGreaterThan(OPEN_WIDTH);
  await other.close();
});

for (const [from, to] of [['dot', 'minimal'], ['minimal', 'dot']]) {
  test(`a switch during a recording keeps it indicated, and the hotkey stops it: ${from} to ${to}`, async () => {
    await seedStyle(from);
    const page = await openPage();
    const field = page.locator('#ta');
    await focusFor(from, page, field);
    await startWithHotkey(page, page, { indicator: recordingMark(from) });

    await seedStyle(to);

    await waitForPill(page, recordingMark(to), PILL_SYNC_MS);
    expect(await widthOf(page, recordingMark(from))).toBe(0);
    if (to === 'dot') await expectBarOpen(page);

    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(HOTKEY);
    await expect(field).toHaveValue(TRANSCRIPT);
  });

  test(`a switch from another window keeps a recording indicated: ${from} to ${to}`, async () => {
    await seedStyle(from);
    const page = await openPage();
    const field = page.locator('#ta');
    await focusFor(from, page, field);
    await startWithHotkey(page, page, { indicator: recordingMark(from) });
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html#settings/appearance`);
    await expect(settings.locator(`input[name="pill-style"][value="${from}"]`)).toBeChecked();
    await loseWindowFocus(page);

    await settings.locator('.style-card', { has: settings.locator(`input[value="${to}"]`) }).click();

    await waitForPill(page, recordingMark(to), PILL_SYNC_MS);
    expect(await widthOf(page, recordingMark(from))).toBe(0);

    // The hotkey reaches a page only through its focus, so the way back is a click into the field.
    await page.bringToFront();
    if (to === 'dot') await expectBarOpen(page);
    await field.click();
    await expect.poll(() => page.evaluate(() => document.hasFocus()), { message: 'focus back' }).toBe(true);
    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(HOTKEY);
    await expect(field).toHaveValue(TRANSCRIPT);
  });
}

test('reduced motion keeps the bars static', async () => {
  /** @param {import('@playwright/test').Page} page the transforms of a first bar across a second of recording */
  async function barTransforms(page) {
    await page.locator('#ta').click();
    await startWithHotkey(page, page, { indicator: MINI });
    const seen = new Set();
    for (const end = Date.now() + 1000; Date.now() < end; await page.waitForTimeout(50)) {
      seen.add((await pillQuery(page, '.lvl')).transform);
    }
    return [...seen];
  }

  // Without the preference the same read sees the scale, so the check below can fail.
  await seedStyle('minimal');
  expect(await barTransforms(await openPage())).not.toContain('none');

  const reduced = await launchExtension({ contextOptions: { reducedMotion: 'reduce' } });
  try {
    await seedSettings(reduced.serviceWorker, DUMMY_KEY, { pillStyle: 'minimal' });
    const page = await openFields(reduced.context);
    expect(await barTransforms(page)).toEqual(['none']);
  } finally {
    await reduced.close();
  }
});

test('the Appearance page has no sideways scroll at 380 px', async () => {
  await seedStyle('dot');
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/options.html#settings/appearance`);
  await expect(page.locator('input[name="pill-style"][value="dot"]')).toBeChecked();
  await expect(page.locator('section[data-route="settings/appearance"] .style-card').last()).toBeVisible();

  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));

  expect(client).toBeLessThanOrEqual(380);
  expect(scroll).toBeLessThanOrEqual(client);
});

test('forced colors show the selected card, and a focused one keeps its focus ring', async () => {
  await seedStyle('dot');
  const page = await context.newPage();
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(`chrome-extension://${extensionId}/options.html#settings/appearance`);
  const radio = (value) => page.locator(`input[name="pill-style"][value="${value}"]`);
  const outline = (value) => page.locator('.style-card', { has: radio(value) }).evaluate((card) => {
    const { outlineStyle, outlineOffset, borderTopColor } = getComputedStyle(card);
    return { outlineStyle, outlineOffset, borderTopColor };
  });
  await expect(radio('dot')).toBeChecked();
  const highlight = await page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'Highlight';
    return getComputedStyle(probe).color;
  });

  expect(await outline('dot')).toEqual({ outlineStyle: 'solid', outlineOffset: '-2px', borderTopColor: highlight });
  expect((await outline('pill')).outlineStyle).toBe('none');

  await radio('dot').focus();
  await page.keyboard.press('ArrowRight');
  await expect(radio('minimal')).toBeChecked();

  expect(await outline('minimal')).toEqual({ outlineStyle: 'solid', outlineOffset: '2px', borderTopColor: highlight });
  expect((await outline('dot')).outlineStyle).toBe('none');
});

/** Scroll 0: every frame of fields.html is below the short viewport's fold. */
const scrollFramesOut = (page) => page.evaluate(() => window.scrollTo(0, 0));

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} selector the iframe
 */
const scrollFrameIn = (page, selector) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'center' }), selector);

/** @param {import('@playwright/test').Page} page */
const pollMirror = (page, shown, options) => expect
  .poll(async () => (await mirrorQuery(page, MINI)) !== null, { message: `mirror ${shown ? 'shown' : 'gone'}`, ...options })
  .toBe(shown);

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} ms
 */
async function expectNoMirrorFor(page, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    expect(await mirrorQuery(page, MINI)).toBeNull();
    await page.waitForTimeout(100);
  }
}

/**
 * The mirror's clock shows a time, and a later one.
 * @param {import('@playwright/test').Page} page
 */
async function expectClockRuns(page) {
  const read = async () => (await mirrorQuery(page, MINI_TIME))?.text ?? '';
  const first = await read();
  expect(first).toMatch(CLOCK);
  await expect.poll(async () => {
    const now = await read();
    return CLOCK.test(now) && now !== first;
  }, { message: 'mirror clock' }).toBe(true);
}

/**
 * The frame field holds real focus, from a click while no scroll is needed; the page then takes
 * the short viewport with the frame in view, and everything from here on is a keyboard press.
 * @param {{ url: string, selector: string, style?: 'dot'|'minimal' }} options
 */
async function recordInFrame({ url, selector, style = 'dot' }) {
  const page = await openPage();
  const frame = await frameAt(page, url);
  const field = frame.locator('#frame-ta');
  await focusFor(style, frame, field);
  await page.setViewportSize(SHORT_VIEWPORT);
  await scrollFrameIn(page, selector);
  await startWithHotkey(page, frame, { indicator: recordingMark(style) });
  return { page, frame, field };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 * @param {string} property
 * @param {string} value
 */
const setStyle = (page, selector, property, value) => page.evaluate(([s, p, v]) => {
  document.querySelector(s).style[p] = v;
}, [selector, property, value]);

/** Ways to hide a frame from the user that leave its geometry in the viewport. */
const COVERS = [
  {
    what: 'opacity 0 on the iframe',
    cover: (page, selector) => setStyle(page, selector, 'opacity', '0'),
    undo: (page, selector) => setStyle(page, selector, 'opacity', ''),
  },
  {
    what: 'visibility hidden on the iframe',
    cover: (page, selector) => setStyle(page, selector, 'visibility', 'hidden'),
    undo: (page, selector) => setStyle(page, selector, 'visibility', ''),
  },
  {
    what: 'an opaque overlay above the iframe',
    cover: (page) => page.evaluate((css) => {
      const overlay = document.createElement('div');
      overlay.id = 'overlay';
      overlay.style.cssText = css;
      document.documentElement.append(overlay);
    }, OVERLAY),
    undo: (page) => page.evaluate(() => document.getElementById('overlay').remove()),
  },
];

/**
 * The page holds one frame, 3000 px tall, in a 600 px window, with the field near its top.
 * @param {string} url
 */
async function openTallFrame(url) {
  const page = await openPage();
  await page.setViewportSize(TALL_VIEWPORT);
  const src = `${url}?tall`;
  await page.evaluate(({ frameSrc, height }) => {
    const iframe = document.createElement('iframe');
    iframe.src = frameSrc;
    iframe.style.cssText = `display: block; width: 100%; height: ${height}px; border: 0;`;
    document.body.replaceChildren(iframe);
  }, { frameSrc: src, height: TALL_FRAME_PX });
  const frame = await frameAt(page, src);
  await frame.locator('#frame-ta').click();
  return { page, frame };
}

/**
 * The element lies inside the window. Its box is in page coordinates.
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
function expectInTallViewport(box) {
  expect(box.width).toBeGreaterThan(0);
  expect(box.y - box.height / 2).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height / 2).toBeLessThanOrEqual(TALL_VIEWPORT.height);
  expect(box.x - box.width / 2).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width / 2).toBeLessThanOrEqual(TALL_VIEWPORT.width);
}

test('mirror, same-origin: a page shadow over the edge of the pill is no cover', async () => {
  const [, url, selector] = FRAMES[0];
  const { page, frame } = await recordInFrame({ url, selector });
  const slot = await pillQuery(frame, '.pill');
  const sight = await pillQuery(frame, '.pill .sight');
  expect([sight.width, sight.height]).toEqual([1, 1]);
  expect(Math.abs(sight.x - slot.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(sight.y - slot.y)).toBeLessThanOrEqual(1);

  await page.evaluate(({ left, top, width, spread }) => {
    const header = document.createElement('div');
    header.style.cssText = `position: fixed; left: ${left}px; top: ${top}px; width: ${width}px; height: 2px;`
      + `z-index: 1; box-shadow: 0 0 0 ${spread}px rgb(0 0 0 / 0.2);`;
    document.body.append(header);
  }, { left: slot.x - slot.width / 2, top: slot.y - slot.height / 2 - 2, width: slot.width, spread: EDGE_SHADOW_PX });

  await expectNoMirrorFor(page, 1000);
});

for (const [name, url, selector] of FRAMES) {
  test(`mirror, ${name}: no mirror while the frame pill is in view`, async () => {
    const { page } = await recordInFrame({ url, selector });

    await expectNoMirrorFor(page, 1000);
  });

  test(`mirror, ${name}: scrolling the frame out brings the indicator up, back takes it away`, async () => {
    const { page, frame } = await recordInFrame({ url, selector });

    await scrollFramesOut(page);

    await pollMirror(page, true);
    expectAtBottomCentre(await mirrorQuery(page, MINI), await viewportBox(page));
    await expectClockRuns(page);

    await scrollFrameIn(page, selector);

    await pollMirror(page, false);
    await waitForPill(frame, STOP);
    await expectBarOpen(frame);
  });

  test(`mirror, ${name}: a stop while out of sight ends in the field and clears it`, async () => {
    const { page, field } = await recordInFrame({ url, selector });
    await scrollFramesOut(page);
    await pollMirror(page, true);
    await page.waitForTimeout(RECORD_MS);

    await page.keyboard.press(HOTKEY);

    await expect.poll(async () => (await mirrorQuery(page, '.mini-dots')) !== null, { message: 'processing' }).toBe(true);
    await expect(field).toHaveValue(TRANSCRIPT);
    await pollMirror(page, false);
  });

  test(`mirror, ${name}: removing the iframe clears it`, async () => {
    const { page } = await recordInFrame({ url, selector });
    await scrollFramesOut(page);
    await pollMirror(page, true);

    await page.evaluate((s) => document.querySelector(s).remove(), selector);

    await pollMirror(page, false, { timeout: REMOVED_FRAME_MS });
    await focusField(page, page.locator('#ta'));
    await startWithHotkey(page, page);
  });

  test(`mirror, ${name}: display none on the iframe brings it up`, async () => {
    const { page } = await recordInFrame({ url, selector });
    await expectNoMirrorFor(page, 300);

    await page.evaluate((s) => { document.querySelector(s).style.display = 'none'; }, selector);

    await pollMirror(page, true);
  });

  test(`mirror, ${name}: on a hidden site`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { siteRules: { localhost: HIDE_ONLY } });
    const { page, frame } = await recordInFrame({ url, selector, style: 'minimal' });

    await expectNoMirrorFor(page, 300);
    await scrollFramesOut(page);

    await pollMirror(page, true);
    expectAtBottomCentre(await mirrorQuery(page, MINI), await viewportBox(page));
    await expectClockRuns(page);

    await scrollFrameIn(page, selector);

    await pollMirror(page, false);
    await waitForPill(frame, MINI);
  });

  test(`mirror, ${name}: the page keeps its own pill`, async () => {
    const page = await openPage();
    const frame = await frameAt(page, url);
    const pageField = page.locator('#ta');
    await focusField(page, pageField);
    await focusField(frame, frame.locator('#frame-ta'));
    await startWithHotkey(page, frame);
    await pageField.click();
    await waitForPill(page, '.body');

    // The short viewport puts the frame below the fold and leaves the page field where it was.
    await page.setViewportSize(SHORT_VIEWPORT);
    await pollMirror(page, true);

    await clickPill(page, 'button.mode');
    await waitForPill(page, '.menu');
    expect(await mirrorQuery(page, MINI)).not.toBeNull();
    await page.keyboard.press('Escape');
    await pageField.pressSequentially('typed');
    await expect(pageField).toHaveValue('typed');
    expect(await mirrorQuery(page, MINI)).not.toBeNull();
  });

  for (const { what, cover, undo } of COVERS) {
    test(`mirror, ${name}: ${what} brings it up, undoing it takes it away`, async () => {
      const { page, frame } = await recordInFrame({ url, selector });
      await expectNoMirrorFor(page, 300);

      await cover(page, selector);

      await pollMirror(page, true);
      expectAtBottomCentre(await mirrorQuery(page, MINI), await viewportBox(page));

      await undo(page, selector);

      await pollMirror(page, false);
      await waitForPill(frame, STOP);
    });
  }

  test(`mirror, ${name}: an open menu is no cover`, async () => {
    const page = await openPage();
    const frame = await frameAt(page, url);
    await focusField(frame, frame.locator('#frame-ta'));
    await startWithHotkey(page, frame);

    await clickPill(frame, 'button.mode');

    await waitForPill(frame, '.menu');
    await expectNoMirrorFor(page, 1000);
  });

  for (const [site, overrides, stands] of TALL_FRAME_SITES) {
    test(`a tall ${name} frame on ${site}: a refusal shows by the field`, async () => {
      await seedSettings(serviceWorker, '', overrides);
      const { page, frame } = await openTallFrame(url);

      await expect(async () => {
        await page.keyboard.press(HOTKEY);
        await expect.poll(() => pillStatus(frame), { timeout: PILL_SYNC_MS }).toContain('Add an API key');
      }).toPass({ timeout: 15_000 });

      expectInTallViewport(await pillQuery(frame, STATUS));
    });

    test(`a tall ${name} frame on ${site}: Done shows by the field`, async () => {
      await seedSettings(serviceWorker, DUMMY_KEY, overrides);
      const { page, frame } = await openTallFrame(url);

      await startWithHotkey(page, frame, { indicator: MINI });
      const indicator = await pillQuery(frame, MINI);
      if (stands === 'bottom') {
        expectAtBottomCentre(indicator, await viewportBox(frame));
      } else {
        await expectMinimalPlaced(indicator, frame.locator('#frame-ta'), await viewportBox(frame));
        expectInTallViewport(indicator);
      }
      await page.waitForTimeout(RECORD_MS);
      await page.keyboard.press(HOTKEY);

      await expect(frame.locator('#frame-ta')).toHaveValue(TRANSCRIPT);
      await expect.poll(() => pillStatus(frame)).toMatch(/^Done /);
      expectInTallViewport(await pillQuery(frame, STATUS));
    });
  }

  test(`mirror, ${name}: rapid scroll out and back leaves no indicator`, async () => {
    const { page } = await recordInFrame({ url, selector });

    const removed = await page.evaluate(async ({ s, beatMs }) => {
      let gone = 0;
      const hosts = new MutationObserver((records) => {
        for (const { removedNodes } of records) gone += removedNodes.length;
      });
      hosts.observe(document.documentElement, { childList: true });
      const beat = () => new Promise((resolve) => { setTimeout(resolve, beatMs); });
      for (let flip = 0; flip < 6; flip += 1) {
        window.scrollTo(0, 0);
        await beat();
        document.querySelector(s).scrollIntoView({ block: 'center' });
        await beat();
      }
      hosts.disconnect();
      return gone;
    }, { s: selector, beatMs: FLIP_BEAT_MS });

    // Only a mirror ever leaves: each one removed came up and went during the flips.
    expect(removed).toBeGreaterThan(0);
    await pollMirror(page, false);
    await expectNoMirrorFor(page, 1000);
  });

  for (const [site, siteRules] of [['a normal site', {}], ['a hidden site', { localhost: HIDE_ONLY }]]) {
    test(`mirror, ${name}: frame 0 status beside the mirror on ${site}`, async () => {
      await seedSettings(serviceWorker, DUMMY_KEY, { siteRules });
      const style = site === 'a hidden site' ? 'minimal' : 'dot';
      const page = await openPage();
      const frame = await frameAt(page, url);
      await focusFor(style, frame, frame.locator('#frame-ta'));
      await startWithHotkey(page, frame, { indicator: recordingMark(style) });
      await page.locator('#ta').click();
      await page.setViewportSize(SHORT_VIEWPORT);
      await pollMirror(page, true);

      // Frame 0 asks to record while the frame does: the worker refuses and frame 0 gets a status.
      await page.keyboard.press(HOTKEY);

      await expect.poll(async () => (await mirrorQuery(page, STATUS))?.text ?? '', { message: 'frame 0 status' }).toBe(IN_OTHER_FIELD);
      const mini = await mirrorQuery(page, MINI);
      const status = await mirrorQuery(page, STATUS);
      expect(mini).not.toBeNull();
      const overlaps = Math.abs(mini.x - status.x) < (mini.width + status.width) / 2
        && Math.abs(mini.y - status.y) < (mini.height + status.height) / 2;
      expect(overlaps).toBe(false);
    });
  }

  // Medium, with no room beside the field, keeps EDGE (4 px) from the top of a short frame, so a frame
  // viewport of 21 px holds its centre, which the sight observer watches: 40 px holds all of it, and
  // only under 21 px is it out of sight.
  test(`mirror, ${name}: a 40 px iframe holds the whole indicator, so no mirror`, async () => {
    await seedStyle('minimal');
    const page = await openPage();
    const frame = await frameAt(page, url);
    await frame.locator('#frame-ta').click();
    await page.evaluate((s) => { document.querySelector(s).style.height = '40px'; }, selector);

    await startWithHotkey(page, frame, { indicator: MINI });

    await expectNoMirrorFor(page, 1000);
  });

  test(`mirror, ${name}: a short iframe, under half of the indicator fits`, async () => {
    await seedStyle('minimal');
    const page = await openPage();
    const frame = await frameAt(page, url);
    await frame.locator('#frame-ta').click();
    await page.evaluate((s) => { document.querySelector(s).style.height = '16px'; }, selector);

    await startWithHotkey(page, frame, { indicator: MINI });

    await pollMirror(page, true);
    expectAtBottomCentre(await mirrorQuery(page, MINI), await viewportBox(page));
  });
}

for (const size of MINI_SIZES) {
  test(`Minimal ${size}: beside a textarea, in its box, and a click at its centre reaches the page`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal', miniSize: size });
    const page = await openPage();
    const field = page.locator('#ta');
    await field.click();
    await startWithHotkey(page, page, { indicator: MINI });
    const want = MINI_BOXES[size];
    const indicator = await pillQuery(page, MINI);
    const box = await field.boundingBox();

    // This textarea has no room on its left, so the indicator stands right of it, a gap away, level with it.
    expect([indicator.width, indicator.height]).toEqual([want.width, want.height]);
    expect(Math.abs(indicator.x - want.width / 2 - (box.x + box.width + 8))).toBeLessThanOrEqual(1);
    expect(Math.abs(indicator.y - (box.y + box.height / 2))).toBeLessThanOrEqual(1);
    expect(await pillCall(page, MINI, `function () {
      const bars = [...this.querySelectorAll('.lvl')].filter((bar) => getComputedStyle(bar).display !== 'none');
      const first = getComputedStyle(bars[0]);
      return {
        bars: bars.length,
        barWidth: parseFloat(first.width),
        barHeight: parseFloat(first.height),
        barGap: parseFloat(getComputedStyle(this.querySelector('.levels')).columnGap),
        font: parseFloat(getComputedStyle(this.querySelector('.mini-time')).fontSize),
      };
    }`)).toEqual({ bars: want.bars, barWidth: want.barWidth, barHeight: want.barHeight, barGap: want.barGap, font: want.font });

    await addButtonUnder(page, indicator);
    await page.mouse.click(indicator.x, indicator.y);

    expect(await buttonClicks(page)).toBe(1);
    expect(await indicatorShown(page)).toBe(true);
  });
}

for (const color of REC_COLORS) {
  test(`recording colour ${color}: the bars, REC and glow take it`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'pill', recColor: color });
    const page = await openPage();
    await focusField(page, page.locator('#ta'));
    await startWithHotkey(page, page);
    const { rgb, tokens } = REC_LOOKS[color];
    const read = () => pillCall(page, '.vt', `function () {
      const css = (el) => getComputedStyle(el);
      return {
        tokens: ['--vt-rec', '--vt-rec-hover', '--vt-glow'].map((name) => css(this).getPropertyValue(name).trim()),
        rec: css(this.querySelector('.rec')).backgroundColor,
        bar: css(this.querySelector('.lvl')).backgroundColor,
        glow: css(this.querySelector('.body')).boxShadow,
      };
    }`);

    // REC fades to its colour over 0.12 s.
    await expect.poll(async () => (await read()).rec, { message: 'REC colour' }).toBe(rgbText(rgb));
    const drawn = await read();
    expect(drawn.tokens).toEqual(tokens);
    expect(drawn.bar).toBe(rgbText(rgb));
    expect(drawn.glow).toContain(tokens[2].split(' ').join(', '));
  });
}

test('Hide pill keeps Small at the bottom, in the recording colour', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { siteRules: { localhost: HIDE_ONLY }, miniSize: 'xlarge', recColor: 'obsidian' });
  const page = await openPage();
  await page.locator('#ta').click();
  await startWithHotkey(page, page, { indicator: MINI });

  expectAtBottomCentre(await pillQuery(page, MINI), await viewportBox(page));
  const bars = await pillCall(page, MINI, `function () {
    return [...this.querySelectorAll('.lvl')]
      .filter((bar) => getComputedStyle(bar).display !== 'none')
      .map((bar) => getComputedStyle(bar).backgroundColor);
  }`);
  expect(bars).toEqual(Array(MINI_BOXES.small.bars).fill(rgbText(REC_LOOKS.obsidian.rgb)));
});

test('the mirror is Small at the bottom, in the recording colour', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { miniSize: 'xlarge', recColor: 'obsidian' });
  const [, url, selector] = FRAMES[1];
  const { page } = await recordInFrame({ url, selector });

  await scrollFramesOut(page);

  await pollMirror(page, true);
  expectAtBottomCentre(await mirrorQuery(page, MINI), await viewportBox(page));
  await expect.poll(() => countPixels(page, REC_LOOKS.obsidian.rgb), { message: 'obsidian pixels of the mirror' })
    .toBeGreaterThan(MIN_COLOUR_PIXELS);
  expect(await countPixels(page, RED)).toBeLessThan(MIN_COLOUR_PIXELS);
});

test('Minimal in a cross-origin frame stands in the frame, with its status', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal', miniSize: 'large' });
  const page = await openPage();
  const frame = await frameAt(page, CROSS_ORIGIN_FRAME);
  const field = frame.locator('#frame-ta');
  await field.click();

  await startWithHotkey(page, frame, { indicator: MINI });

  const view = await viewportBox(frame);
  const indicator = await pillQuery(frame, MINI);
  await expectMinimalPlaced(indicator, field, view, MINI_BOXES.large);
  expectInFrame(indicator, view);
  await expectNoMirrorFor(page, 300);
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(frame)).toMatch(/^Done /);
  expectInFrame(await pillQuery(frame, STATUS), view);
});

/**
 * The tone colour of the status on show, and the tokens it must come from.
 * @param {import('@playwright/test').Page} page
 */
const statusColors = (page) => pillCall(page, STATUS, `function () {
  const vt = this.closest('.vt');
  const probe = (token) => {
    const node = document.createElement('i');
    node.style.color = 'var(' + token + ')';
    vt.append(node);
    const color = getComputedStyle(node).color;
    node.remove();
    return color;
  };
  return {
    icon: getComputedStyle(this.querySelector('.status-icon')).color,
    error: probe('--vt-error'),
    success: probe('--vt-success'),
    rec: probe('--vt-rec'),
    chosen: vt.dataset.rec,
  };
}`);

test('an error stays red with the emerald recording colour', async () => {
  await seedSettings(serviceWorker, '', { pillStyle: 'minimal', recColor: 'emerald' });
  const page = await openPage();
  await page.locator('#ta').click();

  await expect(async () => {
    await page.keyboard.press(HOTKEY);
    await expect.poll(() => pillStatus(page), { timeout: PILL_SYNC_MS }).toContain('Add an API key');
  }).toPass({ timeout: 15_000 });

  const colors = await statusColors(page);
  expect(colors.chosen).toBe('emerald');
  expect(colors.rec).toBe(rgbText(REC_LOOKS.emerald.rgb));
  expect(colors.icon).toBe(colors.error);
  expect(colors.icon).not.toBe(colors.rec);
});

test('a success stays its green with the obsidian recording colour', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal', recColor: 'obsidian' });
  const page = await openPage();
  await page.locator('#ta').click();
  await dictateWithHotkey(page, page, { indicator: MINI });

  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);

  const colors = await statusColors(page);
  expect(colors.chosen).toBe('obsidian');
  expect(colors.icon).toBe(colors.success);
  expect(colors.icon).not.toBe(colors.rec);
});
