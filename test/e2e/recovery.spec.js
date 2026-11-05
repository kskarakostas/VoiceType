// End-to-end V51 to V53: the audio of a dictation outlives a stopped worker for one retry. The page's
// ping wakes the next worker, which runs the record again; stopped once more, the page reads the lost
// notice. The worker is stopped through DevTools, as nothing natural is known to stop it mid-run. Run
// with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { launchExtension, seedSettings, openFields, pillStatus, focusField, dictate, TRANSCRIPT, DUMMY_KEY } from './helpers.js';

const TRANSCRIPT_URL = 'https://api.openai.com/v1/audio/transcriptions';
/** Long enough to stop the worker inside the call, and for a ping (5 s) to land inside the retry. */
const TRANSCRIPT_DELAY_MS = 8000;
/** Into the provider call. */
const STOP_AFTER_MS = 2000;
/** The next ping, and the worker it wakes reading the record. */
const RETRY_MS = 8000;
const RESULT_MS = TRANSCRIPT_DELAY_MS + 5000;
/** Long enough for a second landing to show: the first call's timer runs out inside it. */
const SETTLE_MS = 7000;
const LOST = 'VoiceType restarted and lost this recording. Try again.';
const FIELD = '#ta';

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {{ method: string, auth: string|null }[]} */
let providerCalls;
/** An extension page, there to read the session area: a stopped worker's Playwright handle is dead. */
let reader;
let extensionId;
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, providerCalls, extensionId, close } = await launchExtension({ transcriptDelayMs: TRANSCRIPT_DELAY_MS }));
  await seedSettings(serviceWorker, DUMMY_KEY);
  reader = await context.newPage();
  await reader.goto(`chrome-extension://${extensionId}/options.html`);
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(() => {
  providerCalls.length = 0;
});

test.afterEach(async () => {
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
  await reader.evaluate(() => chrome.storage.session.remove('pendingDictation'));
});

const record = () => reader.evaluate(async () => (await chrome.storage.session.get('pendingDictation')).pendingDictation ?? null);

/** @param {import('@playwright/test').Page} page */
async function stopWorker(page) {
  const cdp = await context.newCDPSession(page);
  const statuses = [];
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => statuses.push(...versions.map((v) => v.runningStatus)));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');
  await cdp.detach();
}

/** Wait until the page has `calls` provider calls in flight, then stop the worker inside the last. */
async function stopDuringCall(page, calls) {
  await expect.poll(() => providerCalls.length, { timeout: RETRY_MS + 2000 }).toBe(calls);
  await page.waitForTimeout(STOP_AFTER_MS);
  await stopWorker(page);
}

async function dictateInField() {
  const page = await openFields(context);
  const field = page.locator(FIELD);
  await focusField(page, field);
  await dictate(page);
  return { page, field };
}

/**
 * Runs an expression in the content script's own world, the one with the extension API.
 * @param {import('@playwright/test').Page} page
 * @param {string} expression
 */
async function inContentScript(page, expression) {
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on('Runtime.executionContextCreated', ({ context: world }) => worlds.push(world));
  await cdp.send('Runtime.enable');
  const world = worlds.find((w) => w.origin === `chrome-extension://${extensionId}`);
  expect(world, 'the content script world').toBeTruthy();
  const { result } = await cdp.send('Runtime.evaluate', { expression, contextId: world.id, awaitPromise: true, returnByValue: true });
  await cdp.detach();
  return result.value;
}

test('a stopped worker: the text lands once and the stub saw two calls', async () => {
  const { page, field } = await dictateInField();
  await expect.poll(() => providerCalls.length).toBe(1);
  const first = await record();
  expect(first).toMatchObject({ attempts: 0, endpoint: { frameId: 0 } });
  expect(first.audioBase64.length).toBeGreaterThan(0);

  await page.waitForTimeout(STOP_AFTER_MS);
  await stopWorker(page);

  await expect.poll(() => providerCalls.length, { timeout: RETRY_MS }).toBe(2);
  const second = await record();
  expect(second).toMatchObject({ attempts: 1, captureId: first.captureId, at: first.at });
  expect(second.bootId).not.toBe(first.bootId);

  await expect(field).toHaveValue(TRANSCRIPT, { timeout: RESULT_MS });
  await page.waitForTimeout(SETTLE_MS);
  await expect(field).toHaveValue(TRANSCRIPT);
  expect(providerCalls).toHaveLength(2);
  expect(await record()).toBeNull();
});

test('stopped again: the lost notice shows and the stub saw two calls', async () => {
  const { page, field } = await dictateInField();
  await stopDuringCall(page, 1);
  await stopDuringCall(page, 2);

  await expect.poll(() => pillStatus(page), { timeout: RETRY_MS }).toBe(LOST);
  expect(await record()).toBeNull();
  await page.waitForTimeout(SETTLE_MS);
  expect(providerCalls).toHaveLength(2);
  await expect(field).toHaveValue('');
});

test('the record is gone after a success', async () => {
  const { field } = await dictateInField();
  await expect.poll(() => providerCalls.length).toBe(1);
  expect(await record()).not.toBeNull();
  await expect(field).toHaveValue(TRANSCRIPT, { timeout: RESULT_MS });
  await expect.poll(record).toBeNull();
});

test('the record is gone after a failure', async () => {
  const refuse = (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  await context.route(TRANSCRIPT_URL, refuse);
  try {
    const { page } = await dictateInField();
    await expect.poll(() => pillStatus(page)).not.toBe('');
    await expect.poll(record).toBeNull();
    expect(providerCalls).toHaveLength(0);
  } finally {
    await context.unroute(TRANSCRIPT_URL, refuse);
  }
});

test('the record is not readable from a content script', async () => {
  await reader.evaluate(() => {
    globalThis.seenKeys = [];
    chrome.storage.onChanged.addListener((changes) => globalThis.seenKeys.push(...Object.keys(changes)));
  });
  const page = await openFields(context);
  const field = page.locator(FIELD);
  await focusField(page, field);
  await inContentScript(page, `(() => {
    globalThis.seenKeys = [];
    chrome.storage.onChanged.addListener((changes) => globalThis.seenKeys.push(...Object.keys(changes)));
  })()`);
  await dictate(page);
  await expect.poll(() => providerCalls.length).toBe(1);
  expect(await record()).not.toBeNull();

  const answer = await inContentScript(page, `chrome.storage.session.get('pendingDictation').then(
    (items) => 'read: ' + Object.keys(items).join(),
    (err) => 'refused: ' + err.message,
  )`);
  expect(answer).toMatch(/^refused: /);

  await expect(field).toHaveValue(TRANSCRIPT, { timeout: RESULT_MS });
  await expect.poll(() => reader.evaluate(() => globalThis.seenKeys)).toContain('pendingDictation');
  expect(await inContentScript(page, 'globalThis.seenKeys')).toEqual([]);
});
