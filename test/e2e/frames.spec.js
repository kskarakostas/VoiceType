// End-to-end D12 across frames: a dictation started in an iframe field while the user clicks
// into the page is held for the frame field, and the page field keeps the keyboard focus.
// Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, pillStatus, focusField, dictate,
  PORT, TRANSCRIPT, DUMMY_KEY, STATUS,
} from './helpers.js';

const HOLD = 'Return to the field to insert, or click here to copy.';
const FOCUS_MOVED = 'The field lost focus. Text copied to clipboard.';
const SENTINEL = 'clipboard before the copy';
/** Long enough to click into another field while the dictation is processing. */
const TRANSCRIPT_DELAY_MS = 1500;
/**
 * Tall enough for the whole fixture page, so no click scrolls: right after a scroll, Chromium can
 * route a click by the old position of an out-of-process frame.
 */
const VIEWPORT = { width: 1280, height: 2000 };
const FRAMES = [
  ['cross-origin', `http://127.0.0.1:${PORT}/frame.html`],
  ['same-origin', `http://localhost:${PORT}/frame.html`],
];

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {{ method: string, auth: string|null }[]} */
let providerCalls = [];
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, providerCalls, close } = await launchExtension({ transcriptDelayMs: TRANSCRIPT_DELAY_MS }));
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
  // Closing the tab also cancels a session a failed test left behind.
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
});

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

/** @param {import('@playwright/test').Page} page */
const activeId = (page) => page.evaluate(() => document.activeElement?.id ?? '');

/**
 * Dictate into the frame textarea, click the page textarea while the transcript is on its way,
 * and check that the result is held for the frame field without touching the page field.
 * @param {string} url the frame document
 */
async function holdInFrame(url) {
  const page = await openPage();
  const frame = await frameAt(page, url);
  const frameField = frame.locator('#frame-ta');
  const pageField = page.locator('#ta');
  await focusField(frame, frameField);

  await dictate(frame);
  await pageField.click();

  // The frame pill shows no status while processing; the result brings one.
  await expect.poll(() => pillStatus(frame), { message: 'frame result status' }).not.toBe('');
  expect(await activeId(page)).toBe('ta');
  await expect(pageField).toHaveValue('');
  expect(await pillStatus(frame)).toBe(HOLD);
  await expect(frameField).toHaveValue('');
  return { page, frame, frameField, pageField };
}

for (const [name, url] of FRAMES) {
  test(`${name} frame: the result waits for the frame field while the page field keeps focus`, async () => {
    const { frame, frameField, pageField } = await holdInFrame(url);

    await frameField.click();

    await expect(frameField).toHaveValue(TRANSCRIPT);
    await expect.poll(() => pillStatus(frame)).toMatch(/^Done /);
    await expect(frameField).toHaveValue(TRANSCRIPT);
    await expect(pageField).toHaveValue('');
    expect(providerCalls).toHaveLength(1);
  });

  test(`${name} frame: clicking the held status copies while the page field keeps focus`, async () => {
    const { page, frame, frameField, pageField } = await holdInFrame(url);
    await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);

    // The pill cancels mousedown, so this click never gives the frame focus.
    const status = await pillQuery(frame, STATUS);
    await page.mouse.click(status.x, status.y);

    await expect.poll(() => pillStatus(frame)).toBe('Copied to clipboard.');
    expect(await frame.evaluate(() => document.hasFocus())).toBe(false);
    expect(await activeId(page)).toBe('ta');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSCRIPT);
    await expect(pageField).toHaveValue('');
    await expect(frameField).toHaveValue('');
    expect(providerCalls).toHaveLength(1);
  });
}

test('focus moved to another field of the page still takes the clipboard', async () => {
  const page = await openPage();
  const textarea = page.locator('#ta');
  const input = page.locator('#text');
  await focusField(page, textarea);
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);

  await dictate(page);
  await input.click();

  await expect.poll(() => pillStatus(page), { message: 'page result status' }).toBe(FOCUS_MOVED);
  expect(await activeId(page)).toBe('text');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRANSCRIPT);
  await expect(textarea).toHaveValue('');
  await expect(input).toHaveValue('');
  expect(providerCalls).toHaveLength(1);
});
