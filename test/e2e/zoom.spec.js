// End-to-end coverage of `zoom` on the page root in the built extension: it reaches the host through
// `all: initial`, as zoom multiplies down the tree, and the indicator must not be scaled off screen.
// Layout is read from the boxes, what shows from screenshot pixels. Run with `npm run test:e2e`,
// which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, mirrorQuery, pillStatus, waitForPill, clickPill, focusField, startWithHotkey,
  countPixels, PORT, TRANSCRIPT, DUMMY_KEY, STOP, MINI, STATUS, HOTKEY, RECORD_MS, RED,
} from './helpers.js';
import { CORNER_MARGIN } from '../../src/content/position.js';

const ZOOMS = [2, 0.75];
const GAP = 8;
/** Constants of pill.js, which a spec cannot import: it imports its stylesheet. */
const PILL_SIZE = { width: 140, height: 30 };
/** Medium, the default size, stands beside the field; Small is the size of the bottom centre. */
const MINI_BESIDE = { width: 124, height: 34 };
const MINI_BOTTOM = { width: 92, height: 28 };
const STATUS_GAP = 6;
const MENU_GAP = 6;
const MENU_WIDTH = 248;
/** Tall enough that the field stays in view at either zoom, and that no click scrolls. */
const VIEWPORT = { width: 1280, height: 2000 };
/** The field as wide as the pill's left side needs at either zoom, and near the top. */
const PAGE_CSS = 'body { margin: 40px 0 0 300px; max-width: 300px; }';
/** A field in px: a root zoom moves it without resizing it, so the anchor watcher hears nothing. */
const PX_FIELD_CSS = '#ta { width: 240px; height: 60px; }';
/** More than the corners of a stray pixel, less than Minimal's level bars at a low level. */
const MIN_RED = 40;
/** A raise from a tick must be back within this long. */
const RAISE_BACK_MS = 1000;
/** Rounding either way, and float noise from a cancelled zoom. */
const PX = 1;
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, close } = await launchExtension());
});

test.afterAll(async () => {
  await close?.();
});

test.afterEach(async () => {
  for (const page of context.pages()) {
    if (/^http:/.test(page.url())) await page.close();
  }
});

/**
 * The fixture with real focus, at a known size, with the field at a known place at either zoom.
 * @param {number} zoom on the root
 */
async function openZoomed(zoom) {
  const page = await openFields(context, { focusEmulation: false });
  await page.setViewportSize(VIEWPORT);
  await page.addStyleTag({ content: PAGE_CSS });
  await setZoom(page, zoom);
  return page;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} zoom
 */
const setZoom = (page, zoom) => page.evaluate((value) => { document.documentElement.style.zoom = String(value); }, zoom);

/** @param {import('@playwright/test').Page} page */
const viewportOf = (page) => page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }));

/** @param {import('@playwright/test').Locator} field */
const fieldBox = (field) => field.evaluate((el) => {
  const { left, top, width, height } = el.getBoundingClientRect();
  return { left, top, width, height };
});

/** @param {'pill'|'dot'|'minimal'} style */
const recordingMark = (style) => (style === 'minimal' ? MINI : STOP);

const near = (a, b) => Math.abs(a - b) <= PX;

/**
 * Whether a box is where Minimal goes with no field to stand by (Hide pill, the mirror): the bottom
 * centre, Small, 16 px from the bottom.
 * @param {{ x: number, y: number, width: number, height: number }|null} box
 * @param {{ width: number, height: number }} viewport
 */
function atBottomCentre(box, viewport) {
  if (!box) return false;
  return near(box.x, viewport.width / 2) && near(box.y + box.height / 2, viewport.height - CORNER_MARGIN)
    && near(box.width, MINI_BOTTOM.width) && near(box.height, MINI_BOTTOM.height);
}

