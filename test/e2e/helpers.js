// Shared Playwright helpers: the launch recipe, the settings seed, and access to the pill,
// which lives in a closed shadow root in every frame that page scripts and Playwright
// selectors cannot enter. The DevTools protocol can: DOM.getDocument with pierce lists
// closed shadow roots.
import { expect, chromium } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshSettings, migrateSettings } from '../../src/shared/defaults.js';
import { writeToneWav } from './wav.js';
import { decodePng } from './png.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
export const PORT = Number(process.env.PORT) || 8765;
const FIELDS_URL = `http://localhost:${PORT}/fields.html`;
const TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const REFINE_URL = 'https://api.openai.com/v1/responses';
export const TRANSCRIPT = 'stubbed transcript';
export const DUMMY_KEY = 'sk-e2e-dummy-key';
export const START = 'button[aria-label="Start recording"]';
export const STOP = 'button[aria-label="Stop recording"]';
export const STATUS = '[role="status"]';
export const MINI = '.mini';
export const HOTKEY = 'Control+Shift+Space';
/** `--vt-rec` in pill.css. */
export const RED = [220, 38, 38];
/** `--vt-surface` in pill.css. */
export const WHITE = [255, 255, 255];
/** Longer than minRecordingTime (1 s), so the recorder does not drop the clip as too short. */
export const RECORD_MS = 1500;
/** A press lands within this long or the content script had not loaded: it mounts the pill at once. */
const PRESS_LANDS_MS = 1000;
/** The protocol's answers for a node, or what it resolved to, gone from the document. */
const NODE_GONE = /Could not find node|No node with given id|Node with given id|Could not find object|Cannot find context/;
/** The install tab is on its way when the settings poll ends; a launch without one within this long fails. */
const WELCOME_TAB_MS = 10_000;
/** VT_CHROME_BIN names a Chromium-family binary to run instead of Playwright's Chromium, which Playwright has no variable for. */
const BROWSER = process.env.VT_CHROME_BIN ? { executablePath: process.env.VT_CHROME_BIN } : { channel: 'chromium' };

const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');

