import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('asks for exactly clipboardWrite, offscreen, scripting and storage', () => {
    expect([...manifest.permissions].sort()).toEqual(['clipboardWrite', 'offscreen', 'scripting', 'storage']);
  });

  it('holds the all-URLs host permission used to re-inject content scripts', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('requires Chrome 140 for storage access levels', () => {
    expect(manifest.minimum_chrome_version).toBe('140');
  });

  it('opens the settings page in a tab', () => {
    expect(manifest.options_ui).toEqual({ page: 'options.html', open_in_tab: true });
  });

  it('declares no commands; the hotkey lives in the content script', () => {
    expect(manifest).not.toHaveProperty('commands');
  });
});

describe('icons', () => {
  const SIZES = ['16', '32', '48', '128'];
  const PNG_SIGNATURE = '89504e470d0a1a0a';

  /** Width and height of a PNG, read from its IHDR chunk, or null when the file is not a PNG. */
  function pngSize(file) {
    const bytes = readFileSync(new URL(`../../${file}`, import.meta.url));
    if (bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
    if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  it.each([
    ['icons', () => manifest.icons],
    ['action.default_icon', () => manifest.action.default_icon],
  ])('%s lists 16, 32, 48 and 128', (_name, list) => {
    expect(Object.keys(list()).sort((a, b) => a - b)).toEqual(SIZES);
  });

  it.each(SIZES)('the %s px icon in both lists is one PNG of that size', (size) => {
    expect(manifest.action.default_icon[size]).toBe(manifest.icons[size]);
    expect(pngSize(manifest.icons[size])).toEqual({ width: Number(size), height: Number(size) });
  });

  it('logo.png is a PNG of 360 by 360', () => {
    expect(pngSize('logo.png')).toEqual({ width: 360, height: 360 });
  });

  it('build.mjs copies every icon the manifest names to the same path under dist', () => {
    // build.mjs bundles on import, so read its STATICS pairs as text.
    const statics = [...readFileSync(new URL('../../build.mjs', import.meta.url), 'utf8').matchAll(/\['([^']+)', '([^']+)'\]/g)];
    const copied = new Set(statics.filter(([, from, to]) => from === to).map(([, from]) => from));
    const named = new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]);
    expect(named.size).toBe(4);
    for (const path of named) expect(copied.has(path), `build.mjs does not list ${path}`).toBe(true);
  });
});

describe('content script', () => {
  it('runs content.js in every frame, about:blank frames included, with no stylesheet', () => {
    expect(manifest.content_scripts).toEqual([
      { matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle', all_frames: true, match_about_blank: true },
    ]);
  });

  it('exposes no web accessible resources to pages', () => {
    expect(manifest).not.toHaveProperty('web_accessible_resources');
  });
});

describe('release 3.4.0', () => {
  // Reads files itself so this block works whatever the imports at the top of the file are.
  async function readRoot(name) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(import.meta.dirname, '..', '..', name), 'utf8');
  }

  it('manifest and package versions are equal', async () => {
    const { version } = JSON.parse(await readRoot('manifest.json'));
    const pkg = JSON.parse(await readRoot('package.json'));
    const lock = JSON.parse(await readRoot('package-lock.json'));
    expect(version).toBe('3.4.0');
    expect(pkg.version).toBe(version);
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
  });

  it('the changelog and the README badge name the manifest version', async () => {
    const { version } = JSON.parse(await readRoot('manifest.json'));
    expect((await readRoot('CHANGELOG.md')).match(/^## (\S+)/m)[1]).toBe(version);
    expect(await readRoot('README.md')).toContain(`badge/version-${version}-`);
  });

  it('release docs carry no em or en dashes', async () => {
    const dashes = [0x2013, 0x2014].map((code) => String.fromCharCode(code));
    const docs = [
      'README.md', 'CHANGELOG.md', 'PRIVACY.md',
      'docs/superpowers/plans/2026-09-27-phase-1-smoke-checklist.md', 'docs/superpowers/plans/2026-09-27-fix-2-1-1-smoke.md',
    ];
    for (const name of docs) {
      const text = await readRoot(name);
      for (const dash of dashes) expect(text.includes(dash), `${name} contains U+${dash.charCodeAt(0).toString(16)}`).toBe(false);
    }
  });
});