/**
 * Whether a box sits left of the field, in `size`, the gap away and level with it.
 * @param {{ x: number, y: number, width: number, height: number }|null} box
 * @param {{ left: number, top: number, height: number }} field
 * @param {{ width: number, height: number }} size
 */
function besideField(box, field, size) {
  if (!box) return false;
  return near(box.x + box.width / 2, field.left - GAP) && near(box.y, field.top + field.height / 2)
    && near(box.width, size.width) && near(box.height, size.height);
}

/** @param {{ x: number, y: number, width: number, height: number }|null} box @param {{ width: number, height: number }} viewport */
function inside(box, viewport) {
  return Boolean(box) && box.x - box.width / 2 >= 0 && box.y - box.height / 2 >= 0
    && box.x + box.width / 2 <= viewport.width && box.y + box.height / 2 <= viewport.height;
}

/** `.pill` keeps its size in every state, as its body animates inside it. */
const pillBox = (page) => pillQuery(page, '.pill');

/**
 * The recording's indicator is where its style puts it (Minimal beside the field, as the pill is), and paints.
 * @param {import('@playwright/test').Page} page
 * @param {'pill'|'dot'|'minimal'} style
 * @param {import('@playwright/test').Locator} field
 * @param {number} [timeout]
 */
async function expectPlaced(page, style, field, timeout) {
  const viewport = await viewportOf(page);
  const options = { message: `${style} in place`, ...(timeout && { timeout }) };
  const box = await fieldBox(field);
  if (style === 'minimal') {
    await expect.poll(async () => besideField(await pillQuery(page, MINI), box, MINI_BESIDE), options).toBe(true);
  } else {
    await expect.poll(async () => besideField(await pillBox(page), box, PILL_SIZE), options).toBe(true);
  }
  expect(inside(await pillQuery(page, style === 'minimal' ? MINI : '.pill'), viewport)).toBe(true);
  await expect.poll(() => countPixels(page, RED), { message: 'red pixels of the recording', ...(timeout && { timeout }) })
    .toBeGreaterThan(MIN_RED);
}

for (const zoom of ZOOMS) {
  for (const style of ['pill', 'dot', 'minimal']) {
    test(`a ${style} recording on a page with zoom ${zoom}`, async () => {
      await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: style });
      const page = await openZoomed(zoom);
      const field = page.locator('#ta');
      if (style === 'minimal') await field.click();
      else await focusField(page, field);

      await startWithHotkey(page, page, { indicator: recordingMark(style) });

      await expectPlaced(page, style, field);
    });
  }

  test(`a hidden site records with the indicator on screen at zoom ${zoom}`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'dot', siteRules: { localhost: { hidePill: true, mode: null } } });
    const page = await openZoomed(zoom);
    const field = page.locator('#ta');
    await field.click();

    await startWithHotkey(page, page, { indicator: MINI });

    const viewport = await viewportOf(page);
    await expect.poll(async () => atBottomCentre(await pillQuery(page, MINI), viewport), { message: 'Small at the bottom centre' }).toBe(true);
    expect(inside(await pillQuery(page, MINI), viewport)).toBe(true);
    await expect.poll(() => countPixels(page, RED), { message: 'red pixels of the recording' }).toBeGreaterThan(MIN_RED);
  });

  test(`Done stands where it should at zoom ${zoom}, dot`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'dot' });
    const page = await openZoomed(zoom);
    const field = page.locator('#ta');
    await focusField(page, field);
    await startWithHotkey(page, page);
    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(HOTKEY);

    await expect(field).toHaveValue(TRANSCRIPT);
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    const viewport = await viewportOf(page);
    const box = await fieldBox(field);
    const status = await pillQuery(page, STATUS);
    expect(inside(status, viewport)).toBe(true);
    // A status at the left placement grows leftwards from the pill's right edge, below the pill.
    expect(near(status.x + status.width / 2, box.left - GAP)).toBe(true);
    expect(near(status.y - status.height / 2, box.top + box.height / 2 + PILL_SIZE.height / 2 + STATUS_GAP)).toBe(true);
  });

  test(`Done stands where it should at zoom ${zoom}, minimal`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal' });
    const page = await openZoomed(zoom);
    const field = page.locator('#ta');
    await field.click();
    await startWithHotkey(page, page, { indicator: MINI });
    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(HOTKEY);

    await expect(field).toHaveValue(TRANSCRIPT);
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    const viewport = await viewportOf(page);
    const box = await fieldBox(field);
    const status = await pillQuery(page, STATUS);
    expect(inside(status, viewport)).toBe(true);
    // Beside the indicator as beside a pill: it grows leftwards from the indicator's right edge, below it.
    expect(near(status.x + status.width / 2, box.left - GAP)).toBe(true);
    expect(near(status.y - status.height / 2, box.top + box.height / 2 + MINI_BESIDE.height / 2 + STATUS_GAP)).toBe(true);
  });
}