/**
 * Launches Chromium with the built extension, a fake microphone and the provider stubbed.
 * @param {{ transcriptDelayMs?: number, contextOptions?: object, refineText?: string, keepWelcome?: boolean }} [options] how
 *   long the stub waits before it answers; extra launchPersistentContext options (color scheme, scale
 *   factor); what the text model answers (without it a refine call is aborted like any other https request);
 *   whether the tab a fresh install opens stays open (by default it is closed, so tests that count tabs hold)
 * @returns {Promise<{
 *   context: import('@playwright/test').BrowserContext,
 *   serviceWorker: import('@playwright/test').Worker,
 *   extensionId: string,
 *   providerCalls: { method: string, auth: string|null }[],
 *   refineCalls: { instructions: string, input: string }[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function launchExtension({ transcriptDelayMs = 0, contextOptions = {}, refineText, keepWelcome = false } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'voicetype-e2e-'));
  /** @type {import('@playwright/test').BrowserContext|undefined} */
  let context;
  const close = async () => {
    await context?.close();
    rmSync(workDir, { recursive: true, force: true });
  };
  try {
    const tone = writeToneWav(join(workDir, 'tone.wav'), { seconds: 10 });
    context = await chromium.launchPersistentContext('', {
      ...contextOptions,
      ...BROWSER,
      headless: true,
      args: [
        `--disable-extensions-except=${DIST}`,
        `--load-extension=${DIST}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${tone}%noloop`,
      ],
    });
    const providerCalls = [];
    // Leak guard first: any https request that no later route claims is aborted.
    await context.route('https://**', (route) => route.abort());
    // Registered after the guard, so it wins for this URL (the last registered route wins).
    // A context route, never page.route: only context routes see service worker fetches.
    await context.route(TRANSCRIPTION_URL, async (route) => {
      const request = route.request();
      providerCalls.push({ method: request.method(), auth: await request.headerValue('authorization') });
      if (transcriptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, transcriptDelayMs));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: TRANSCRIPT, usage: { type: 'duration', seconds: 2 } }),
      });
    });
    const refineCalls = [];
    if (refineText !== undefined) {
      await context.route(REFINE_URL, async (route) => {
        refineCalls.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            output: [{ type: 'message', content: [{ type: 'output_text', text: refineText }] }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        });
      });
    }
    const serviceWorker = context.serviceWorkers().find(isExtensionWorker)
      ?? await context.waitForEvent('serviceworker', { predicate: isExtensionWorker });
    const extensionId = new URL(serviceWorker.url()).host;
    // onInstalled stores the default settings; a seed written before that lands is overwritten.
    await expect.poll(() => serviceWorker.evaluate(async () => Boolean((await chrome.storage.local.get('settings')).settings))).toBe(true);
    if (!keepWelcome) {
      const welcomeUrl = `chrome-extension://${extensionId}/options.html#welcome`;
      const welcomePages = () => context.pages().filter((page) => page.url() === welcomeUrl);
      // Wait for the tab rather than close what is there: one opening late would outlive this launch.
      await expect.poll(() => welcomePages().length, { timeout: WELCOME_TAB_MS }).toBe(1);
      await welcomePages()[0].close();
    }
    return { context, serviceWorker, extensionId, providerCalls, refineCalls, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * Store a complete v2 settings object. migrateSettings returning the same reference proves
 * that nothing in it is missing or invalid.
 * @param {import('@playwright/test').Worker} serviceWorker
 * @param {string} openaiKey
 * @param {Partial<import('../../src/shared/defaults.js').Settings>} [overrides] fields stored over the seed
 */
export async function seedSettings(serviceWorker, openaiKey, overrides = {}) {
  const settings = {
    ...freshSettings(),
    provider: 'openai',
    keys: { openai: openaiKey, gemini: '' },
    activeMode: 'default',
    minRecordingTime: 1,
    maxRecordingTime: 120,
    hotkey: { code: 'Space', ctrl: true, shift: true, alt: false, meta: false },
    autoStopSilenceSec: 0,
    ...overrides,
  };
  expect(migrateSettings(settings)).toBe(settings);
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
}

/**
 * Opens the fixture page. Headless Chromium emulates focus for every page; with
 * `focusEmulation: false` document.hasFocus() reports what a real window would. The
 * override lives as long as its session, so the session stays attached to the page.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {{ focusEmulation?: boolean }} [options]
 */
export async function openFields(context, { focusEmulation = true } = {}) {
  const page = await context.newPage();
  if (!focusEmulation) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  }
  await page.goto(FIELDS_URL);
  return page;
}

/** @param {import('@playwright/test').Page|import('@playwright/test').Frame} target */
function frameOf(target) {
  return typeof target.mainFrame === 'function' ? target.mainFrame() : target;
}

/**
 * A session that sees frame's document: an out-of-process frame (another site) has one of its
 * own; a same-process frame is part of its page's session.
 * @param {import('@playwright/test').Frame} frame
 */
async function sessionFor(frame) {
  const page = frame.page();
  const context = page.context();
  if (!frame.parentFrame()) return context.newCDPSession(page);
  try {
    return await context.newCDPSession(frame);
  } catch {
    return context.newCDPSession(page);
  }
}

/**
 * The document node loaded from url; pierce lists same-process frame documents too.
 * @param {any} node CDP DOM.Node
 * @param {string} url
 */
function findDocument(node, url) {
  if (node.nodeName === '#document' && node.documentURL === url) return node;
  const next = [...(node.children ?? []), ...(node.shadowRoots ?? []), ...(node.contentDocument ? [node.contentDocument] : [])];
  for (const child of next) {
    const found = findDocument(child, url);
    if (found) return found;
  }
  return null;
}

/** @param {any} node CDP DOM.Node */
function findPillHosts(node) {
  if (node.localName === 'voicetype-host') return [node];
  // children only: frame documents (contentDocument) have pills of their own.
  return (node.children ?? []).flatMap(findPillHosts);
}

