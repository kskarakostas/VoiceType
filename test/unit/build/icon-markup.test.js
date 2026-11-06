import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

/** The shapes between the root element's tags, with whitespace runs collapsed and none left between tags. */
const normalise = (markup) => markup.replace(/\s+/g, ' ').replace(/> </g, '><').trim();

const COPIES = {
  'icons/icon.svg': () => read('icons/icon.svg').match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/),
  'src/popup/popup.html': () => read('src/popup/popup.html').match(/<span class="brand-mark"[^>]*>\s*<svg\b([^>]*)>([\s\S]*?)<\/svg>/),
  'src/options/options.html': () => read('src/options/options.html').match(/<span class="brand-mark"[^>]*>\s*<svg\b([^>]*)>([\s\S]*?)<\/svg>/),
};

/** [root attributes, normalised shapes] of one copy of the mark. */
function copy(name) {
  const found = COPIES[name]();
  expect(found, `${name} holds the mark`).not.toBeNull();
  return { root: found[1], shapes: normalise(found[2]) };
}

describe('the icon mark', () => {
  const SOURCE = 'icons/icon.svg';

  it.each(Object.keys(COPIES))('%s draws the square and three white shapes in a 64 by 64 box', (name) => {
    const { root, shapes } = copy(name);
    expect(root).toMatch(/viewBox="0 0 64 64"/);
    expect(shapes.match(/<(rect|path)\b/g)).toHaveLength(4);
  });

  it.each(['src/popup/popup.html', 'src/options/options.html'])('%s holds the same shapes as icons/icon.svg', (name) => {
    expect(copy(name).shapes).toBe(copy(SOURCE).shapes);
  });
});
