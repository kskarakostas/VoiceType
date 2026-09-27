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
