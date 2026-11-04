// End-to-end coverage for sounds and always-copy in the built extension: what the service worker
// asks the offscreen document for, what really lands on the clipboard, the status when a copy is
// refused, and the settings page. The launch mutes audio, so a cue is proven at the message level;
// the sound itself is a smoke item. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { MSG } from '../../src/shared/messages.js';
import { launchExtension, seedSettings, openFields, pillStatus, focusField, dictate, PORT, TRANSCRIPT, DUMMY_KEY } from './helpers.js';

const SENTINEL = 'clipboard before the dictation';
const HOTKEY = 'Control+Shift+Space';
const REFINED = 'Καλημέρα σας,\nδεύτερη γραμμή με ελληνικά.';
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;
const COPY = { action: MSG.OFFSCREEN_COPY };
/** A Done status and nothing after its cost. */
const DONE = /^Done \S+$/;
const DONE_NOT_COPIED = /^Done \S+ Not copied\.$/;
/** Long enough for a repeated cue to show after the status: the fire-and-forget sends take milliseconds. */
const SETTLE_MS = 300;
/**
 * Keeps the provider busy past Chrome's 5 s user activation window, counted from the STOP click.
 * Inside that window the offscreen copy works even without `clipboardWrite`.
 */
const ACTIVATION_EXPIRED_MS = 7000;
/** The stub's delay plus the expect default the other tests use. */
const SLOW_RESULT_TIMEOUT_MS = ACTIVATION_EXPIRED_MS + 5000;
/** Tall enough for the whole fixture page, so no click scrolls (see frames.spec.js). */
const VIEWPORT = { width: 1280, height: 2000 };

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
/** @type {{ instructions: string, input: string }[]} */
let refineCalls = [];
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, extensionId, refineCalls, close } = await launchExtension({ refineText: REFINED }));
  // The page reads the clipboard, and seeds it so that a copy is visible.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(async () => {
  refineCalls.length = 0;
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind.
  for (const page of context.pages()) {
    if (/^(http|chrome-extension):/.test(page.url())) await page.close();
  }
});

/**
 * Records the cue and copy messages the service worker sends, without their text. Every other
 * message passes through untouched. A worker restart drops the wrapper, so this runs right before
 * each dictation, and offscreenCalls then reads null instead of a misleading empty list.
 * @param {{ refuseCopy?: boolean }} [options] answer OFFSCREEN_COPY with `{ ok: false }` instead of copying
 */
async function installSpy({ refuseCopy = false } = {}) {
  await serviceWorker.evaluate(({ cueAction, copyAction, refuse }) => {
    const original = globalThis.offscreenSpy?.original ?? chrome.runtime.sendMessage;
    const spy = { original, calls: [] };
    globalThis.offscreenSpy = spy;
    chrome.runtime.sendMessage = function sendMessage(...args) {
      const action = args[0]?.action;
      if (action === cueAction) spy.calls.push({ action, cue: args[0].cue });
      if (action === copyAction) {
        spy.calls.push({ action });
        if (refuse) return Promise.resolve({ ok: false });
      }
      return original.apply(this, args);
    };
  }, { cueAction: MSG.OFFSCREEN_CUE, copyAction: MSG.OFFSCREEN_COPY, refuse: refuseCopy });
}

/** @returns {Promise<{ action: string, cue?: string }[]|null>} null when the spy is gone. */
const offscreenCalls = () => serviceWorker.evaluate(() => globalThis.offscreenSpy?.calls ?? null);

/** @param {import('@playwright/test').Page} page */
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} text
 */
const seedClipboard = (page, text) => page.evaluate((value) => navigator.clipboard.writeText(value), text);

/**
 * Seed the settings and the clipboard, focus a field of the fixture page, dictate into it.
 * @param {string} selector
 * @param {Partial<import('../../src/shared/defaults.js').Settings>} [overrides]
 * @param {{ refuseCopy?: boolean }} [spyOptions]
 */
async function dictateInto(selector, overrides = {}, spyOptions = {}) {
  await seedSettings(serviceWorker, DUMMY_KEY, overrides);
  const page = await openFields(context);
  const field = page.locator(selector);
  await seedClipboard(page, SENTINEL);
  await focusField(page, field);
  await installSpy(spyOptions);
  await dictate(page);
  return { page, field };
}

test('both off sends no cue and no copy', async () => {
  const { page, field } = await dictateInto('#ta');

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(DONE);
  await page.waitForTimeout(SETTLE_MS);
  expect(await offscreenCalls()).toEqual([]);
  expect(await readClipboard(page)).toBe(SENTINEL);
});

test('sounds on fires each cue once', async () => {
  const { page, field } = await dictateInto('#ta', { sounds: true });

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(DONE);
  await page.waitForTimeout(SETTLE_MS);
  const calls = await offscreenCalls();
  expect(calls).toEqual(['start', 'stop', 'done'].map((cue) => ({ action: MSG.OFFSCREEN_CUE, cue })));
  expect(await readClipboard(page)).toBe(SENTINEL);
});

