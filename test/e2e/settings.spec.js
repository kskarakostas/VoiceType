// End-to-end coverage for the settings page and the quick-panel popup in the built extension:
// route opening with tab reuse, saves that survive closing the tab, a mouse press on the
// Dictionary's buttons, the pill following a change made on the page, Reset to defaults, Home
// counting a dictation, History and Copy last over a real dictation, and the first-install page. Run with
// `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { migrateSettings } from '../../src/shared/defaults.js';
import { CUE_NAMES, CUE_SETS } from '../../src/offscreen/cues.js';
import { CONFIRM_GUARD_MS } from '../../src/ui/form.js';
import { launchExtension, seedSettings, openFields, pillQuery, focusField, dictate, DUMMY_KEY, PORT, TRANSCRIPT } from './helpers.js';
import { decodePng } from './png.js';

/** The acceptance budget: closing the tab this long after typing keeps the value (spec 6.1). */
const CLOSE_AFTER_MS = 1000;
/** The pill shows a mode chosen on the settings page within this long (spec 6.1). */
const PILL_SYNC_MS = 1000;
const PASTED_KEY = 'sk-e2e-pasted-key';
/** How long after a worker wake a second welcome tab would have opened by. */
const WAKE_WINDOW_MS = 1000;

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

/**
 * Picks a card by its top left corner: on a sound set card the Play button covers the middle of it.
 * @param {import('@playwright/test').Page} page
 */
const choose = (page, name, value) => page.locator(`input[name="${name}"][value="${value}"]`).check({ position: { x: 4, y: 4 } });

const extensionUrl = (path) => `chrome-extension://${extensionId}/${path}`;

const settingsPages = () => context.pages().filter((page) => page.url().startsWith(extensionUrl('options.html')));

/** The stored settings, keys included, as the service worker reads them. */
const storedSettings = () => serviceWorker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);

/**
 * Opens the settings page at a route and waits until it has loaded the stored settings: the
 * first render builds the mode rows, and a failed load shows the banner.
 * @param {string} route
 * @param {{ width: number, height: number }} [viewport] the window size, set before the page loads
 */
async function openSettingsPage(route, viewport) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
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
  await expect(settingsPage.locator('section[data-part="settings/provider"]')).toBeVisible();
  await expect.poll(settingsTabsActive).toEqual([true]);
});

test('a fresh install opens Welcome once', async () => {
  const fresh = await launchExtension({ keepWelcome: true });
  try {
    const url = `chrome-extension://${fresh.extensionId}/options.html#welcome`;
    const welcomePages = () => fresh.context.pages().filter((page) => page.url() === url);
    await expect.poll(() => welcomePages().length).toBe(1);
    const [page] = welcomePages();
    await expect(page.locator('section[data-route="welcome"]')).toBeVisible();
    await expect(page.locator('#welcome-key-state')).toHaveText(/key/);
    await expect(page.locator('#welcome-hotkey')).toHaveText('Ctrl+Shift+Space');

    // A worker that wakes again does not open a second one.
    const cdp = await fresh.context.newCDPSession(page);
    const statuses = [];
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => statuses.push(...versions.map((v) => v.runningStatus)));
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await expect.poll(() => statuses.at(-1)).toBe('stopped');
    await page.reload();
    await expect(page.locator('#welcome-hotkey')).toHaveText('Ctrl+Shift+Space');
    // One tab through a short window after the wake: a second one sends the poll to -1 until it times out.
    const woke = Date.now();
    await expect.poll(() => (welcomePages().length === 1 ? Date.now() - woke : -1), { timeout: 3000 }).toBeGreaterThanOrEqual(WAKE_WINDOW_MS);
  } finally {
    await fresh.close();
  }
});

