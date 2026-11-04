// End-to-end coverage for the settings page and the quick-panel popup in the built extension:
// route opening with tab reuse, saves that survive closing the tab, a mouse press on the
// Dictionary's buttons, the pill following a change made on the page, Reset to defaults, Home
// counting a dictation, and History and Copy last over a real dictation. Run with
// `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { migrateSettings } from '../../src/shared/defaults.js';
import { CONFIRM_GUARD_MS } from '../../src/ui/form.js';
import { launchExtension, seedSettings, openFields, pillQuery, focusField, dictate, DUMMY_KEY, PORT, TRANSCRIPT } from './helpers.js';

/** The acceptance budget: closing the tab this long after typing keeps the value (spec 6.1). */
const CLOSE_AFTER_MS = 1000;
/** The pill shows a mode chosen on the settings page within this long (spec 6.1). */
const PILL_SYNC_MS = 1000;
const PASTED_KEY = 'sk-e2e-pasted-key';

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
  // Every case starts with no settings tab open; the launch page stays.
  for (const page of context.pages()) {
    if (/^(http|chrome-extension):/.test(page.url())) await page.close();
  }
});

const extensionUrl = (path) => `chrome-extension://${extensionId}/${path}`;

const settingsPages = () => context.pages().filter((page) => page.url().startsWith(extensionUrl('options.html')));

/** The stored settings, keys included, as the service worker reads them. */
const storedSettings = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

/**
 * Opens the settings page at a route and waits until it has loaded the stored settings: the
 * first render builds the mode rows, and a failed load shows the banner.
 * @param {string} route
 */
async function openSettingsPage(route) {
  const page = await context.newPage();
  await page.goto(extensionUrl(`options.html#${route}`));
  await expect(page.locator('#mode-list .mode-select').first()).toBeAttached();
  await expect(page.locator('#banner')).toBeHidden();
  return page;
}

/**
 * Stores `dictionary` over the current settings.
 * @param {Record<string, string[]>} dictionary
 */
async function seedDictionary(dictionary) {
  const seed = { ...(await storedSettings()), dictionary };
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), seed);
}

/** A press long enough for what a blur does at mousedown to land before the mouse comes up. */
const PRESS_MS = 60;

/** Opens popup.html as a page; its buttons close it, so callers ignore its closing. */
async function openPopup() {
  const page = await context.newPage();
  await page.goto(extensionUrl('popup.html'));
  return page;
}

/**
 * Whether the tab showing the settings page is the active tab of its window.
 * @returns {Promise<boolean[]>} one entry per settings tab
 */
const settingsTabsActive = () => serviceWorker.evaluate(async (base) => {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const tabs = contexts.filter((c) => c.documentUrl?.split('#')[0] === base);
  return Promise.all(tabs.map(async (c) => (await chrome.tabs.get(c.tabId)).active));
}, extensionUrl('options.html'));

test('the popup opens a route and reuses the settings tab', async () => {
  await seedSettings(serviceWorker, '');
  const first = await openPopup();
  const [settingsPage] = await Promise.all([
    context.waitForEvent('page', { predicate: (page) => page.url().startsWith(extensionUrl('options.html')) }),
    first.getByRole('button', { name: 'Open settings' }).click(),
  ]);
  await expect(settingsPage).toHaveURL(extensionUrl('options.html#home'));
  await expect(settingsPage.locator('section[data-route="home"]')).toBeVisible();
  await settingsPage.evaluate(() => { window.__marker = 1; });

  const second = await openPopup();
  // The new popup tab is in front, so the focus check below is not vacuous.
  await expect.poll(settingsTabsActive).toEqual([false]);
  await second.getByRole('button', { name: 'Add API key' }).click();

  await expect(settingsPage).toHaveURL(extensionUrl('options.html#settings/provider'));
  expect(settingsPages()).toHaveLength(1);
  expect(settingsPages()[0]).toBe(settingsPage);
  expect(await settingsPage.evaluate(() => window.__marker)).toBe(1);
  await expect(settingsPage.locator('section[data-route="settings/provider"]')).toBeVisible();
  await expect.poll(settingsTabsActive).toEqual([true]);
});

