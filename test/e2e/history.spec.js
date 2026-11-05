// End-to-end Last dictation in the pill menu: a refined dictation, Undo AI edit and its Ctrl+Z,
// Insert under D12, and a page of another site. Run with `npm run test:e2e`, which builds dist/ first.
import { test, expect } from '@playwright/test';
import { freshSettings } from '../../src/shared/defaults.js';
import {
  launchExtension, seedSettings, openFields, pillQuery, pillCall, pillStatus, waitForPill, clickPill, focusField, dictate,
  TRANSCRIPT, DUMMY_KEY, PORT,
} from './helpers.js';

test.describe.configure({ mode: 'serial' });

const REFINED = 'refined transcript';
const MENU = '.more';
const INSERT = '[data-history="insert"]';
const COPY = '[data-history="copy"]';
const UNDO = '[data-history="undo"]';

/** @type {import('@playwright/test').BrowserContext} */
let context;
/** @type {import('@playwright/test').Worker} */
let serviceWorker;
/** @type {() => Promise<void>} */
let close;

test.beforeAll(async () => {
  ({ context, serviceWorker, close } = await launchExtension({ refineText: REFINED }));
  // The page reads the clipboard, and seeds it so that a copy is visible.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
});

test.afterAll(async () => {
  await close?.();
});

test.beforeEach(async () => {
  await serviceWorker.evaluate(() => chrome.storage.session.remove('history'));
  const { modes } = freshSettings();
  const mode = Object.keys(modes).find((key) => modes[key].prompt);
  await seedSettings(serviceWorker, DUMMY_KEY, { activeMode: mode });
});

test.afterEach(async () => {
  for (const page of context.pages()) {
    if (page.url().startsWith('http')) await page.close();
  }
});

/** The menu opened with the mouse, so the focus stays in the field, and its entry loaded. */
async function openMenu(page, action = INSERT) {
  await clickPill(page, MENU);
  await waitForPill(page, action);
}

/** A click on a menu action, moved through the open menu as a person would. */
async function clickAction(page, action) {
  const box = await waitForPill(page, action);
  await page.mouse.click(box.x, box.y);
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
const seedClipboard = (page) => page.evaluate(() => navigator.clipboard.writeText('before the copy'));

test('Undo AI edit gives the raw text in place, and Ctrl+Z gives the refined text back', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await openMenu(page, UNDO);
  await clickAction(page, UNDO);

  await expect(textarea).toHaveValue(TRANSCRIPT);
  await expect.poll(() => pillStatus(page)).toBe('Original text restored.');
  expect(await pillQuery(page, UNDO).then((box) => box?.width ?? 0)).toBe(0);

  await page.keyboard.press('Control+z');
  await expect(textarea).toHaveValue(REFINED);
});

test('text typed before it moves the offsets: Undo leaves the field and copies the raw text', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await page.keyboard.press('Control+Home');
  await page.keyboard.type('xy ');
  const typed = `xy ${REFINED}`;
  await expect(textarea).toHaveValue(typed);

  await seedClipboard(page);
  await openMenu(page, UNDO);
  await clickAction(page, UNDO);

  await expect.poll(() => pillStatus(page)).toBe('Original text copied.');
  await expect(textarea).toHaveValue(typed);
  expect(await clipboard(page)).toBe(TRANSCRIPT);
});

test('Undo with another field focused copies the raw text and touches neither field', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  const other = page.locator('#text');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await focusField(page, other);
  await seedClipboard(page);
  await openMenu(page, UNDO);
  await clickAction(page, UNDO);

  await expect.poll(() => pillStatus(page)).toBe('Original text copied.');
  await expect(textarea).toHaveValue(REFINED);
  await expect(other).toHaveValue('');
  expect(await clipboard(page)).toBe(TRANSCRIPT);
});

test('after a reload Undo copies the raw text', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await page.reload();
  await page.locator('#ta').fill(REFINED);
  await focusField(page, textarea);
  await seedClipboard(page);
  await openMenu(page, UNDO);
  await clickAction(page, UNDO);

  await expect.poll(() => pillStatus(page)).toBe('Original text copied.');
  await expect(textarea).toHaveValue(REFINED);
  expect(await clipboard(page)).toBe(TRANSCRIPT);
});

test('Insert goes to the field focused at the click and reads "Inserted."', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  const other = page.locator('#text');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await focusField(page, other);
  await openMenu(page);
  await clickAction(page, INSERT);

  await expect(other).toHaveValue(REFINED);
  await expect(textarea).toHaveValue(REFINED);
  await expect.poll(() => pillStatus(page)).toBe('Inserted.');
});

test('Insert with a password field focused types nothing there and copies', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  const password = page.locator('#password');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await seedClipboard(page);
  await openMenu(page);
  // A mouse click on the field would close the menu, so the page moves the focus under it. The
  // pill hides FOCUS_OUT_MS later, which a click through the protocol does not have to race.
  await password.evaluate((el) => el.focus());
  await pillCall(page, INSERT, 'function () { this.click(); }');

  await expect.poll(() => clipboard(page)).toBe(REFINED);
  await expect(password).toHaveValue('');
  await expect(password).toBeFocused();
  await expect(textarea).toHaveValue(REFINED);
});

test('Copy puts the last dictation on the clipboard', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);

  await seedClipboard(page);
  await openMenu(page);
  await clickAction(page, COPY);

  await expect.poll(() => pillStatus(page)).toBe('Copied to clipboard.');
  await expect(textarea).toHaveValue(REFINED);
  expect(await clipboard(page)).toBe(REFINED);
});

test('a dictation the mode left alone offers no Undo', async () => {
  await seedSettings(serviceWorker, DUMMY_KEY);
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(TRANSCRIPT);

  await openMenu(page);

  await waitForPill(page, COPY);
  expect(await pillQuery(page, UNDO)).toBeNull();
});

test('a Clear since the last open: reopening the menu shows no section', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);
  await openMenu(page);
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await pillQuery(page, INSERT))?.width ?? 0).toBe(0);

  await serviceWorker.evaluate(() => chrome.storage.session.remove('history'));
  // The usage line comes in the same reply as the entry, and an open keeps the old line until then,
  // so a new total marks the reply, and with it the section's final state.
  await serviceWorker.evaluate(async () => {
    const { usageLog } = await chrome.storage.local.get('usageLog');
    await chrome.storage.local.set({ usageLog: { ...usageLog, total: { ...usageLog.total, estimatedCost: 5 } } });
  });
  await clickPill(page, MENU);
  await expect.poll(async () => (await pillQuery(page, '.usage'))?.text).toContain('all time $5');

  expect(await pillQuery(page, INSERT)).toBeNull();
  expect(await pillQuery(page, COPY)).toBeNull();
});

test('a page of another site shows no section', async () => {
  const page = await openFields(context);
  const textarea = page.locator('#ta');
  await focusField(page, textarea);
  await dictate(page);
  await expect(textarea).toHaveValue(REFINED);
  await openMenu(page);

  const other = await context.newPage();
  await other.goto(`http://127.0.0.1:${PORT}/fields.html`);
  await focusField(other, other.locator('#ta'));
  await clickPill(other, MENU);
  await waitForPill(other, '.menu');
  // The usage line arrives with the entry, so the menu's reads are in.
  await waitForPill(other, '.usage');

  expect(await pillQuery(other, INSERT)).toBeNull();
  expect(await pillQuery(other, COPY)).toBeNull();
});
