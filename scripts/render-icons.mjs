// Renders the icon SVGs to the PNGs the repo commits. A dev tool, not part of the build:
// run `node scripts/render-icons.mjs` after editing icons/icon.svg or icons/icon16.svg.
// Chromium aborts inside some sandboxes; run it unsandboxed if the launch fails.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Each SVG source with the PNGs rendered from it, as [path from the repo root, size in px]. icon16.svg is the 16 px PNG's source only. */
const JOBS = [
  { svg: 'icons/icon16.svg', pngs: [['icons/icon16.png', 16]] },
  { svg: 'icons/icon.svg', pngs: [['icons/icon32.png', 32], ['icons/icon48.png', 48], ['icons/icon128.png', 128], ['logo.png', 360]] },
];

const browser = await chromium.launch({ channel: 'chromium' });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { svg, pngs } of JOBS) {
    const src = `data:image/svg+xml;base64,${readFileSync(join(ROOT, svg)).toString('base64')}`;
    for (const [out, size] of pngs) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img alt="" src="${src}">`,
      );
      await page.evaluate(() => document.querySelector('img').decode());
      // omitBackground keeps the corners of the rounded square transparent.
      writeFileSync(join(ROOT, out), await page.screenshot({ type: 'png', omitBackground: true }));
      console.log(`${svg} -> ${out} (${size} px)`);
    }
  }
} finally {
  await browser.close();
}
