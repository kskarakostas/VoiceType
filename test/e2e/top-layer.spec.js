// End-to-end coverage of the top layer in the built extension: the page opens a modal dialog, a
// popover or a fullscreen element over a recording, and the indicator stays on top without
// disturbing the page. What shows is read from screenshot pixels: a box in the DOM says nothing
// about what paints over it. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, pillCall, mirrorQuery, pillStatus, waitForPill, clickPill,
  countPixels, focusField, startWithHotkey, PORT, TRANSCRIPT, DUMMY_KEY, STOP, MINI, HOTKEY, RECORD_MS, RED, WHITE,
} from './helpers.js';
import { freshSettings } from '../../src/shared/defaults.js';

const STYLES = ['pill', 'dot', 'minimal'];
const COVER_COLOR = 'rgb(0, 0, 255)';
const BLUE = [0, 0, 255];
/** On no fixture page, unlike blue: its links count as BLUE. */
const MAGENTA = [255, 0, 255];
const COVER_CSS = `position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
  box-sizing: border-box; margin: 0; padding: 0; border: 0; background: ${COVER_COLOR};`;
/** More than the corners of a stray pixel, less than Minimal's four level bars at a low level. */
const MIN_RED = 40;
/** The white of a status; `.pill` of an idle or recording Dot has less. */
const MIN_WHITE = 200;
/** Most of the viewport: the cover really is painted. */
const MIN_BLUE = 1_000_000;
/** More than two raises. */
const ACROSS_RAISES_MS = 600;
/** A raise from a tick must be back within this long. */
const RAISE_BACK_MS = 1000;
/** Long enough to read the pulse across raises while processing. */
const TRANSCRIPT_DELAY_MS = 2500;
const SESSION_OVER_MS = TRANSCRIPT_DELAY_MS + 5000;
/** A pulse restarted by a raise would never get here; two raises is 500 ms. */
const MIN_PULSE_MS = 500;
/** See frames.spec.js: tall enough that no click scrolls. */
const VIEWPORT = { width: 1280, height: 2000 };
const MENU_MODES = 12;
/** The menu scrolls as a whole only in a viewport too short for it; the list of modes scrolls by itself. */
const MENU_SCROLLERS = [
  { scroller: '.list', pointer: '.list', viewport: { width: 1280, height: 500 } },
  { scroller: '.menu', pointer: '.label', viewport: { width: 1280, height: 300 } },
];
const WHEEL_PX = 120;
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;

/** Each opens a cover over the whole viewport, with the id `cover`, in the top document. */
const COVERS = {
  modal: {
    open: () => {
      const dialog = document.createElement('dialog');
      dialog.id = 'cover';
      dialog.style.cssText = window.coverCss;
      document.body.append(dialog);
      dialog.showModal();
    },
    isOpen: () => document.getElementById('cover').matches(':modal'),
  },
  popover: {
    open: () => {
      const box = document.createElement('div');
      box.id = 'cover';
      box.popover = 'auto';
      box.style.cssText = window.coverCss;
      document.body.append(box);
      box.showPopover();
    },
    isOpen: () => document.getElementById('cover').matches(':popover-open'),
  },
  fullscreen: {
    open: async () => {
      const box = document.createElement('div');
      box.id = 'cover';
      box.style.cssText = window.coverCss;
      document.body.append(box);
      await box.requestFullscreen();
    },
    isOpen: () => document.fullscreenElement === document.getElementById('cover'),
  },
};

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, close } = await launchExtension({ transcriptDelayMs: TRANSCRIPT_DELAY_MS }));
});

test.afterAll(async () => {
  await close?.();
});

test.afterEach(async () => {
  // Closing the tab also cancels a session; the launch page stays.
  for (const page of context.pages()) {
    if (/^http:/.test(page.url())) await page.close();
  }
});

/**
 * @param {'pill'|'dot'|'minimal'} pillStyle
 * @param {object} [overrides]
 */
const seedStyle = (pillStyle, overrides = {}) => seedSettings(serviceWorker, DUMMY_KEY, { pillStyle, ...overrides });

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
 * @param {import('@playwright/test').Page} page
 * @param {keyof typeof COVERS} cover
 */
async function openCover(page, cover) {
  await page.evaluate((css) => { window.coverCss = css; }, COVER_CSS);
  await page.evaluate(COVERS[cover].open);
}