test('Open settings reuses an open welcome tab', async () => {
  await seedSettings(serviceWorker, '');
  const welcome = await openSettingsPage('welcome');
  await welcome.evaluate(() => { window.__marker = 1; });

  const popup = await openPopup();
  // The new popup tab is in front, so the focus check below is not vacuous.
  await expect.poll(settingsTabsActive).toEqual([false]);
  await popup.getByRole('button', { name: 'Open settings' }).click();

  await expect.poll(settingsTabsActive).toEqual([true]);
  expect(settingsPages()).toEqual([welcome]);
  await expect(welcome).toHaveURL(extensionUrl('options.html#welcome'));
  await expect(welcome.locator('section[data-route="welcome"]')).toBeVisible();
  expect(await welcome.evaluate(() => window.__marker)).toBe(1);
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

test('a 3.1 record with dictation on the new edit chord says so on the Recording page, until the chord moves', async () => {
  const { editHotkey, ...record } = await storedSettings();
  record.hotkey = editHotkey;
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), record);

  const page = await openSettingsPage('settings/recording');
  const hint = page.locator('#edit-hotkey-hint');
  await expect(page.locator('#edit-hotkey')).toHaveText('Ctrl+Shift+E');
  await expect(hint).toHaveText('Same as the dictation hotkey, so this one does nothing. Click it and press another.');

  await page.locator('#edit-hotkey').click();
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('#edit-hotkey')).toHaveText('Ctrl+Shift+K');
  await expect(hint).not.toHaveAttribute('data-tone');
  await expect(hint).toContainText('Select text in a field');
  await expect.poll(async () => (await storedSettings()).editHotkey?.code).toBe('KeyK');

  await seedSettings(serviceWorker, DUMMY_KEY);
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

test('the Minimal size shows for Minimal only, and the size, colour and sound set stay after a reload', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'dot' });
  const appearance = await openSettingsPage('settings/appearance');
  await expect(appearance.locator('input[name="pill-style"][value="dot"]')).toBeChecked();
  await expect(appearance.locator('#mini-size-group')).toBeHidden();
  await choose(appearance, 'pill-style', 'minimal');
  await expect(appearance.locator('#mini-size-group')).toBeVisible();

  await choose(appearance, 'mini-size', 'xlarge');
  await choose(appearance, 'rec-color', 'obsidian');
  const sound = await openSettingsPage('settings/sound');
  await choose(sound, 'sound-set', 'warm');
  await expect.poll(async () => {
    const { pillStyle, miniSize, recColor, soundSet } = await storedSettings();
    return [pillStyle, miniSize, recColor, soundSet];
  }).toEqual(['minimal', 'xlarge', 'obsidian', 'warm']);

  await appearance.reload();
  await sound.reload();
  await expect(appearance.locator('#mini-size-group')).toBeVisible();
  await expect(appearance.locator('input[name="mini-size"][value="xlarge"]')).toBeChecked();
  await expect(appearance.locator('input[name="rec-color"][value="obsidian"]')).toBeChecked();
  await expect(sound.locator('input[name="sound-set"][value="warm"]')).toBeChecked();
});

test('Reset to defaults gives Medium, Classic red and Soft', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal', miniSize: 'xlarge', recColor: 'mocha', soundSet: 'tap' });
  const usage = await openSettingsPage('settings/usage');
  const reset = usage.locator('#reset');
  await reset.click();
  await expect(reset).toHaveAttribute('data-confirming', 'true');
  await usage.waitForTimeout(CONFIRM_GUARD_MS + 100);
  await reset.click();

  await expect.poll(async () => {
    const { miniSize, recColor, soundSet } = await storedSettings();
    return [miniSize, recColor, soundSet];
  }).toEqual(['medium', 'red', 'soft']);
  const appearance = await openSettingsPage('settings/appearance');
  await expect(appearance.locator('input[name="mini-size"][value="medium"]')).toBeChecked();
  await expect(appearance.locator('input[name="rec-color"][value="red"]')).toBeChecked();
  const sound = await openSettingsPage('settings/sound');
  await expect(sound.locator('input[name="sound-set"][value="soft"]')).toBeChecked();
});

test('a stored 3.2 record on Minimal reads as Medium, Classic red and Soft', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { pillStyle: 'minimal' });
  const { miniSize, recColor, soundSet, ...record } = await storedSettings();
  await serviceWorker.evaluate((s) => chrome.storage.local.set({ settings: s }), record);

  const appearance = await openSettingsPage('settings/appearance');
  await expect(appearance.locator('#mini-size-group')).toBeVisible();
  await expect(appearance.locator('input[name="mini-size"][value="medium"]')).toBeChecked();
  await expect(appearance.locator('input[name="rec-color"][value="red"]')).toBeChecked();
  const sound = await openSettingsPage('settings/sound');
  await expect(sound.locator('input[name="sound-set"][value="soft"]')).toBeChecked();
});

