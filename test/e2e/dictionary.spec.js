// End-to-end coverage for Dictionary export and import in the built extension, through a real
// download and a real file chooser. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launchExtension, seedSettings, DUMMY_KEY } from './helpers.js';

const UTF8_BOM = [0xef, 0xbb, 0xbf];

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
let extensionId = '';
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, extensionId, close } = await launchExtension());
});

test.afterAll(async () => {
  await close?.();
});

test.afterEach(async () => {
  for (const page of context.pages()) {
    if (page.url().startsWith('chrome-extension:')) await page.close();
  }
});

/** The stored settings, as the service worker reads them. */
const storedSettings = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

/**
 * Stores `dictionary` over fresh settings and opens the Dictionary page on them.
 * @param {Record<string, string[]>} dictionary
 */
async function openDictionary(dictionary) {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const seed = { ...(await storedSettings()), dictionary };
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), seed);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html#dictionary`);
  await expect(page.locator('#dictionary-input-any')).toBeAttached();
  await expect(page.locator('#banner')).toBeHidden();
  return page;
}

/**
 * Clicks Import and hands the real file chooser one file.
 * @param {import('@playwright/test').Page} page
 * @param {{ name: string, mimeType: string, buffer: Buffer }} file
 */
async function importFile(page, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('#dictionary-import').click()]);
  await chooser.setFiles(file);
}

test('the export file has a BOM and importing it changes nothing', async () => {
  const dictionary = { any: ['Palowise'], el: ['Νόηση'] };
  const page = await openDictionary(dictionary);

  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#dictionary-export').click()]);
  expect(download.suggestedFilename()).toBe('voicetype-dictionary.csv');
  const bytes = readFileSync(await download.path());
  expect([...bytes.subarray(0, UTF8_BOM.length)]).toEqual(UTF8_BOM);
  expect(bytes.subarray(UTF8_BOM.length).toString('utf8')).toBe('language,term\r\nany,Palowise\r\nel,Νόηση\r\n');

  await importFile(page, { name: download.suggestedFilename(), mimeType: 'text/csv', buffer: bytes });
  await expect(page.locator('#dictionary-status')).toContainText('Nothing new');
  await expect(page.locator('#dictionary-file')).toHaveValue('');
  expect((await storedSettings()).dictionary).toEqual(dictionary);
});

test('a one-column file lands in All languages', async () => {
  const page = await openDictionary({});

  await importFile(page, { name: 'terms.txt', mimeType: 'text/plain', buffer: Buffer.from('Noesis\nCommetric\n') });

  await expect(page.locator('.dictionary-group[data-group="any"] .chip-text')).toHaveText(['Noesis', 'Commetric']);
  await expect(page.locator('#dictionary-status')).toHaveText('Imported 2 terms.');
  await expect.poll(async () => (await storedSettings()).dictionary.any).toEqual(['Noesis', 'Commetric']);
});

test('an import over the cap changes nothing', async () => {
  const dictionary = { any: Array.from({ length: 95 }, (_, i) => `seeded${i}`) };
  const page = await openDictionary(dictionary);
  const terms = Array.from({ length: 10 }, (_, i) => `new${i}`).join('\n');

  await importFile(page, { name: 'terms.csv', mimeType: 'text/csv', buffer: Buffer.from(terms) });

  await expect(page.locator('#dictionary-status')).toContainText('by 5');
  await expect(page.locator('#dictionary-status')).toHaveAttribute('data-tone', 'error');
  await expect(page.locator('#dictionary-count')).toHaveText('95 of 100 terms');
  expect((await storedSettings()).dictionary).toEqual(dictionary);
});

test('a real double click on a chip removes one term', async () => {
  const page = await openDictionary({ any: ['aaa', 'bbb', 'ccc', 'ddd'] });

  await page.getByRole('button', { name: 'Remove aaa' }).dblclick();

  await expect(page.locator('.dictionary-group[data-group="any"] .chip-text')).toHaveText(['bbb', 'ccc', 'ddd']);
  await expect.poll(async () => (await storedSettings()).dictionary.any).toEqual(['bbb', 'ccc', 'ddd']);
});

test('a real paste of a line list adds one term per line', async () => {
  const page = await openDictionary({});
  const field = page.locator('#dictionary-input-any');
  // Chromium refuses to grant clipboard permissions to an extension origin, so a real copy fills it.
  await page.evaluate((text) => document.addEventListener('copy', (event) => {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }, { once: true }), 'Alpha\r\nBeta\r\nGamma\r\n');
  await field.focus();
  await page.keyboard.press('Control+C');

  await page.keyboard.press('Control+V');
  await expect(field).toHaveValue('Alpha, Beta, Gamma');
  await field.press('Enter');

  await expect.poll(async () => (await storedSettings()).dictionary.any).toEqual(['Alpha', 'Beta', 'Gamma']);
});
