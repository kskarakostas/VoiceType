// End-to-end coverage of the three pill styles in the built extension: each style on each kind of
// field, the Appearance page acting on an open tab, and the top frame indicator for a recording
// in a frame out of sight. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, mirrorQuery, viewportBox, pillStatus, waitForPill, clickPill,
  focusField, indicatorShown, startWithHotkey, dictateWithHotkey, PORT, TRANSCRIPT, DUMMY_KEY, STOP, STATUS, MINI,
  HOTKEY, RECORD_MS,
} from './helpers.js';

const STYLES = ['pill', 'dot', 'minimal'];
const HOLD = 'Return to the field to insert, or click here to copy.';
const SENTINEL = 'clipboard before the copy';
const HIDE_ONLY = Object.freeze({ hidePill: true, mode: null });
/** Long enough to see processing, and to click into another field meanwhile. */
const TRANSCRIPT_DELAY_MS = 1500;
/** See frames.spec.js: tall enough that no click scrolls. */
const VIEWPORT = { width: 1280, height: 2000 };
/** Set after the click: at scroll 0 both frames of fields.html are below this fold. */
const SHORT_VIEWPORT = { width: 1280, height: 500 };
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
 * Bottom centre of a viewport, the same rule in a frame and in the mirror.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {{ x: number, y: number, width: number, height: number }} view
 */
function expectAtBottomCentre(box, view) {
  expect(box.width).toBe(92);
  expect(Math.abs(box.x - (view.x + view.width / 2))).toBeLessThanOrEqual(1);
  expect(view.y + view.height - (box.y + box.height / 2)).toBeCloseTo(16, 3);
}

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
        expectAtBottomCentre(await pillQuery(target, MINI), await viewportBox(target));
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
  await page.evaluate(({ x, y }) => {
    const button = document.createElement('button');
    button.id = 'under';
    button.dataset.clicks = '0';
    button.style.cssText = `position: fixed; left: ${x - 200}px; top: ${y - 100}px; width: 400px; height: 120px;`;
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1); });
    document.body.append(button);
  }, indicator);
  const clicks = () => page.evaluate(() => Number(document.getElementById('under').dataset.clicks));

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

test('Minimal: the menu is unreachable', async () => {
  await seedStyle('minimal');
  const page = await openPage();
  const field = page.locator('#ta');
  await field.click();
  await page.waitForTimeout(NO_PILL_MS);
  // Where the other styles sit: right of this field, which has no room on its left.
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
  await context.newPage();

  await loseWindowFocus(page);
  await expect.poll(() => widthOf(page, '.body'), { message: 'idle pill hidden' }).toBe(0);
  await seedStyle('pill');
  await page.waitForTimeout(NO_PILL_MS);
  expect(await widthOf(page, '.body')).toBe(0);

  await page.bringToFront();
  await field.click();

  await expect.poll(() => widthOf(page, '.body'), { timeout: PILL_SYNC_MS }).toBeGreaterThan(OPEN_WIDTH);
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
  await expect(page.locator('.style-card').last()).toBeVisible();

  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));

  expect(client).toBeLessThanOrEqual(380);
  expect(scroll).toBeLessThanOrEqual(client);
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

  test(`mirror, ${name}: rapid scroll out and back leaves no indicator`, async () => {
    const { page } = await recordInFrame({ url, selector });

    const removed = await page.evaluate(async (s) => {
      let gone = 0;
      const hosts = new MutationObserver((records) => {
        for (const { removedNodes } of records) gone += removedNodes.length;
      });
      hosts.observe(document.documentElement, { childList: true });
      const beat = () => new Promise((resolve) => { setTimeout(resolve, 60); });
      for (let flip = 0; flip < 6; flip += 1) {
        window.scrollTo(0, 0);
        await beat();
        document.querySelector(s).scrollIntoView({ block: 'center' });
        await beat();
      }
      hosts.disconnect();
      return gone;
    }, selector);

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

      await expect.poll(async () => (await mirrorQuery(page, STATUS))?.text ?? '', { message: 'frame 0 status' }).toContain('busy');
      const mini = await mirrorQuery(page, MINI);
      const status = await mirrorQuery(page, STATUS);
      expect(mini).not.toBeNull();
      const overlaps = Math.abs(mini.x - status.x) < (mini.width + status.width) / 2
        && Math.abs(mini.y - status.y) < (mini.height + status.height) / 2;
      expect(overlaps).toBe(false);
    });
  }

  // The indicator keeps EDGE (4 px) from the top of a short frame, so a frame viewport of 18 px
  // holds half of its 28 px: 40 px holds all of it, and only under 18 px is it out of sight.
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