test('the Minimal preview sits where the Pill preview does, beside its field, 28 by 8', async () => {
  const page = await openSettingsPage('settings/appearance');
  const inCard = (value, selector) => page.locator('.style-card', { has: page.locator(`input[value="${value}"]`) }).locator(selector);
  const box = async (value, selector) => {
    const [mark, preview] = await Promise.all([inCard(value, selector).boundingBox(), inCard(value, '.style-preview').boundingBox()]);
    return { x: mark.x - preview.x, midY: mark.y + mark.height / 2 - preview.y, width: mark.width, height: mark.height };
  };
  const mini = await box('minimal', '.preview-mini');
  const bar = await box('pill', '.preview-bar');
  const field = await box('minimal', '.preview-field');

  expect([mini.width, mini.height]).toEqual([28, 8]);
  expect(mini.x).toBeCloseTo(bar.x, 0);
  expect(mini.x).toBeGreaterThan(field.x + field.width);
  expect(mini.midY).toBeCloseTo(bar.midY, 0);
  expect(mini.midY).toBeCloseTo(field.midY, 0);
});

test('Play runs the four tones of a set on the page, once, with sounds off', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { sounds: false, soundSet: 'soft' });
  const page = await openSettingsPage('settings/sound');
  // Records what the page asks its audio contexts to play, in order.
  await page.evaluate(() => {
    const log = { contexts: 0, notes: [], waves: [], filters: 0 };
    window.__cues = log;
    const Real = window.AudioContext;
    window.AudioContext = class extends Real {
      constructor() {
        super();
        log.contexts += 1;
      }

      createOscillator() {
        const oscillator = super.createOscillator();
        const start = oscillator.start.bind(oscillator);
        oscillator.start = (when) => {
          log.notes.push(oscillator.frequency.value);
          log.waves.push(oscillator.type);
          start(when);
        };
        return oscillator;
      }

      createBiquadFilter() {
        log.filters += 1;
        return super.createBiquadFilter();
      }
    };
  });
  const warm = page.locator('[data-play="warm"]');
  await expect(warm).toHaveAccessibleName('Play Warm');

  await warm.click();
  await expect(warm).toHaveAttribute('aria-disabled', 'true');
  // Playwright waits for an enabled button, which is the thing under test: dispatch the press.
  await page.locator('[data-play="soft"]').dispatchEvent('click');
  await expect(warm).not.toHaveAttribute('aria-disabled', 'true', { timeout: 8000 });

  const log = await page.evaluate(() => window.__cues);
  const notes = CUE_NAMES.flatMap((name) => CUE_SETS.warm.notes[name].map(({ freq }) => freq));
  expect(log.notes).toEqual(notes);
  expect(log.contexts).toBe(CUE_NAMES.length);
  expect(new Set(log.waves)).toEqual(new Set(['triangle']));
  expect(log.filters).toBe(notes.length);
  // Pressing Play does not choose the set.
  await expect(page.locator('input[name="sound-set"][value="soft"]')).toBeChecked();
  expect((await storedSettings()).soundSet).toBe('soft');
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

