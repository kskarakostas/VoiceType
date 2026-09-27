import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Date tests need a zone with daylight saving time; Athens is also ahead of UTC.
process.env.TZ = 'Europe/Athens';

// Virtual module id for a CSS file imported as text. The `.css` extension is dropped
// from the id because Vitest empties any module whose id ends in `.css`.
const CSS_TEXT_PREFIX = '\0css-text:';

/** Mirror esbuild's `loader: { '.css': 'text' }`: `import css from './x.css'` yields the file text. */
function cssText() {
  return {
    name: 'css-text',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!source.endsWith('.css')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved || !resolved.id.endsWith('.css')) return null;
      return CSS_TEXT_PREFIX + resolved.id.slice(0, -'.css'.length);
    },
    load(id) {
      if (!id.startsWith(CSS_TEXT_PREFIX)) return null;
      const file = `${id.slice(CSS_TEXT_PREFIX.length)}.css`;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    },
  };
}

export default defineConfig({
  plugins: [cssText()],
  test: {
    include: ['test/unit/**/*.test.js'],
  },
});
