import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '../../../src');
const BASE_CSS = readFileSync(join(SRC, 'ui/base.css'), 'utf8');
const POPUP_CSS = readFileSync(join(SRC, 'popup/popup.css'), 'utf8');
const POPUP_HTML = readFileSync(join(SRC, 'popup/popup.html'), 'utf8');
const STYLESHEETS = { 'base.css': BASE_CSS, 'popup.css': POPUP_CSS };

describe('extension page stylesheets and markup', () => {
  function tokens(block) {
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]));
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }
  const PAIRS = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text', 'accent-soft'],
    ['text-2', 'surface'], ['text-2', 'surface-2'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-2'], ['muted', 'accent-soft'],
    ['accent', 'surface'], ['accent', 'accent-soft'], ['on-accent', 'accent'], ['on-accent', 'accent-hover'],
    ['danger', 'surface'], ['danger', 'danger-soft'], ['on-accent', 'danger'],
    ['success', 'surface'], ['on-accent', 'success'], ['warning', 'surface'], ['surface', 'text'],
  ];

  it('contrast tokens meet 4.5:1 in light and dark', () => {
    const CSS = BASE_CSS;
    const light = tokens(CSS.slice(CSS.indexOf(':root {'), CSS.indexOf('}', CSS.indexOf(':root {'))));
    const darkStart = CSS.indexOf('@media (prefers-color-scheme: dark)');
    const dark = { ...light, ...tokens(CSS.slice(darkStart, CSS.indexOf('}', darkStart))) };
    expect(darkStart).toBeGreaterThan(0);
    for (const [scheme, t] of [['light', light], ['dark', dark]]) {
      for (const [fg, bg] of PAIRS) {
        expect(t[fg], `${scheme} --${fg}`).toBeDefined();
        expect(t[bg], `${scheme} --${bg}`).toBeDefined();
        expect(contrast(t[fg], t[bg]), `${scheme} --${fg} on --${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('uses no font size under 12 px', () => {
    for (const [name, CSS] of Object.entries(STYLESHEETS)) {
      const sizes = [...CSS.matchAll(/font(?:-size)?:\s*([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/([\d.]+)px/g)].map((n) => Number(n[1])));
      expect(sizes.length, name).toBeGreaterThan(0);
      for (const size of sizes) expect(size, name).toBeGreaterThanOrEqual(12);
      expect(CSS, name).not.toMatch(/font(?:-size)?:[^;]*\d(?:em|rem|pt)\b/);
    }
  });

  it('draws visible focus rings and follows the dark scheme', () => {
    expect(BASE_CSS).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--focus\)/);
    expect(BASE_CSS).toContain('@media (prefers-color-scheme: dark)');
  });

  it('popup.html links base.css before popup.css', () => {
    const base = POPUP_HTML.indexOf('<link rel="stylesheet" href="base.css">');
    expect(base).toBeGreaterThan(0);
    expect(POPUP_HTML.indexOf('<link rel="stylesheet" href="popup.css">')).toBeGreaterThan(base);
  });

  it('popup.html carries no emoji and no inline handlers', () => {
    expect(POPUP_HTML).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(POPUP_HTML).not.toMatch(/\son[a-z]+=/i);
  });
});