/** @param {any} host CDP DOM.Node of a pill host */
const shadowOf = (host) => host?.shadowRoots?.find((r) => r.shadowRootType !== 'user-agent');

/**
 * Where frame's viewport starts in its page's viewport.
 * @param {import('@playwright/test').Frame} frame
 */
async function frameOrigin(frame) {
  if (!frame.parentFrame()) return { x: 0, y: 0 };
  const element = await frame.frameElement();
  try {
    const box = await element.boundingBox();
    const inset = await element.evaluate((el) => {
      const style = getComputedStyle(el);
      return { x: el.clientLeft + parseFloat(style.paddingLeft), y: el.clientTop + parseFloat(style.paddingTop) };
    });
    return { x: box.x + inset.x, y: box.y + inset.y };
  } finally {
    await element.dispose();
  }
}

/**
 * The viewport of a page or a frame, in its page's viewport coordinates.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 */
export async function viewportBox(target) {
  const frame = frameOf(target);
  const size = await frame.evaluate(() => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  }));
  return { ...(await frameOrigin(frame)), ...size };
}

/**
 * The element's box in its own viewport (x and y are its centre), text and computed transform.
 * @param {import('@playwright/test').CDPSession} cdp
 * @param {any} shadow CDP DOM.Node of a shadow root
 * @param {string} selector
 * @returns {Promise<{ x: number, y: number, width: number, height: number, text: string, transform: string }|null>}
 */
