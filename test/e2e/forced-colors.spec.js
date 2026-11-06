// End-to-end coverage of forced colours in the built extension: the style previews, the pill and
// the segmented control keep what only a background or a shadow drew. Chromium reports forced
// values through getComputedStyle, so a background the mode took reads as the page's. Run with
// `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { REC_COLORS } from '../../src/shared/defaults.js';
import { launchExtension, seedSettings, openFields, focusField, pillCall, startWithHotkey, DUMMY_KEY, MINI, RED } from './helpers.js';
import { decodePng } from './png.js';

/** Keeps a row of text off the ends of the plate. */
const INK_INSET_PX = 2;

/** @type {Awaited<ReturnType<typeof launchExtension>>} */
let vt;

test.beforeAll(async () => {
  vt = await launchExtension({ contextOptions: { forcedColors: 'active' } });
});

test.afterAll(async () => {
  await vt?.close();
});

test.afterEach(async () => {
  // The launch page stays: it keeps the context open.
  for (const page of vt.context.pages()) {
    if (/^(http|chrome-extension):/.test(page.url())) await page.close();
  }
});

/** @param {import('@playwright/test').Locator} locator */
const backgroundOf = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);

/**
 * How many pixels differ from the first on a row through the middle of an element's text, which
 * crosses its strokes: none when the text is lost. Chromium paints a Canvas plate behind forced
 * text, which no computed value shows, and the row stays inside it.
 * @param {import('@playwright/test').Locator} locator
 */
async function inkOf(locator) {
  const clip = await locator.evaluate((el, inset) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const { x, y, width, height } = range.getBoundingClientRect();
    return { x: x + inset, y: y + height / 2, width: width - 2 * inset, height: 1 };
  }, INK_INSET_PX);
  const { data, channels } = decodePng(await locator.page().screenshot({ clip }));
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] !== data[0] || data[i + 1] !== data[1] || data[i + 2] !== data[2]) count += 1;
  }
  return count;
}

/** @param {string} route */
async function openOptions(route) {
  const page = await vt.context.newPage();
  await page.goto(`chrome-extension://${vt.extensionId}/options.html#${route}`);
  return page;
}

/**
 * The outline of the pill's visible body. Width alone proves nothing: with no outline, Chromium 153
 * reports the initial 3px where Chrome 140 reports 0px.
 * @param {string} pillStyle
 */
async function pillOutline(pillStyle) {
  await seedSettings(vt.serviceWorker, DUMMY_KEY, { pillStyle });
  const page = await openFields(vt.context);
  await focusField(page, page.locator('#ta'));
  return pillCall(page, '.body', `function () {
    const { outlineStyle, outlineWidth } = getComputedStyle(this);
    return { outlineStyle, outlineWidth: parseFloat(outlineWidth) };
  }`);
}

test('each style preview shows the pill as well as the field', async () => {
  const page = await openOptions('settings/appearance');

  for (const mark of ['.preview-bar', '.preview-dot', '.preview-mini']) {
    const locator = page.locator(mark);
    await expect(locator).toBeVisible();
    expect(await backgroundOf(locator), mark).not.toBe(await backgroundOf(page.locator('.style-preview', { has: locator })));
  }
});

test('a recording colour swatch keeps its own colour, and the chosen card keeps its mark', async () => {
  await seedSettings(vt.serviceWorker, DUMMY_KEY, { recColor: 'red' });
  const page = await openOptions('settings/appearance');
  const radio = (value) => page.locator(`input[name="rec-color"][value="${value}"]`);
  const card = (value) => page.locator('.style-card', { has: radio(value) });
  await expect(radio('red')).toBeChecked();

  const swatches = await Promise.all(REC_COLORS.map((value) => card(value).locator('.swatch').evaluate((el) => {
    const { backgroundColor, borderTopColor, borderTopStyle } = getComputedStyle(el);
    return { backgroundColor, borderTopColor, borderTopStyle };
  })));
  expect(new Set(swatches.map((s) => s.backgroundColor)).size).toBe(REC_COLORS.length);
  expect(swatches[0].backgroundColor).toBe(`rgb(${RED.join(', ')})`);
  for (const swatch of swatches) {
    expect(swatch.borderTopStyle).toBe('solid');
    expect(swatch.borderTopColor).not.toBe(swatch.backgroundColor);
  }

  const outline = (value) => card(value).evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(await outline('red')).toBe('solid');
  expect(await outline('mocha')).toBe('none');
  await expect(card('red').locator('.style-name')).toHaveText('Classic red');
});

for (const [name, pillStyle] of [['the pill bar', 'pill'], ['the collapsed dot', 'dot']]) {
  test(`${name} has an outline`, async () => {
    const { outlineStyle, outlineWidth } = await pillOutline(pillStyle);

    expect(outlineStyle).toBe('solid');
    expect(outlineWidth).toBeGreaterThan(0);
  });
}

test('Minimal keeps its level bars and an edge while it records', async () => {
  await seedSettings(vt.serviceWorker, DUMMY_KEY, { pillStyle: 'minimal' });
  const page = await openFields(vt.context);
  await page.locator('#ta').click();
  await startWithHotkey(page, page, { indicator: MINI });

  const drawn = await pillCall(page, MINI, `function () {
    const plate = getComputedStyle(this);
    return {
      plate: plate.backgroundColor,
      outlineStyle: plate.outlineStyle,
      outlineWidth: parseFloat(plate.outlineWidth),
      bars: [...this.querySelectorAll('.lvl')]
        .filter((bar) => getComputedStyle(bar).display !== 'none')
        .map((bar) => getComputedStyle(bar).backgroundColor),
    };
  }`);

  expect(drawn.outlineStyle).toBe('solid');
  expect(drawn.outlineWidth).toBeGreaterThan(0);
  // Medium, the default size, shows six of the ten bars.
  expect(drawn.bars).toHaveLength(6);
  for (const bar of drawn.bars) expect(bar).not.toBe(drawn.plate);
});

test('a selected segment differs from an unselected one', async () => {
  const page = await openOptions('settings/provider');
  const track = page.locator('.segmented');
  const label = (value) => track.locator(`input[value="${value}"] + span`);
  const colorOf = (locator) => locator.evaluate((el) => getComputedStyle(el).color);
  await expect(track.locator('input[value="openai"]')).toBeChecked();

  // Transparent on the unselected one: the two computed values differ even when both paint the track.
  const selected = await backgroundOf(label('openai'));
  expect(selected).not.toBe(await backgroundOf(track));
  expect(selected).not.toBe(await backgroundOf(label('gemini')));
  expect(await colorOf(label('openai'))).not.toBe(await colorOf(label('gemini')));
  expect(await inkOf(label('openai'))).toBeGreaterThan(0);
  expect(await inkOf(label('gemini'))).toBeGreaterThan(0);
});

test('a focused selected segment keeps a ring that shows on the track', async () => {
  const page = await openOptions('settings/provider');
  const track = page.locator('.segmented');
  await track.locator('input:checked').focus();
  const focused = track.locator('input:focus-visible + span');
  await expect(focused).toHaveCount(1);

  const { outlineStyle, outlineColor, boxShadow } = await focused.evaluate((el) => getComputedStyle(el));
  expect(outlineStyle).toBe('solid');
  expect(outlineColor).not.toBe(await backgroundOf(track));
  expect(boxShadow).toBe('none');
});
