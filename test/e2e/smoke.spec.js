// End-to-end smoke: the built extension in Playwright's Chromium with a fake microphone and a
// stubbed provider. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshSettings, migrateSettings } from '../../src/shared/defaults.js';
import { writeToneWav } from './wav.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const PORT = Number(process.env.PORT) || 8765;
const FIELDS_URL = `http://localhost:${PORT}/fields.html`;
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIPT = 'stubbed transcript';
const DUMMY_KEY = 'sk-e2e-dummy-key';
const START = 'button[aria-label="Start recording"]';
const STOP = 'button[aria-label="Stop recording"]';
const STATUS = '[role="status"]';
/** Longer than minRecordingTime (1 s), so the recorder does not drop the clip as too short. */
const RECORD_MS = 1500;

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
let workDir = '';
/** @type {{ method: string, auth: string|null }[]} */
const providerCalls = [];

const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'voicetype-e2e-'));
  const tone = writeToneWav(join(workDir, 'tone.wav'), { seconds: 10 });
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${tone}%noloop`,
    ],
  });
  // Leak guard first: any https request that no later route claims is aborted.
  await context.route('https://**', (route) => route.abort());
  // Registered after the guard, so it wins for this URL (the last registered route wins).
  // A context route, never page.route: only context routes see service worker fetches.
  await context.route(TRANSCRIPTION_URL, async (route) => {
    const request = route.request();
    providerCalls.push({ method: request.method(), auth: await request.headerValue('authorization') });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: TRANSCRIPT, usage: { type: 'duration', seconds: 2 } }),
    });
  });
  serviceWorker = context.serviceWorkers().find(isExtensionWorker)
    ?? await context.waitForEvent('serviceworker', { predicate: isExtensionWorker });
  extensionId = new URL(serviceWorker.url()).host;
  // onInstalled stores the default settings; a seed written before that lands is overwritten.
  await expect.poll(() => serviceWorker.evaluate(async () => Boolean((await chrome.storage.local.get('settings')).settings))).toBe(true);
});

test.afterAll(async () => {
  await context?.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  providerCalls.length = 0;
});

test.afterEach(async () => {
  // Closing the tab also cancels a session a failed test left behind.
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
});

/**
 * Store a complete v2 settings object. migrateSettings returning the same reference proves
 * that nothing in it is missing or invalid.
 * @param {string} openaiKey
 */
async function seedSettings(openaiKey) {
  const settings = {
    ...freshSettings(),
    provider: 'openai',
    keys: { openai: openaiKey, gemini: '' },
    activeMode: 'default',
    minRecordingTime: 1,
    maxRecordingTime: 120,
    hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
    autoStopSilenceSec: 0,
  };
  expect(migrateSettings(settings)).toBe(settings);
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

/** @param {any} node CDP DOM.Node */
function findPillHost(node) {
  if (node.localName === 'voicetype-host') return node;
  // children only: frame documents (contentDocument) have pills of their own.
  for (const child of node.children ?? []) {
    const found = findPillHost(child);
    if (found) return found;
  }
  return null;
}

/**
 * The pill lives in a closed shadow root, which page scripts and Playwright selectors cannot
 * enter. The DevTools protocol can: DOM.getDocument with pierce lists closed shadow roots.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector CSS selector inside the top document's pill
 * @returns {Promise<{ x: number, y: number, width: number, height: number, text: string }|null>}
 */
async function pillQuery(page, selector) {
  const cdp = await context.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const shadow = findPillHost(root)?.shadowRoots?.find((r) => r.shadowRootType !== 'user-agent');
    if (!shadow) return null;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector });
    if (!nodeId) return null;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () {
        const r = this.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height, text: this.textContent };
      }`,
      returnByValue: true,
    });
    return result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Waits until `selector` is rendered inside the pill and returns its box. */
async function waitForPill(page, selector, timeout = 10_000) {
  let box = null;
  await expect.poll(async () => {
    box = await pillQuery(page, selector);
    return Boolean(box && box.width > 0 && box.height > 0);
  }, { timeout, message: `pill element ${selector}` }).toBe(true);
  return box;
}

/** A real mouse click, so the pill's mousedown handler keeps focus in the field. */
async function clickPill(page, selector) {
  // Idle, the pill is a dot: its controls sit in a zero-width, clipped bar until hover expands it.
  const body = await waitForPill(page, '.body');
  await page.mouse.move(body.x, body.y);
  // Wait until the bar has expanded and stopped animating: two equal, non-zero widths in a row.
  let lastWidth = -1;
  await expect.poll(async () => {
    const width = (await pillQuery(page, '.bar'))?.width ?? 0;
    const settled = width > 0 && width === lastWidth;
    lastWidth = width;
    return settled;
  }, { message: 'pill bar expanded' }).toBe(true);
  const box = await waitForPill(page, selector);
  await page.mouse.click(box.x, box.y);
}

/** Focuses a field until the idle pill shows (the content script loads at document_idle). */
async function focusField(page, field) {
  await expect(async () => {
    await page.locator('h1').click();
    await field.click();
    const box = await pillQuery(page, START);
    expect(box?.width ?? 0).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
}

async function openFields() {
  const page = await context.newPage();
  await page.goto(FIELDS_URL);
  return page;
}

/** REC, wait for recording, record long enough, REC again. */
async function dictate(page) {
  await clickPill(page, START);
  await waitForPill(page, STOP);
  await page.waitForTimeout(RECORD_MS);
  await clickPill(page, STOP);
}

test('textarea: REC twice inserts the stubbed transcript', async () => {
  await seedSettings(DUMMY_KEY);
  const page = await openFields();
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await dictate(page);

  await expect(textarea).toHaveValue(TRANSCRIPT);
  expect(providerCalls).toEqual([{ method: 'POST', auth: `Bearer ${DUMMY_KEY}` }]);
  const documents = await serviceWorker.evaluate(async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return contexts.map((c) => c.documentUrl);
  });
  expect(documents).toEqual([`chrome-extension://${extensionId}/offscreen.html`]);
});

test('open shadow root: dictation lands at the caret after the first word', async () => {
  await seedSettings(DUMMY_KEY);
  const page = await openFields();
  const editable = page.locator('#shadow-ce'); // CSS locators pierce open shadow roots
  await focusField(page, editable);
  const caret = await page.evaluate(() => {
    const root = document.getElementById('shadow-host').shadowRoot;
    const el = root.getElementById('shadow-ce');
    const text = el.firstChild; // "Hello world"
    const selection = root.getSelection ? root.getSelection() : document.getSelection();
    selection.collapse(text, 'Hello'.length);
    return { inField: selection.anchorNode === text, offset: selection.anchorOffset, focused: root.activeElement === el };
  });
  expect(caret).toEqual({ inField: true, offset: 5, focused: true });

  await dictate(page);

  await expect(editable).toHaveText(`Hello${TRANSCRIPT} world`);
  expect(providerCalls).toHaveLength(1);
});

test('no key: REC shows the add-a-key status and calls no provider', async () => {
  await seedSettings('');
  const page = await openFields();
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await clickPill(page, START);

  await expect.poll(async () => (await pillQuery(page, STATUS))?.text ?? '').toContain('Add an API key');
  await waitForPill(page, START);
  await expect(textarea).toHaveValue('');
  expect(providerCalls).toEqual([]);
});
