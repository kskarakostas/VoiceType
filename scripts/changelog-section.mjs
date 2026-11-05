// Prints the CHANGELOG section of a version: the notes of its GitHub Release.
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The body of the `## <version>` section, up to the next `## ` heading.
 * @param {string} text the changelog
 * @param {string} version such as `3.1.0`
 * @returns {string|null} null when the section is absent or empty
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const heading = `## ${version}`;
  const start = lines.findIndex((line) => line === heading || line.startsWith(`${heading} `));
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim() || null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/changelog-section.mjs <version>');
    process.exit(1);
  }
  const section = changelogSection(readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8'), version);
  if (section === null) {
    console.error(`CHANGELOG.md has no section for ${version}`);
    process.exit(1);
  }
  console.log(section);
}