test('the popup shows no dictated text until the arrow, and a row press puts that text on the clipboard', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const texts = ['alpha entry', 'bravo entry\nwith a second line', 'charlie entry'];
  await serviceWorker.evaluate(
    (list) => chrome.storage.session.set({ history: list.map((text, i) => ({ id: `e${i}`, raw: text, text, mode: 'default', host: null, ts: Date.now() - i })) }),
    texts,
  );
  const fields = await openFields(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
  const clipboard = async () => {
    await fields.bringToFront();
    return fields.evaluate(() => navigator.clipboard.readText());
  };

  const popup = await openPopup();
  const toggle = popup.getByRole('button', { name: 'Show recent dictations' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(popup.locator('#recent-list')).toBeHidden();
  const dictated = /alpha|bravo|charlie/;
  expect(await popup.content()).not.toMatch(dictated);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(popup.locator('#recent-list button')).toHaveText(['alpha entry', 'bravo entry', 'charlie entry']);
  expect(await popup.content()).not.toContain('second line');

  await fields.evaluate(() => navigator.clipboard.writeText('before the row'));
  await popup.bringToFront();
  await popup.getByRole('button', { name: 'bravo entry' }).click();
  await expect(popup.locator('#toast')).toHaveText('Copied to clipboard.');
  expect(await clipboard()).toBe(texts[1]);
  await popup.bringToFront();
  await expect(popup.locator('#recent-list')).toBeVisible();

  await toggle.click();
  await expect(popup.locator('#recent-list')).toBeHidden();
  expect(await popup.content()).not.toMatch(dictated);
  await serviceWorker.evaluate(() => chrome.storage.session.remove('history'));
});

test('Clear on the History page goes through the worker: the entries go, the store empties, the focus stays on the page', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  await serviceWorker.evaluate(() => chrome.storage.session.remove('history'));
  const fields = await openFields(context);
  const textarea = fields.locator('#ta');
  await focusField(fields, textarea);
  await dictate(fields);
  await expect(textarea).toHaveValue(TRANSCRIPT);

  const page = await openSettingsPage('history');
  const stored = () => serviceWorker.evaluate(async () => (await chrome.storage.session.get('history')).history ?? []);
  const clear = page.locator('#clear-history');
  await expect(page.locator('#history-list .history-entry')).toHaveCount(1);
  expect(await stored()).toHaveLength(1);

  await clear.click();
  await expect(clear).toHaveText('Click again to clear history');
  await page.waitForTimeout(CONFIRM_GUARD_MS);
  await clear.click();

  await expect(page.locator('#toast')).toHaveText('History cleared');
  await expect(page.locator('#history-list .history-entry')).toHaveCount(0);
  await expect(page.locator('#history-empty')).toHaveText('No dictations yet.');
  await expect(clear).toBeDisabled();
  await expect(page.locator('#h-history')).toBeFocused();
  expect(await stored()).toEqual([]);
});

// One Settings page: seven parts under one h1, each reached by its old hash.

/** The seven settings hashes with the id of the heading each lands on, in page order. */
const SETTINGS_PARTS = [
  ['settings/provider', 'h-provider'],
  ['settings/recording', 'h-settings-recording'],
  ['settings/speech', 'h-settings-speech'],
  ['settings/sites', 'h-settings-sites'],
  ['settings/appearance', 'h-settings-appearance'],
  ['settings/sound', 'h-settings-sound'],
  ['settings/usage', 'h-settings-usage'],
];
/** Window width and height, the columns of the Settings page and where its cards may end. */
const LAYOUTS = [[1000, 640, 1, 2100], [1440, 900, 2, 1340], [1920, 1080, 3, 900], [2560, 1440, 3, 850]];
/** Changes the hash in the open page, as a link from Welcome or the popup does. */
const goToHash = (page, route) => page.evaluate((hash) => { window.location.hash = hash; }, route);
/** Shorter than the page, so a part further down needs a scroll to show. */
const SHORT_WINDOW = { width: 1000, height: 500 };
/** A heading scrolled to the start of the window sits this close to its top edge (28 px of margin). */
const NEAR_TOP_PX = 60;

test('each settings hash lands with its heading in view, and moves no focus', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  for (const [route, headingId] of SETTINGS_PARTS) {
    const page = await openSettingsPage(route, SHORT_WINDOW);
    const heading = page.locator(`#${headingId}`);
    await expect(heading).toBeInViewport({ ratio: 1 });
    await expect(page.locator('section[data-route="settings"]')).toBeVisible();
    await expect(page.locator('section[data-route]:not([hidden])')).toHaveCount(1);
    await expect(page.locator('nav a[href="#settings"]')).toHaveAttribute('aria-current', 'page');
    // The last part ends the page, so it cannot reach the top; every other one is scrolled to it.
    if (route !== 'settings/usage') await expect.poll(async () => (await heading.boundingBox()).y).toBeLessThan(NEAR_TOP_PX);
    // A load moves no focus.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY');
    await page.close();
  }
});

