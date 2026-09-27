// End-to-end smoke: the built extension in Playwright's Chromium with a fake microphone and a
// stubbed provider. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import {
  launchExtension, seedSettings, openFields, pillQuery, waitForPill, clickPill, focusField, dictate,
  TRANSCRIPT, DUMMY_KEY, START, STATUS,
} from './helpers.js';

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
  ({ context, serviceWorker, extensionId, providerCalls, close } = await launchExtension());
});

test.afterAll(async () => {
  await close?.();
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

test('textarea: REC twice inserts the stubbed transcript', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openFields(context);
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
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openFields(context);
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
  await seedSettings(serviceWorker, '');
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);

  await clickPill(page, START);

  await expect.poll(async () => (await pillQuery(page, STATUS))?.text ?? '').toContain('Add an API key');
  await waitForPill(page, START);
  await expect(textarea).toHaveValue('');
  expect(providerCalls).toEqual([]);
});
