// End-to-end V50: a session's messages go to the document that recorded. A frame that navigates
// during processing gets no result in its new document and the text takes the clipboard path; a
// document back from the back-forward cache in time still gets it. The pill's status is the marker
// for a result reaching a document: every result that lands there sets one, and it lasts 2.5 s or
// more. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { sendToFrame } from '../../src/background/tabs.js';
import { launchExtension, seedSettings, openFields, pillStatus, focusField, dictate, PORT, TRANSCRIPT, DUMMY_KEY } from './helpers.js';

const SAME_ORIGIN_FRAME = `http://localhost:${PORT}/frame.html`;
const CROSS_ORIGIN_FRAME = `http://127.0.0.1:${PORT}/frame.html`;
const FRAMES = [['same-origin', SAME_ORIGIN_FRAME, '#same-frame'], ['cross-origin', CROSS_ORIGIN_FRAME, '#cross-frame']];
const SENTINEL = 'clipboard before the dictation';
/** Keeps the provider busy for as long as a navigation and a way back take. */
const TRANSCRIPT_DELAY_MS = 3000;
const RESULT_TIMEOUT_MS = TRANSCRIPT_DELAY_MS + 5000;
/** Long enough for a stray result to show after the clipboard changed: the sends take milliseconds. */
const SETTLE_MS = 300;
/** Playwright turns the back-forward cache off by default. */
const WITH_CACHE = { ignoreDefaultArgs: ['--disable-back-forward-cache'] };
/** Tall enough for the whole fixture page, so no click scrolls (see frames.spec.js). */
const VIEWPORT = { width: 1280, height: 2000 };
/** Inside the textarea of frame.html, from the corner of its iframe. */
const FRAME_FIELD = { x: 100, y: 60 };

test.describe.configure({ mode: 'serial' });

/**
 * Registers one launch for the tests of a describe block.
 * @param {object} [contextOptions]
 */
function launched(contextOptions) {
  /** @type {Awaited<ReturnType<typeof launchExtension>>} */
  const env = /** @type {any} */ ({});

  test.beforeAll(async () => {
    Object.assign(env, await launchExtension({ transcriptDelayMs: TRANSCRIPT_DELAY_MS, contextOptions }));
    // The page reads the clipboard, and seeds it so that a copy is visible.
    await env.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
    await trackDocuments(env.serviceWorker);
  });

  test.afterAll(async () => {
    await env.close?.();
  });

  test.beforeEach(async () => {
    env.providerCalls.length = 0;
    await seedSettings(env.serviceWorker, DUMMY_KEY);
    await env.serviceWorker.evaluate(() => { globalThis.stopSenders.length = 0; });
  });

  test.afterEach(async () => {
    // Closing the tab also cancels a session a failed test left behind.
    for (const page of env.context.pages()) {
      if (page.url().startsWith('http')) await page.close();
    }
  });

  return env;
}

/**
 * Records who sent each STOP_RECORDING, as the router reads it. A worker restart drops this, and
 * the lookup then fails instead of naming a wrong document.
 * @param {import('@playwright/test').Worker} serviceWorker
 */
async function trackDocuments(serviceWorker) {
  await serviceWorker.evaluate(() => {
    globalThis.stopSenders = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.action === 'stopRecording') globalThis.stopSenders.push({ tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId });
    });
  });
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
const readClipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

/**
 * Record in the field and stop. On return the provider has the audio and answers in
 * TRANSCRIPT_DELAY_MS, so whatever the test does next happens during processing.
 * @param {Awaited<ReturnType<typeof launchExtension>>} env
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {import('@playwright/test').Locator} field
 */
async function recordAndStop({ providerCalls }, page, target, field) {
  await focusField(target, field);
  await page.evaluate((text) => navigator.clipboard.writeText(text), SENTINEL);
  await dictate(target);
  await expect.poll(() => providerCalls.length, { message: 'provider call' }).toBe(1);
}

/**
 * The text reached the clipboard and the document that took the frame's place never showed it.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} next the new document
 * @param {import('@playwright/test').Locator} nextField
 * @param {Awaited<ReturnType<typeof launchExtension>>} env
 */
async function expectClipboardOnly(page, next, nextField, { providerCalls }) {
  await expect.poll(() => readClipboard(page), { timeout: RESULT_TIMEOUT_MS, message: 'clipboard' }).toBe(TRANSCRIPT);
  await page.waitForTimeout(SETTLE_MS);
  expect(await pillStatus(next)).toBe('');
  await expect(nextField).toHaveValue('');
  expect(providerCalls).toHaveLength(1);
}

/**
 * What the worker hears for a send to the document that sent the last STOP_RECORDING, with the
 * options sendToFrame builds. Refused with a text of its own, this would count as delivered.
 * @param {import('@playwright/test').Worker} serviceWorker
 * @returns {Promise<string>} the refusal; a send that does not settle within a second fails the test
 */