for (const style of ['dot', 'minimal']) {
  test(`zoom set during a ${style} recording is picked up, and taken off again`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: style });
    const page = await openZoomed(1);
    const field = page.locator('#ta');
    if (style === 'minimal') await field.click();
    else await focusField(page, field);
    await startWithHotkey(page, page, { indicator: recordingMark(style) });
    await expectPlaced(page, style, field);

    await setZoom(page, 2);
    await expectPlaced(page, style, field, RAISE_BACK_MS);

    await setZoom(page, 1);
    await expectPlaced(page, style, field, RAISE_BACK_MS);
  });
}

for (const style of ['dot', 'pill', 'minimal']) {
  test(`a zoom change during a ${style} recording moves the ${style === 'minimal' ? 'indicator' : 'pill'} to the field`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: style });
    const page = await openZoomed(1);
    await page.addStyleTag({ content: PX_FIELD_CSS });
    const field = page.locator('#ta');
    if (style === 'minimal') await field.click();
    else await focusField(page, field);
    await startWithHotkey(page, page, { indicator: recordingMark(style) });
    await expectPlaced(page, style, field);
    const before = await fieldBox(field);

    await setZoom(page, 2);

    expect((await fieldBox(field)).left).not.toBe(before.left);
    await expectPlaced(page, style, field, RAISE_BACK_MS);
  });
}

for (const zoom of ZOOMS) {
  test(`the menu opens under an idle pill at zoom ${zoom}`, async () => {
    await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'pill' });
    const page = await openZoomed(zoom);
    const field = page.locator('#ta');
    await focusField(page, field);

    await clickPill(page, 'button.mode');

    const menu = await waitForPill(page, '.menu');
    const pill = await pillBox(page);
    expect(inside(menu, await viewportOf(page))).toBe(true);
    expect(near(menu.width, MENU_WIDTH)).toBe(true);
    expect(near(menu.y - menu.height / 2, pill.y + pill.height / 2 + MENU_GAP)).toBe(true);
  });
}

test('the mirror on a page with zoom 2 in frame 0', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal' });
  const page = await openZoomed(1);
  await expect.poll(() => page.frames().some((f) => f.url() === CROSS_ORIGIN_FRAME), { message: 'frame' }).toBe(true);
  const frame = page.frames().find((f) => f.url() === CROSS_ORIGIN_FRAME);
  await frame.locator('#frame-ta').click();
  await startWithHotkey(page, frame, { indicator: MINI });
  await setZoom(page, 2);

  // A modal over the frame hides its indicator, whatever the zoom did to its place on the page.
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0;';
    document.body.append(dialog);
    dialog.showModal();
  });

  const viewport = await viewportOf(page);
  await expect.poll(async () => atBottomCentre(await mirrorQuery(page, MINI), viewport), { message: 'mirror at the bottom centre' }).toBe(true);
  await expect.poll(() => countPixels(page, RED), { message: 'red pixels of the mirror' }).toBeGreaterThan(MIN_RED);
});