test('a value typed on the settings page survives closing the tab one second later', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('dictionary');
  const field = page.locator('#dictionary-input-any');
  await expect(field).toHaveValue('');

  await field.pressSequentially('Palowise');
  await page.waitForTimeout(CLOSE_AFTER_MS);
  await page.close();

  await expect.poll(async () => (await storedSettings()).dictionary.any).toEqual(['Palowise']);
  const reopened = await openSettingsPage('dictionary');
  await expect(reopened.locator('.chip-text')).toHaveText('Palowise');
});

test('a value typed on the settings page survives closing the tab with the worker asleep', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('dictionary');

  const cdp = await context.newCDPSession(page);
  const statuses = [];
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => statuses.push(...versions.map((v) => v.runningStatus)));
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');

  await page.locator('#dictionary-input-any').pressSequentially('Palowise');
  await page.waitForTimeout(CLOSE_AFTER_MS);
  await page.close();

  await expect.poll(async () => (await storedSettings()).dictionary.any).toEqual(['Palowise']);
});

test('a press on Add language lands while the field above it adds its text', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('dictionary');
  const field = page.locator('#dictionary-input-any');
  await page.locator('#dictionary-language').selectOption('de');
  await field.pressSequentially('Palowise');

  await page.locator('#dictionary-add-group').click({ delay: PRESS_MS });

  await expect.poll(async () => (await storedSettings()).dictionary).toEqual({ any: ['Palowise'], de: [] });
  await expect(page.locator('#dictionary-input-de')).toBeFocused();
  await expect(page.locator('#dictionary-language option[value="de"]')).toHaveCount(0);
});

test('Remove group lands under a field with text, and the group stays gone', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  await seedDictionary({ el: ['Noesis'] });
  const page = await openSettingsPage('dictionary');
  const button = page.locator('.dictionary-group[data-group="el"] [data-role="remove-group"]');
  await page.locator('#dictionary-input-el').pressSequentially('Palowise');

  await button.click({ delay: PRESS_MS });
  await expect(button).toHaveAttribute('data-confirming', 'true');
  await page.waitForTimeout(CONFIRM_GUARD_MS + 100);
  await button.click({ delay: PRESS_MS });

  await expect(page.locator('.dictionary-group[data-group="el"]')).toHaveCount(0);
  await expect(page.locator('#dictionary-input-any')).toBeFocused();
  await expect.poll(async () => (await storedSettings()).dictionary).toEqual({});
});

test('a key pasted on the settings page survives closing the tab one second later', async () => {
  await seedSettings(serviceWorker, '');
  const page = await openSettingsPage('settings/provider');
  const key = page.locator('#key-openai');
  await expect(key).toHaveAttribute('placeholder', 'sk-...');

  await key.fill(PASTED_KEY);
  await page.waitForTimeout(CLOSE_AFTER_MS);
  await page.close();

  await expect.poll(async () => (await storedSettings()).keys.openai).toBe(PASTED_KEY);
  // The field never shows a saved key; its placeholder masks it.
  const reopened = await openSettingsPage('settings/provider');
  await expect(reopened.locator('#key-openai')).toHaveAttribute('placeholder', 'sk-e…-key (saved)');
  await expect(reopened.locator('#key-openai')).toHaveValue('');
});

test('the pill reflects a mode chosen on the settings page within one second', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const fields = await openFields(context);
  await focusField(fields, fields.locator('#ta'));
  await expect.poll(() => pillQuery(fields, 'button[aria-label^="Mode: Default."]')).not.toBeNull();

  const page = await openSettingsPage('modes');
  await page.locator('button[data-focus-key="select:email"]').click();

  await expect.poll(() => pillQuery(fields, 'button[aria-label^="Mode: Email."]'), { timeout: PILL_SYNC_MS }).not.toBeNull();
  expect((await storedSettings()).activeMode).toBe('email');
});