async function refusalOf(serviceWorker) {
  const { tabId, frameId, documentId } = await serviceWorker.evaluate(() => globalThis.stopSenders.at(-1));
  const outcome = await serviceWorker.evaluate(({ tabId, frameId, documentId }) => Promise.race([
    chrome.tabs.sendMessage(tabId, { action: 'vtProbe' }, { frameId, documentId }).then(() => 'delivered', (err) => String(err?.message ?? err)),
    new Promise((resolve) => { setTimeout(resolve, 1000, 'pending'); }),
  ]), { tabId, frameId, documentId });
  console.log(`refusal, ${await serviceWorker.evaluate(() => navigator.userAgent.match(/Chrome\/\d+/)[0])}: ${outcome}`);
  return outcome;
}

/**
 * The frame field of the document that sent the last STOP_RECORDING. Playwright loses the frames of
 * a page restored from the back-forward cache, so this asks the worker.
 * @param {import('@playwright/test').Worker} serviceWorker
 */
const recordedFieldValue = (serviceWorker) => serviceWorker.evaluate(async () => {
  const { tabId, documentId } = globalThis.stopSenders.at(-1);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    func: () => document.getElementById('frame-ta').value,
  });
  return result;
});

/**
 * sendToFrame's verdict on a text a browser really answered.
 * @param {string} refusal
 */
const reads = (refusal) => sendToFrame({ sendMessage: async () => { throw new Error(refusal); } }, { tabId: 1, frameId: 0 }, {});

test.describe('the old document is gone', () => {
  const env = launched();

  test('a navigated top frame gets no result in its new document and the text reaches the clipboard', async () => {
    const page = await openFields(env.context);
    await recordAndStop(env, page, page, page.locator('#ta'));

    await page.goto(SAME_ORIGIN_FRAME);
    const nextField = page.locator('#frame-ta');
    await nextField.click();

    expect(await reads(await refusalOf(env.serviceWorker))).toBe(false);
    await expectClipboardOnly(page, page, nextField, env);
  });

  for (const [name, url] of FRAMES) {
    test(`a navigated ${name} subframe gets no result in its new document and the text reaches the clipboard`, async () => {
      const page = await openFields(env.context);
      const frame = await frameAt(page, url);
      await recordAndStop(env, page, frame, frame.locator('#frame-ta'));

      await frame.goto(`${url}?next`);
      const nextField = frame.locator('#frame-ta');
      await nextField.click();

      expect(await reads(await refusalOf(env.serviceWorker))).toBe(false);
      await expectClipboardOnly(page, frame, nextField, env);
    });
  }
});

test.describe('the old document is in the back-forward cache', () => {
  const env = launched(WITH_CACHE);

  test('a cached top document gets no result, its successor neither, and the text reaches the clipboard', async () => {
    const page = await openFields(env.context);
    await recordAndStop(env, page, page, page.locator('#ta'));

    await page.goto(SAME_ORIGIN_FRAME);
    const nextField = page.locator('#frame-ta');
    await nextField.click();

    expect(await reads(await refusalOf(env.serviceWorker))).toBe(false);
    await expectClipboardOnly(page, page, nextField, env);
  });

  for (const [name, url] of FRAMES) {
    test(`a ${name} subframe of a cached page gets no result and the text reaches the clipboard`, async () => {
      const page = await openFields(env.context);
      const frame = await frameAt(page, url);
      await recordAndStop(env, page, frame, frame.locator('#frame-ta'));

      await page.goto(SAME_ORIGIN_FRAME);
      const nextField = page.locator('#frame-ta');
      await nextField.click();

      expect(await reads(await refusalOf(env.serviceWorker))).toBe(false);
      await expectClipboardOnly(page, page, nextField, env);
    });
  }

  /** @param {import('@playwright/test').Page} page */
  async function awayAndBack(page) {
    await page.evaluate(() => addEventListener('pageshow', (event) => { window.restored = event.persisted; }));
    await page.goto(SAME_ORIGIN_FRAME);
    await page.goBack({ waitUntil: 'commit' });
    await expect.poll(() => page.evaluate(() => window.restored), { message: 'restored from the cache' }).toBe(true);
  }

  // The tests click back into the field: Chrome 140 restores the page with no focused element, and
  // a result then goes to the clipboard (D12). Chromium 153 keeps the element.
  test('a frame restored from the back-forward cache before the result gets it', async () => {
    const page = await openFields(env.context);
    const field = page.locator('#ta');
    await recordAndStop(env, page, page, field);

    await awayAndBack(page);
    await field.click();

    await expect(field).toHaveValue(TRANSCRIPT, { timeout: RESULT_TIMEOUT_MS });
    await expect.poll(() => pillStatus(page)).toMatch(/^Done /);
    expect(await readClipboard(page)).toBe(SENTINEL);
  });

  for (const [name, url, selector] of FRAMES) {
    test(`a ${name} subframe restored from the back-forward cache before the result gets it`, async () => {
      const page = await openFields(env.context);
      await page.setViewportSize(VIEWPORT);
      const frame = await frameAt(page, url);
      await recordAndStop(env, page, frame, frame.locator('#frame-ta'));

      await awayAndBack(page);
      await page.locator(selector).click({ position: FRAME_FIELD });

      await expect.poll(() => recordedFieldValue(env.serviceWorker), { timeout: RESULT_TIMEOUT_MS, message: 'field of the restored frame' }).toBe(TRANSCRIPT);
      expect(await readClipboard(page)).toBe(SENTINEL);
    });
  }
});