async function boxInShadow(cdp, shadow, selector) {
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector });
  if (!nodeId) return null;
  const { object } = await cdp.send('DOM.resolveNode', { nodeId });
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function () {
      const r = this.getBoundingClientRect();
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        text: this.textContent,
        transform: getComputedStyle(this).transform,
      };
    }`,
    returnByValue: true,
  });
  return result.value;
}

/**
 * The box (page viewport coordinates), text and computed transform of `selector` inside the pill
 * of a page's top document or of one frame.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {string} selector CSS selector inside the pill
 * @returns {Promise<{ x: number, y: number, width: number, height: number, text: string, transform: string }|null>}
 */
export async function pillQuery(target, selector) {
  const frame = frameOf(target);
  const cdp = await sessionFor(frame);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const doc = findDocument(root, frame.url());
    const shadow = doc && shadowOf(findPillHosts(doc)[0]);
    if (!shadow) return null;
    const box = await boxInShadow(cdp, shadow, selector);
    if (!box) return null;
    const origin = await frameOrigin(frame);
    return { ...box, x: box.x + origin.x, y: box.y + origin.y };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Calls a function on an element inside the pill of a page's top document or of one frame, as page
 * scripts cannot reach a closed root.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {string} selector CSS selector inside the pill
 * @param {string} functionDeclaration `this` is the element; its result comes back by value
 */
export async function pillCall(target, selector, functionDeclaration) {
  const frame = frameOf(target);
  const cdp = await sessionFor(frame);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const doc = findDocument(root, frame.url());
    const shadow = doc && shadowOf(findPillHosts(doc)[0]);
    if (!shadow) return undefined;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: shadow.nodeId, selector });
    if (!nodeId) return undefined;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId });
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, returnByValue: true });
    return result.value;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Like pillQuery on the top document, across every pill host: a page can hold the frame 0 pill and
 * the mirror. A node that went away under a call (the worker removes the mirror at any moment)
 * counts as not there.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector CSS selector inside the pill
 * @returns {Promise<{ x: number, y: number, width: number, height: number, text: string, transform: string }|null>}
 *   the first match with a non-zero box
 */
export async function mirrorQuery(page, selector) {
  const cdp = await sessionFor(page.mainFrame());
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const doc = findDocument(root, page.url());
    for (const host of doc ? findPillHosts(doc) : []) {
      const shadow = shadowOf(host);
      const box = shadow ? await boxInShadow(cdp, shadow, selector) : null;
      if (box && box.width > 0 && box.height > 0) return box;
    }
    return null;
  } catch (err) {
    if (NODE_GONE.test(String(err?.message))) return null;
    throw err;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/**
 * Waits until `selector` is rendered inside the pill and returns its box.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {string} selector
 */
export async function waitForPill(target, selector, timeout = 10_000) {
  let box = null;
  await expect.poll(async () => {
    box = await pillQuery(target, selector);
    return Boolean(box && box.width > 0 && box.height > 0);
  }, { timeout, message: `pill element ${selector}` }).toBe(true);
  return box;
}

/**
 * Whether Minimal's indicator is drawn.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 */
export async function indicatorShown(target) {
  return ((await pillQuery(target, MINI))?.width ?? 0) > 0;
}

/**
 * The text of the pill's status line ('' while none shows).
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 */
export async function pillStatus(target) {
  return (await pillQuery(target, STATUS))?.text ?? '';
}

/**
 * A real mouse click, so the pill's mousedown handler keeps focus in the field.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {string} selector
 */
export async function clickPill(target, selector) {
  const frame = frameOf(target);
  const page = frame.page();
  // Idle, the pill is a dot: its controls sit in a zero-width, clipped bar until hover expands it.
  const body = await waitForPill(frame, '.body');
  await page.mouse.move(body.x, body.y);
  // Wait until the bar has expanded and stopped animating: two equal, non-zero widths in a row.
  let lastWidth = -1;
  await expect.poll(async () => {
    const width = (await pillQuery(frame, '.bar'))?.width ?? 0;
    const settled = width > 0 && width === lastWidth;
    lastWidth = width;
    return settled;
  }, { message: 'pill bar expanded' }).toBe(true);
  const box = await waitForPill(frame, selector);
  await page.mouse.click(box.x, box.y);
}

/**
 * How many pixels of a screenshot of the page are within tolerance of a colour, on every channel.
 * @param {import('@playwright/test').Page} page
 * @param {number[]} rgb
 * @param {number} [tolerance]
 */
export async function countPixels(page, [r, g, b], tolerance = 30) {
  const { data, channels } = decodePng(await page.screenshot());
  let count = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (Math.abs(data[i] - r) <= tolerance && Math.abs(data[i + 1] - g) <= tolerance && Math.abs(data[i + 2] - b) <= tolerance) count += 1;
  }
  return count;
}

/**
 * Focuses a field until the idle pill shows (the content script loads at document_idle).
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {import('@playwright/test').Locator} field
 */
export async function focusField(target, field) {
  const frame = frameOf(target);
  await expect(async () => {
    await frame.page().locator('h1').click();
    await field.click();
    const box = await pillQuery(frame, START);
    expect(box?.width ?? 0).toBeGreaterThan(0);
  }).toPass({ timeout: 15_000 });
}

/**
 * REC, wait for recording, record long enough, REC again.
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 */
export async function dictate(target) {
  await clickPill(target, START);
  await waitForPill(target, STOP);
  await frameOf(target).page().waitForTimeout(RECORD_MS);
  await clickPill(target, STOP);
}

/**
 * Minimal shows nothing until a press lands, and the content script loads at document_idle, so a
 * press that mounts no pill was too early and is sent again. A landed press mounts it at once,
 * before the microphone answers, so a slow microphone never gets a second press.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {{ indicator?: string }} [options] the selector that shows a recording
 */
export async function startWithHotkey(page, target, { indicator = STOP } = {}) {
  await expect(async () => {
    await page.keyboard.press(HOTKEY);
    await expect.poll(async () => (await pillQuery(target, '.vt')) !== null, { timeout: PRESS_LANDS_MS }).toBe(true);
  }).toPass({ timeout: 15_000 });
  await waitForPill(target, indicator);
}

/**
 * Hotkey, wait for recording, record long enough, hotkey again.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Page|import('@playwright/test').Frame} target
 * @param {{ indicator?: string }} [options] the selector that shows a recording
 */
export async function dictateWithHotkey(page, target, options) {
  await startWithHotkey(page, target, options);
  await page.waitForTimeout(RECORD_MS);
  await page.keyboard.press(HOTKEY);
}