/** @param {import('@playwright/test').Page} page */
const pollRed = (page, timeout) => expect
  .poll(() => countPixels(page, RED), { message: 'red pixels of the recording', ...(timeout && { timeout }) })
  .toBeGreaterThan(MIN_RED);

/** @param {import('@playwright/test').Page} page */
const activeElement = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return `${el?.localName}#${el?.id}`;
});

/** @param {import('@playwright/test').Page} page */
const hostOpen = (page) => page.evaluate(() => document.querySelector('voicetype-host').matches(':popover-open'));

/**
 * What a page can do from its own world: every host out of the document.
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>} how many there were
 */
const removeHosts = (page) => page.evaluate(() => {
  const hosts = document.querySelectorAll('voicetype-host');
  for (const host of hosts) host.remove();
  return hosts.length;
});

/**
 * The cover paints and stays open, and raises move no focus.
 * @param {import('@playwright/test').Page} page
 * @param {keyof typeof COVERS} cover
 */
async function expectCoverUndisturbed(page, cover) {
  expect(await page.evaluate(COVERS[cover].isOpen)).toBe(true);
  expect(await countPixels(page, BLUE)).toBeGreaterThan(MIN_BLUE);
  const active = await activeElement(page);
  await page.waitForTimeout(ACROSS_RAISES_MS);
  expect(await activeElement(page)).toBe(active);
  expect(await page.evaluate(COVERS[cover].isOpen)).toBe(true);
}

/**
 * A blue modal holding a blue textarea, with the focus in it.
 * @param {import('@playwright/test').Page} page
 */
async function openModalWithField(page) {
  await page.evaluate((css) => {
    const dialog = document.createElement('dialog');
    dialog.id = 'cover';
    dialog.style.cssText = css;
    const field = document.createElement('textarea');
    field.id = 'modal-ta';
    field.style.cssText = 'background: rgb(0, 0, 255); color: rgb(0, 0, 255); border: 0;';
    dialog.append(field);
    document.body.append(dialog);
    dialog.showModal();
  }, COVER_CSS);
  const field = page.locator('#modal-ta');
  await field.click();
  return field;
}

/** `.pill` as a box, whatever it shows. */
async function pillBox(page) {
  const { x, y, width, height } = await pillQuery(page, '.pill');
  return { x, y, width, height };
}

/**
 * Two equal readings in a row, as the pill animates between its sizes.
 * @param {import('@playwright/test').Page} page
 */
async function settledPillBox(page) {
  let last = null;
  let box = null;
  await expect.poll(async () => {
    box = await pillBox(page);
    const settled = last !== null && JSON.stringify(box) === JSON.stringify(last);
    last = box;
    return settled;
  }, { message: '.pill settled', intervals: [100] }).toBe(true);
  return box;
}

for (const cover of Object.keys(COVERS)) {
  for (const style of STYLES) {
    test(`${cover} over a ${style} recording in the top frame`, async () => {
      await seedStyle(style);
      const page = await openPage();
      const field = page.locator('#ta');
      await focusFor(style, page, field);
      await startWithHotkey(page, page, { indicator: recordingMark(style) });

      await openCover(page, cover);

      await pollRed(page);
      await expectCoverUndisturbed(page, cover);
    });

    test(`${cover} over a ${style} recording in a cross-origin frame: the mirror`, async () => {
      await seedStyle(style);
      const page = await openPage();
      const frame = await frameAt(page, CROSS_ORIGIN_FRAME);
      await focusFor(style, frame, frame.locator('#frame-ta'));
      await startWithHotkey(page, frame, { indicator: recordingMark(style) });

      await openCover(page, cover);

      await expect.poll(async () => (await mirrorQuery(page, MINI)) !== null, { message: 'mirror shown' }).toBe(true);
      await pollRed(page);
      await expectCoverUndisturbed(page, cover);
    });
  }
}

for (const style of ['dot', 'minimal']) {
  test(`a modal open before the press: the text lands in its field and Done paints on top, ${style}`, async () => {
    await seedStyle(style);
    const page = await openPage();
    const field = await openModalWithField(page);

    await startWithHotkey(page, page, { indicator: recordingMark(style) });
    await pollRed(page);
    await page.waitForTimeout(RECORD_MS);
    await page.keyboard.press(HOTKEY);

    await expect(field).toHaveValue(TRANSCRIPT);
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    await expect.poll(() => countPixels(page, WHITE), { message: 'white of the status' }).toBeGreaterThan(MIN_WHITE);
  });
}