test('a failed load on a deep hash leaves the banner in view, and the page at its top', async () => {
  const page = await context.newPage();
  await page.setViewportSize(SHORT_WINDOW);
  // Every message but the settings read goes through; that one fails as it does with the worker out of reach.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...rest) => (
      message?.action === 'getSettings' ? Promise.reject(new Error('e2e: no worker')) : send(message, ...rest)
    );
  });
  await page.goto(extensionUrl('options.html#settings/provider'));

  const banner = page.locator('#banner');
  await expect(banner).toBeVisible();
  await expect(page.locator('#banner-text')).toHaveText('Could not load settings. Reload this page.');
  await expect(page.locator('section[data-route]:not([hidden])')).toHaveAttribute('data-route', 'settings');
  // Past the load's first render, where the scroll to the hash used to run.
  await expect(page.locator('#mode-list .mode-select').first()).toBeAttached();
  await expect(banner).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test('the sidebar has one Settings entry, and it opens the page at its top', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('home', SHORT_WINDOW);
  await expect(page.locator('nav .nav-list a')).toHaveText(['Home', 'Modes', 'Dictionary', 'History', 'Settings']);

  await page.locator('nav a[href="#settings"]').click();
  await expect(page).toHaveURL(extensionUrl('options.html#settings'));
  await expect(page.locator('#h-settings')).toBeFocused();
  await expect(page.locator('nav a[href="#settings"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('nav [aria-current]')).toHaveCount(1);

  // A press while already there, scrolled down, comes back up.
  await page.mouse.move(600, 300);
  await page.mouse.wheel(0, 5000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.locator('nav a[href="#settings"]').click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('an old hash jumps to its part: heading focused, the Settings entry marked, nothing reloaded', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('settings/provider', SHORT_WINDOW);
  await page.evaluate(() => { window.__marker = 1; });

  for (const [route, headingId] of SETTINGS_PARTS.slice(1)) {
    await goToHash(page, route);
    await expect(page.locator(`#${headingId}`)).toBeFocused();
    await expect(page.locator(`#${headingId}`)).toBeInViewport({ ratio: 1 });
    if (route !== 'settings/usage') await expect.poll(async () => (await page.locator(`#${headingId}`).boundingBox()).y).toBeLessThan(NEAR_TOP_PX);
    await expect(page.locator('nav [aria-current]')).toHaveCount(1);
    await expect(page.locator('nav a[href="#settings"]')).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(extensionUrl(`options.html#${route}`));
  }
  expect(await page.evaluate(() => window.__marker)).toBe(1);

  // Scrolling by hand moves neither the hash nor the mark.
  await page.mouse.wheel(0, -5000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page).toHaveURL(extensionUrl('options.html#settings/usage'));
});

test('Add API key in the popup lands on Provider with its heading focused and in view', async () => {
  await seedSettings(serviceWorker, '');
  const page = await openSettingsPage('settings/usage', SHORT_WINDOW);
  await expect(page.locator('#h-settings-usage')).toBeInViewport({ ratio: 1 });

  const popup = await openPopup();
  await expect.poll(settingsTabsActive).toEqual([false]);
  await popup.getByRole('button', { name: 'Add API key' }).click();

  await expect(page).toHaveURL(extensionUrl('options.html#settings/provider'));
  await expect(page.locator('#h-provider')).toBeFocused();
  await expect(page.locator('#h-provider')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#key-openai')).toBeInViewport();
  expect(settingsPages()).toEqual([page]);
});

test('a key typed, then a press on another page, is saved, and Provider shows it masked on the way back', async () => {
  await seedSettings(serviceWorker, '');
  const page = await openSettingsPage('settings/provider', SHORT_WINDOW);
  const key = page.locator('#key-openai');
  await key.fill(PASTED_KEY);
  await expect(key).toHaveValue(PASTED_KEY);

  // The press moves focus off the field before the typing pause ends, and the hash change follows.
  await page.locator('nav a[href="#home"]').click();
  await expect(page.locator('#h-home')).toBeFocused();
  await expect.poll(async () => (await storedSettings()).keys.openai).toBe(PASTED_KEY);

  await page.locator('nav a[href="#settings"]').click();
  await expect(page.locator('#h-settings')).toBeFocused();
  await expect(key).toHaveAttribute('placeholder', 'sk-e…-key (saved)');
  await expect(key).toHaveValue('');
  await expect(page.locator('#banner')).toBeHidden();
});

test('a window 400 px high on Usage and data focuses the heading of the last part', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('settings/usage', { width: 1000, height: 400 });
  const heading = page.locator('#h-settings-usage');
  await expect(heading).toBeInViewport({ ratio: 1 });

  await goToHash(page, 'settings/provider');
  await expect(page.locator('#h-provider')).toBeFocused();
  await goToHash(page, 'settings/usage');
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport({ ratio: 1 });
});

test('the Settings page fills the window: columns follow its width and the page stays short', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY, { siteRules: { 'mail.example.com': { hidePill: false, mode: 'email' } } });
  // Where the cards end, not the document's height, which a tall window sets. Limits from a measured
  // run; a single 760 px column ended about 2500 px down at every width.
  for (const [width, height, columns, tallest] of LAYOUTS) {
    const page = await openSettingsPage('settings', { width, height });
    await expect(page.locator('.settings-part').first()).toBeVisible();
    const { lefts, bottom, scrollWidth, clientWidth, overlaps } = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.settings-part')].map((part) => part.getBoundingClientRect());
      return {
        lefts: new Set(boxes.map((box) => Math.round(box.left))).size,
        bottom: Math.max(...boxes.map((box) => box.bottom)),
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        overlaps: boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)),
      };
    });
    expect(lefts, `${width} columns`).toBe(columns);
    expect(bottom, `${width} height`).toBeLessThanOrEqual(tallest);
    expect(scrollWidth, `${width} sideways`).toBeLessThanOrEqual(clientWidth);
    expect(overlaps, `${width} overlap`).toBe(false);
    await page.close();
  }
});