test('Reset keeps keys, dictionary and site rules', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const seed = {
    ...(await storedSettings()),
    dictionary: { any: ['Palowise'], de: ['Karakostas'] },
    siteRules: { 'example.com': { hidePill: true, mode: 'email' } },
    pillStyle: 'minimal',
  };
  expect(migrateSettings(seed)).toBe(seed);
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), seed);

  const page = await openSettingsPage('settings/usage');
  const reset = page.locator('#reset');
  await reset.click();
  await expect(reset).toHaveAttribute('data-confirming', 'true');
  // A second click inside the guard is ignored; wait past it.
  await page.waitForTimeout(CONFIRM_GUARD_MS + 100);
  await reset.click();

  await expect.poll(async () => (await storedSettings()).pillStyle).toBe('dot');
  const after = await storedSettings();
  expect(after.keys).toEqual(seed.keys);
  expect(after.dictionary).toEqual(seed.dictionary);
  expect(after.siteRules).toEqual(seed.siteRules);
});

test('Home counts the words of a dictation', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const fields = await openFields(context);
  const textarea = fields.locator('#ta');
  await focusField(fields, textarea);
  await dictate(fields);
  await expect(textarea).toHaveValue(TRANSCRIPT);

  const page = await context.newPage();
  await page.goto(extensionUrl('options.html#home'));
  // The stub's transcript is two words. The worker logs usage before it answers, so the log is
  // written before the page opens: this covers Home's load on mount.
  await expect(page.locator('#home-words-week')).toHaveText('2');
  await expect(page.locator('#home-days li[aria-current="date"]')).toHaveAttribute('data-state', 'dictated');
});

test('History shows a real dictation on an open page, Copy and Copy last copy it, and off clears it', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  await serviceWorker.evaluate(() => chrome.storage.session.remove('history'));
  // The worker owns the entries: the open page hears of this one through storage.onChanged.
  const page = await openSettingsPage('history');
  await expect(page.locator('#history-empty')).toHaveText('No dictations yet.');

  const fields = await openFields(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
  const textarea = fields.locator('#ta');
  await focusField(fields, textarea);
  await dictate(fields);
  await expect(textarea).toHaveValue(TRANSCRIPT);

  const entry = page.locator('#history-list .history-entry');
  await expect(entry).toHaveCount(1);
  await expect(entry.locator('.history-text')).toHaveText(TRANSCRIPT);
  await expect(entry.locator('.history-meta')).toContainText('localhost');
  await expect(entry.getByRole('button', { name: 'Copy original' })).toHaveCount(0);

  const clipboard = async () => {
    await fields.bringToFront();
    return fields.evaluate(() => navigator.clipboard.readText());
  };
  await fields.evaluate(() => navigator.clipboard.writeText('before the copy'));
  await page.bringToFront();
  await entry.getByRole('button', { name: /^Copy dictation/ }).click();
  await expect(page.locator('#toast')).toHaveText('Copied to clipboard.');
  expect(await clipboard()).toBe(TRANSCRIPT);

  await fields.evaluate(() => navigator.clipboard.writeText('before Copy last'));
  const popup = await openPopup();
  await expect(popup.locator('#copy-last')).toBeEnabled();
  await popup.locator('#copy-last').click();
  await expect(popup.locator('#toast')).toHaveText('Copied to clipboard.');
  expect(await clipboard()).toBe(TRANSCRIPT);

  await page.bringToFront();
  await page.locator('#keep-history').click();
  await expect(page.locator('#history-empty')).toHaveText('History is off.');
  await expect(entry).toHaveCount(0);
  await expect.poll(() => serviceWorker.evaluate(async () => (await chrome.storage.session.get('history')).history ?? [])).toEqual([]);
  await popup.reload();
  await expect(popup.locator('#copy-last')).toBeHidden();
});