test('Done over a modal, then the host leaves the top layer', async () => {
  await seedStyle('dot');
  const page = await openPage();
  const field = await openModalWithField(page);
  await startWithHotkey(page, page);
  expect(await hostOpen(page)).toBe(true);
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);
  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
  expect(await hostOpen(page)).toBe(true);

  await expect.poll(() => pillStatus(page), { message: 'status over' }).toBe('');

  await expect.poll(() => hostOpen(page), { message: 'host out of the top layer' }).toBe(false);
  expect(await page.evaluate(COVERS.modal.isOpen)).toBe(true);
});

test('a page calling hidePopover() on the host loses it for one tick', async () => {
  await seedStyle('dot');
  const page = await openPage();
  await focusField(page, page.locator('#ta'));
  await startWithHotkey(page, page);
  await openCover(page, 'modal');
  await pollRed(page);

  await page.evaluate(() => document.querySelector('voicetype-host').hidePopover());

  await pollRed(page, RAISE_BACK_MS);
  expect(await hostOpen(page)).toBe(true);
});

for (const style of ['dot', 'minimal']) {
  test(`a page removing the host brings it back and the hotkey still stops, ${style}`, async () => {
    await seedStyle(style);
    const page = await openPage();
    const field = page.locator('#ta');
    await focusFor(style, page, field);
    await startWithHotkey(page, page, { indicator: recordingMark(style) });
    await pollRed(page);
    await page.waitForTimeout(RECORD_MS);

    expect(await removeHosts(page)).toBe(1);

    await pollRed(page, RAISE_BACK_MS);
    expect(await hostOpen(page)).toBe(true);
    await page.keyboard.press(HOTKEY);
    await expect(field).toHaveValue(TRANSCRIPT);
  });

  test(`a page removing the mirror's host brings it back and the hotkey still stops, ${style}`, async () => {
    await seedStyle(style);
    const page = await openPage();
    const frame = await frameAt(page, CROSS_ORIGIN_FRAME);
    const field = frame.locator('#frame-ta');
    await focusFor(style, frame, field);
    await startWithHotkey(page, frame, { indicator: recordingMark(style) });
    await page.evaluate(() => {
      for (const iframe of document.querySelectorAll('iframe')) iframe.style.opacity = '0';
    });
    await expect.poll(async () => (await mirrorQuery(page, MINI)) !== null, { message: 'mirror shown' }).toBe(true);
    await pollRed(page);
    await page.waitForTimeout(RECORD_MS);

    expect(await removeHosts(page)).toBeGreaterThan(0);

    await pollRed(page, RAISE_BACK_MS);
    await page.keyboard.press(HOTKEY);
    await expect(field).toHaveValue(TRANSCRIPT);
  });
}

test('a page replacing the root element brings the host back', async () => {
  await seedStyle('minimal');
  const page = await openPage();
  await page.locator('#ta').click();
  await startWithHotkey(page, page, { indicator: MINI });
  await pollRed(page);

  await page.evaluate(() => {
    const root = document.createElement('html');
    root.append(document.createElement('body'));
    document.documentElement.replaceWith(root);
  });

  await pollRed(page, RAISE_BACK_MS);
  expect(await hostOpen(page)).toBe(true);
});

test('a page rule on ::backdrop paints nothing for the host', async () => {
  await seedStyle('dot');
  const page = await openPage();
  await page.addStyleTag({ content: '::backdrop { display: block !important; background: rgb(255, 0, 255) !important; }' });
  await focusField(page, page.locator('#ta'));
  await startWithHotkey(page, page);
  await pollRed(page);
  expect(await hostOpen(page)).toBe(true);

  expect(await countPixels(page, MAGENTA)).toBe(0);
});

test('hostile page CSS and a modal', async () => {
  await seedStyle('pill');
  const reference = await openPage();
  await focusField(reference, reference.locator('#ta'));
  await startWithHotkey(reference, reference);
  const { width, height } = await settledPillBox(reference);
  await reference.close();

  const page = await openPage('hostile.html');
  await focusField(page, page.locator('#hostile-ta'));
  const idle = await settledPillBox(page);
  await startWithHotkey(page, page);

  await openCover(page, 'modal');

  await pollRed(page);
  expect(await settledPillBox(page)).toEqual({ ...idle, width, height });
});