test('a double tap while the microphone opens is too short, with no error cue', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { sounds: true });
  const page = await openFields(context);
  const field = page.locator('#ta');
  await focusField(page, field);
  await installSpy();

  await page.keyboard.press(HOTKEY);
  await page.keyboard.press(HOTKEY);

  await expect.poll(() => pillStatus(page)).toBe('Too short, ignored');
  await page.waitForTimeout(SETTLE_MS);
  expect(await offscreenCalls()).toEqual([{ action: MSG.OFFSCREEN_CUE, cue: 'start' }]);
  await expect(field).toHaveValue('');
});

test('always copy after an insert into a textarea', async () => {
  const { page, field } = await dictateInto('#ta', { alwaysCopy: true });

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(DONE);
  expect(await readClipboard(page)).toBe(TRANSCRIPT);
  expect(await offscreenCalls()).toEqual([COPY]);
});

test('always copy after an insert into a contenteditable', async () => {
  const { page, field } = await dictateInto('#ce', { alwaysCopy: true });

  await expect(field).toHaveText(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(DONE);
  expect(await readClipboard(page)).toBe(TRANSCRIPT);
  expect(await offscreenCalls()).toEqual([COPY]);
});

test('always copy after an insert into a cross-origin iframe field', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { alwaysCopy: true });
  // Real focus, as in frames.spec.js.
  const page = await openFields(context, { focusEmulation: false });
  await page.setViewportSize(VIEWPORT);
  await expect.poll(() => page.frames().some((f) => f.url() === CROSS_ORIGIN_FRAME), { message: 'cross-origin frame' }).toBe(true);
  const frame = page.frames().find((f) => f.url() === CROSS_ORIGIN_FRAME);
  const field = frame.locator('#frame-ta');
  await seedClipboard(page, SENTINEL);
  await focusField(frame, field);
  await installSpy();

  await dictate(frame);

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(frame)).toMatch(DONE);
  // The clipboard grant is for the top page's origin, not the frame's.
  expect(await readClipboard(page)).toBe(TRANSCRIPT);
  expect(await offscreenCalls()).toEqual([COPY]);
});

test('a multi-line refined result reaches the clipboard exactly', async () => {
  const { page, field } = await dictateInto('#ta', { alwaysCopy: true, activeMode: 'email' });

  await expect(field).toHaveValue(REFINED);
  await expect.poll(() => pillStatus(page)).toMatch(DONE);
  expect(refineCalls).toHaveLength(1);
  expect(await readClipboard(page)).toBe(REFINED);
  expect(await offscreenCalls()).toEqual([COPY]);
});

test('a refused copy says Not copied', async () => {
  const { page, field } = await dictateInto('#ta', { alwaysCopy: true }, { refuseCopy: true });

  await expect(field).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toMatch(DONE_NOT_COPIED);
  expect(await readClipboard(page)).toBe(SENTINEL);
  expect(await offscreenCalls()).toEqual([COPY]);
});

test('the page saves both settings', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#settings/sound`);
  const sounds = page.locator('#sounds');
  const alwaysCopy = page.locator('#always-copy');
  await expect(sounds).toBeVisible();
  await expect(sounds).not.toBeChecked();
  await expect(alwaysCopy).not.toBeChecked();

  await sounds.check();
  await alwaysCopy.check();

  const stored = () => serviceWorker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    return { sounds: settings.sounds, alwaysCopy: settings.alwaysCopy };
  });
  await expect.poll(stored).toEqual({ sounds: true, alwaysCopy: true });

  await page.reload();
  await expect(sounds).toBeChecked();
  await expect(alwaysCopy).toBeChecked();
  expect(await stored()).toEqual({ sounds: true, alwaysCopy: true });
});

test('always copy still reaches the clipboard after the user activation expired', async () => {
  // The stub's delay is launch-wide, so this case gets a browser of its own.
  const slow = await launchExtension({ transcriptDelayMs: ACTIVATION_EXPIRED_MS });
  try {
    await slow.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
    await seedSettings(slow.serviceWorker, DUMMY_KEY, { alwaysCopy: true });
    const page = await openFields(slow.context);
    const field = page.locator('#ta');
    await seedClipboard(page, SENTINEL);
    await focusField(page, field);

    await dictate(page);

    await expect(field).toHaveValue(TRANSCRIPT, { timeout: SLOW_RESULT_TIMEOUT_MS });
    await expect.poll(() => pillStatus(page), { timeout: SLOW_RESULT_TIMEOUT_MS }).toMatch(DONE);
    expect(await readClipboard(page)).toBe(TRANSCRIPT);
  } finally {
    await slow.close();
  }
});
