// README screenshots in light and dark: `npm run screenshots` rebuilds dist/ and rewrites
// screenshots/<scheme>/. Not part of test:e2e. The key is a dummy, the provider is stubbed and
// the usage history is generated sample data.
import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchExtension, seedSettings, focusField, clickPill, waitForPill, pillQuery, PORT, START, STOP } from '../e2e/helpers.js';
import { applyUsage, emptyLog } from '../../src/background/usage.js';
import { estimateSttCost } from '../../src/shared/pricing.js';
import { PROVIDERS } from '../../src/shared/models.js';

const OUT = fileURLToPath(new URL('../../screenshots', import.meta.url));
const DEMO_URL = `http://localhost:${PORT}/demo.html`;
/** Room kept around the pill so the whole level glow fits in the shot. */
const GLOW_ROOM = 48;
/** Less than the popup's gap between cards and the pill's gap to its field, so no neighbour shows. */
const EDGE_ROOM = 6;
/** Masked in the popup as "sk-p…7f3a (saved)". */
const SAMPLE_KEY = 'sk-proj-example-not-a-real-key-7f3a';

/** Sessions per day, newest first; repeats over 45 days. */
const SESSIONS = [6, 9, 4, 0, 7, 11, 5, 3, 8, 0, 6, 10];

/** A 45-day usage log built through applyUsage, so every bucket is shaped as the extension writes it. */
function sampleUsage(now = new Date()) {
  let log = emptyLog();
  for (let day = 44; day >= 0; day--) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, 12);
    for (let i = 0; i < SESSIONS[day % SESSIONS.length]; i++) {
      const provider = (day + i) % 3 === 0 ? 'gemini' : 'openai';
      const audioSeconds = 12 + ((day * 7 + i * 13) % 31);
      const mode = i % 4 === 3 ? 'email' : 'default';
      const cost = estimateSttCost(PROVIDERS[provider].stt, null, audioSeconds);
      log = applyUsage(log, { provider, audioSeconds, cost, mode }, date);
    }
  }
  return log;
}

/**
 * Screenshot the union of boxes plus `room` on every side.
 * @param {import('@playwright/test').Page} page
 * @param {{ x: number, y: number, width: number, height: number }[]} boxes top-left boxes
 * @param {number} room
 * @param {string} path
 */
async function shoot(page, boxes, room, path) {
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - room);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - room);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + room;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + room;
  await page.screenshot({ path, clip: { x: left, y: top, width: right - left, height: bottom - top }, fullPage: true });
}

/** pillQuery reports the centre; shoot wants the top-left corner. */
async function pillBox(page, selector) {
  const b = await pillQuery(page, selector);
  return { x: b.x - b.width / 2, y: b.y - b.height / 2, width: b.width, height: b.height };
}

for (const colorScheme of ['light', 'dark']) {
  test(`${colorScheme} README screenshots`, async () => {
    const dir = `${OUT}/${colorScheme}`;
    mkdirSync(dir, { recursive: true });
    const { context, serviceWorker, extensionId, close } = await launchExtension({
      contextOptions: { colorScheme, deviceScaleFactor: 2, viewport: { width: 900, height: 620 } },
    });
    try {
      await seedSettings(serviceWorker, SAMPLE_KEY);
      await serviceWorker.evaluate((usageLog) => chrome.storage.local.set({ usageLog }), sampleUsage());

      const page = await context.newPage();
      await page.goto(DEMO_URL);
      const field = page.locator('#body');
      await focusField(page, field);
      await field.press('ControlOrMeta+End');
      const card = await page.locator('.card').boundingBox();

      await clickPill(page, 'button.more');
      await waitForPill(page, '.menu .item');
      await page.waitForTimeout(300);
      await shoot(page, [await pillBox(page, '.body'), await pillBox(page, '.menu')], EDGE_ROOM, `${dir}/menu.png`);
      await page.keyboard.press('Escape');

      await clickPill(page, START);
      await waitForPill(page, STOP);
      // Off the pill, so REC shows its resting colour rather than its hover colour.
      await page.mouse.move(1, 1);
      await page.waitForTimeout(1200);
      await shoot(page, [card, await pillBox(page, '.body')], GLOW_ROOM, `${dir}/in-use.png`);

      const popup = await context.newPage();
      await popup.setViewportSize({ width: 320, height: 620 });
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.locator('#status[data-ready="true"]').waitFor();
      await popup.locator('#mode-list li').first().waitFor();
      await popup.waitForTimeout(300);
      const box = (selector) => popup.locator(selector).boundingBox();
      // Full popup width from the top bar down, with the Recording card's bottom edge kept.
      const recording = await box('.card:has(#h-recording)');
      await shoot(popup, [await box('.topbar'), { ...recording, height: recording.height + EDGE_ROOM }], 0, `${dir}/popup-settings.png`);
      await shoot(popup, [await box('.card:has(#h-modes)')], EDGE_ROOM, `${dir}/popup-modes.png`);
      await shoot(popup, [await box('.card:has(#h-usage)')], EDGE_ROOM, `${dir}/popup-usage.png`);
    } finally {
      await close();
    }
  });
}