for (const style of ['pill', 'dot']) {
  test(`the raise moves nothing, ${style}`, async () => {
    await seedStyle(style);
    const page = await openPage();
    await focusField(page, page.locator('#ta'));
    const idle = await settledPillBox(page);

    await startWithHotkey(page, page);

    expect(await settledPillBox(page)).toEqual(idle);
    expect(await hostOpen(page)).toBe(true);
    const host = await page.evaluate(() => {
      const { x, y, width, height } = document.querySelector('voicetype-host').getBoundingClientRect();
      return { x, y, width, height };
    });
    expect(host).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
}

test('a pointer held on Stop across a raise still stops', async () => {
  await seedStyle('pill');
  const page = await openPage();
  const field = page.locator('#ta');
  await focusField(page, field);
  await startWithHotkey(page, page);
  await page.waitForTimeout(RECORD_MS);
  const stop = await waitForPill(page, STOP);

  await page.mouse.move(stop.x, stop.y);
  await page.mouse.down();
  await page.waitForTimeout(ACROSS_RAISES_MS);
  await page.mouse.up();

  await expect(field).toHaveValue(TRANSCRIPT);
});

test('keyboard focus on the Stop button survives a raise', async () => {
  await seedStyle('pill');
  const page = await openPage();
  await focusField(page, page.locator('#ta'));
  await startWithHotkey(page, page);
  await page.waitForTimeout(RECORD_MS);

  await pillCall(page, STOP, 'function () { this.focus(); }');
  await page.waitForTimeout(ACROSS_RAISES_MS);
  expect(await activeElement(page)).toBe('voicetype-host#');
  await page.keyboard.press('Enter');

  await expect.poll(() => pillQuery(page, STOP), { message: 'recording stopped' }).toBeNull();
  // The next test starts a session: the worker refuses one while this one is processing.
  await expect.poll(() => pillStatus(page), { message: 'session over', timeout: SESSION_OVER_MS }).not.toBe('');
});

for (const { scroller, pointer, viewport } of MENU_SCROLLERS) {
  test(`an open menu keeps its scroll through raises, ${scroller}`, async () => {
    const modes = { ...freshSettings().modes };
    for (let n = 1; n <= MENU_MODES; n += 1) modes[`custom_${n}`] = { name: `Custom ${n}`, icon: 'x', prompt: 'x', builtIn: false };
    await seedStyle('pill', { modes });
    const page = await openPage();
    await focusField(page, page.locator('#ta'));
    await page.setViewportSize(viewport);
    await startWithHotkey(page, page);
    await clickPill(page, 'button.mode');
    // The usage line is the menu's last render: each replaces the list, and a list scrolled before it.
    await waitForPill(page, '.usage');
    const over = await waitForPill(page, pointer);
    const scrollTop = () => pillCall(page, scroller, 'function () { return this.scrollTop; }');

    await page.mouse.move(over.x, over.y);
    await page.mouse.wheel(0, WHEEL_PX);
    await expect.poll(scrollTop, { message: `${scroller} scrolled` }).toBeGreaterThan(0);
    const scrolled = await scrollTop();
    await page.waitForTimeout(ACROSS_RAISES_MS);

    expect(await scrollTop()).toBe(scrolled);
    expect(await hostOpen(page)).toBe(true);
  });
}

test('the processing pulse does not restart', async () => {
  await seedStyle('pill');
  const page = await openPage();
  const field = page.locator('#ta');
  await focusField(page, field);
  await startWithHotkey(page, page);
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);
  await expect.poll(() => pillQuery(page, STOP), { message: 'processing' }).toBeNull();
  const pulse = () => pillCall(page, '.pill .rec svg', 'function () { return this.getAnimations()[0]?.currentTime ?? null; }');
  await expect.poll(pulse, { message: 'pulse running' }).not.toBeNull();

  const before = await pulse();
  await page.waitForTimeout(ACROSS_RAISES_MS);

  expect(await pulse() - before).toBeGreaterThanOrEqual(MIN_PULSE_MS);
  await expect(field).toHaveValue(TRANSCRIPT);
});
