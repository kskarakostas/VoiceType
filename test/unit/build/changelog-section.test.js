import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { changelogSection } from '../../../scripts/changelog-section.mjs';

const script = fileURLToPath(new URL('../../../scripts/changelog-section.mjs', import.meta.url));
const realChangelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
const topVersion = realChangelog.match(/^## (\S+)/m)[1];

const SAMPLE = [
  '# Changelog',
  '',
  '## 13.1.0 (2027-01-01)',
  '',
  '- thirteen',
  '',
  '## 3.1.01 (2026-12-01)',
  '',
  '- padded',
  '',
  '## 3.1.0 (2026-11-05)',
  '',
  '### Added',
  '- History',
  '',
  '### Fixed',
  '- A bug',
  '',
  '## 3.0.0 (2026-11-04)',
  '',
  '- older',
  '',
].join('\n');

function cli(...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('changelogSection', () => {
  it('returns the body of the matching section', () => {
    expect(changelogSection(SAMPLE, '3.1.0')).toBe('### Added\n- History\n\n### Fixed\n- A bug');
  });

  it('runs to the end of the file for the last section', () => {
    expect(changelogSection(SAMPLE, '3.0.0')).toBe('- older');
  });

  it('is null for a version with no section', () => {
    expect(changelogSection(SAMPLE, '9.9.9')).toBeNull();
  });

  it('is null for a section with no body', () => {
    expect(changelogSection('## 3.1.0 (2026-11-05)\n\n## 3.0.0\n\n- older\n', '3.1.0')).toBeNull();
  });

  it('does not match 3.1.0 on 13.1.0 or 3.1.01', () => {
    expect(changelogSection('## 13.1.0 (2027-01-01)\n\n- thirteen\n', '3.1.0')).toBeNull();
    expect(changelogSection('## 3.1.01 (2026-12-01)\n\n- padded\n', '3.1.0')).toBeNull();
  });

  it('does not read the dots in a version as wildcards', () => {
    expect(changelogSection('## 3x1x0 (2026-11-05)\n\n- no\n', '3.1.0')).toBeNull();
  });

  it('the real CHANGELOG has a section for the top version', () => {
    expect(changelogSection(realChangelog, topVersion)).toEqual(expect.stringMatching(/\S/));
  });
});

describe('changelog-section CLI', () => {
  it('prints the section of the real CHANGELOG', () => {
    const result = cli(topVersion);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(changelogSection(realChangelog, topVersion));
  });

  it('exits 1 and prints nothing to stdout for an absent version', () => {
    const result = cli('0.0.0-absent');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/0\.0\.0-absent/);
  });

  it('exits 1 with no version', () => {
    expect(cli().status).toBe(1);
  });
});
