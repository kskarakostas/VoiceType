// esbuild build script. Bundles the entry points and copies static assets into dist/.
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync, watch as watchPath } from 'node:fs';
import { basename, dirname } from 'node:path';

// Every path below is relative to the repository root, wherever the script is run from.
// esbuild captured the old cwd when it was imported, so the options also pass absWorkingDir.
process.chdir(import.meta.dirname);

const watch = process.argv.includes('--watch');
const OUTDIR = 'dist';

/** Bundle name (dist/<name>.js) to source entry. */
const ENTRIES = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
  offscreen: 'src/offscreen/offscreen.js',
  permission: 'src/offscreen/permission.js',
};

/** Static files as [source, path under dist/] pairs. */
const STATICS = [
  ['manifest.json', 'manifest.json'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/popup.css', 'popup.css'],
  ['src/offscreen/offscreen.html', 'offscreen.html'],
  ['src/offscreen/permission.html', 'permission.html'],
  ['icons/icon16.png', 'icons/icon16.png'],
  ['icons/icon48.png', 'icons/icon48.png'],
  ['icons/icon128.png', 'icons/icon128.png'],
];

rmSync(OUTDIR, { recursive: true, force: true });
mkdirSync(OUTDIR, { recursive: true });

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: import.meta.dirname,
  entryPoints: ENTRIES,
  bundle: true,
  format: 'iife',
  target: 'chrome140',
  outdir: OUTDIR,
  // `import css from './x.css'` yields the file text (Shadow DOM styles); vitest.config.js mirrors this.
  loader: { '.css': 'text' },
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

function copyStatic() {
  for (const [from, to] of STATICS) cpSync(from, `${OUTDIR}/${to}`);
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  copyStatic();
  // esbuild only watches the JS graph; re-copy statics when any of them changes.
  // Watch parent directories, not files, so atomic-rename saves stay visible.
  const watched = new Map();
  for (const [from] of STATICS) {
    const dir = dirname(from);
    if (!watched.has(dir)) watched.set(dir, new Set());
    watched.get(dir).add(basename(from));
  }
  for (const [dir, names] of watched) {
    const watcher = watchPath(dir, (_event, filename) => {
      if (!filename || !names.has(filename)) return;
      console.log(`static changed: ${dir === '.' ? filename : `${dir}/${filename}`}`);
      try {
        copyStatic();
      } catch (err) {
        console.error(`static copy failed: ${err.message}`);
      }
    });
    watcher.on('error', (err) => console.error(`watch failed for ${dir}: ${err.message}`));
  }
  console.log('watching for changes');
} else {
  await build(options);
  copyStatic();
}