test('the other pages keep their reading width', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('settings', { width: 1920, height: 1080 });
  await page.locator('nav a[href="#modes"]').click();
  await expect(page.locator('#h-modes')).toBeFocused();
  expect((await page.locator('.content').boundingBox()).width).toBe(760);
});

test('the Settings page has no sideways scroll at 380 px', async () => {
  const host = 'a-very-long-subdomain.of-an-unusually-long-hostname-for-a-site-rule.example.com';
  await seedSettings(serviceWorker, DUMMY_KEY, { siteRules: { [host]: { hidePill: true, mode: 'email' } } });
  const page = await openSettingsPage('settings/sites', { width: 380, height: 800 });
  await expect(page.locator('#site-table tbody th')).toHaveText(host);

  for (const [route, headingId] of SETTINGS_PARTS) {
    await goToHash(page, route);
    await expect(page.locator(`#${headingId}`)).toBeFocused();
    const { scroll, client } = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(client, route).toBeLessThanOrEqual(380);
    expect(scroll, route).toBeLessThanOrEqual(client);
  }
});

test('forced colours keep the edge of a part\'s card', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openSettingsPage('settings/provider', SHORT_WINDOW);
  await page.emulateMedia({ forcedColors: 'active' });
  const second = page.locator('section[data-part="settings/recording"] .card');
  await second.scrollIntoViewIfNeeded();

  const { top, left, style, thickness, canvas } = await second.evaluate((part) => {
    const probe = document.body.appendChild(document.createElement('i'));
    probe.style.color = 'Canvas';
    const canvasColor = getComputedStyle(probe).color.match(/\d+/g).slice(0, 3).map(Number);
    probe.remove();
    const rect = part.getBoundingClientRect();
    const css = getComputedStyle(part);
    return { top: rect.top, left: rect.left, style: css.borderTopStyle, thickness: parseFloat(css.borderTopWidth), canvas: canvasColor };
  });
  expect(style).toBe('solid');
  expect(thickness).toBeGreaterThan(0);

  // A band through the edge: the padding below it and the gap above it are the canvas, so any
  // pixel that is not the canvas is the edge.
  const band = await page.screenshot({ clip: { x: left + 16, y: Math.floor(top) - 1, width: 32, height: 3 } });
  const { data, channels } = decodePng(band);
  let ruled = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] !== canvas[0] || data[i + 1] !== canvas[1] || data[i + 2] !== canvas[2]) ruled += 1;
  }
  expect(ruled).toBeGreaterThan(0);
});
