import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import css from './fixture.css';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixtureText = readFileSync(new URL('./fixture.css', import.meta.url), 'utf8');

describe('CSS imported as text', () => {
  it('yields the file text under Vitest', () => {
    expect(typeof css).toBe('string');
    expect(css).toBe(fixtureText);
  });

  it('yields the same text through the esbuild text loader the bundle uses', async () => {
    const result = await build({
      stdin: { contents: "export { default } from './fixture.css';", resolveDir: here },
      bundle: true,
      write: false,
      format: 'iife',
      globalName: 'bundled',
      loader: { '.css': 'text' },
      logLevel: 'silent',
    });
    const bundled = new Function(`${result.outputFiles[0].text}\nreturn bundled;`)();
    expect(bundled.default).toBe(fixtureText);
  });
});
