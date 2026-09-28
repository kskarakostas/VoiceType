import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

describe('manifest', () => {
  it('asks for exactly storage, scripting and offscreen', () => {
    expect([...manifest.permissions].sort()).toEqual(['offscreen', 'scripting', 'storage']);
  });

  it('holds the all-URLs host permission used to re-inject content scripts', () => {
    expect(manifest.host_permissions).toEqual(['<all_urls>']);
  });

  it('requires Chrome 140 for storage access levels', () => {
    expect(manifest.minimum_chrome_version).toBe('140');
  });

  it('declares no commands; the hotkey lives in the content script', () => {
    expect(manifest).not.toHaveProperty('commands');
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

describe('release 2.2.0', () => {
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
    expect(version).toBe('2.2.0');
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
