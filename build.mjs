// esbuild build script. Bundles three entry points and copies static assets into dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: 'src/background/index.js',
    content: 'src/content/index.js',
    popup: 'src/popup/popup.js',
  },
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  outdir,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

function copyStatic() {
  cpSync('manifest.json', `${outdir}/manifest.json`);
  cpSync('src/popup/popup.html', `${outdir}/popup.html`);
  cpSync('src/popup/popup.css', `${outdir}/popup.css`);
  cpSync('src/content/content.css', `${outdir}/content.css`);
  cpSync('icons', `${outdir}/icons`, { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  console.log('watching for changes');
} else {
  await build(options);
  copyStatic();
}
