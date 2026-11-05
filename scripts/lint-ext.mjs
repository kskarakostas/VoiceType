// Lints dist/ with web-ext. It lints for Firefox, so the two errors that a Chrome-only
// manifest always raises are exempt by code (V33); any other error fails the run.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

const EXEMPT = new Set(['BACKGROUND_SERVICE_WORKER_NOFALLBACK', 'ADDON_ID_REQUIRED']);

/**
 * Judges the stdout of `web-ext lint --output json`. A report that cannot be read fails,
 * so a broken lint never reads as clean; its summary must agree with its lists.
 * @param {string} output
 * @returns {{ ok: boolean, lines: string[] }} `lines` are the other errors, then every warning
 */
export function lintVerdict(output) {
  let report = null;
  try {
    report = JSON.parse(output);
  } catch {
    // Not JSON: left null, and refused below.
  }
  const { errors, warnings, summary } = report ?? {};
  const readable =
    Array.isArray(errors) &&
    Array.isArray(warnings) &&
    summary?.errors === errors.length &&
    summary?.warnings === warnings.length;
  if (!readable) return { ok: false, lines: ['web-ext lint gave no readable report'] };

  const blocking = errors.filter((entry) => !EXEMPT.has(entry?.code));
  return {
    ok: blocking.length === 0,
    lines: [
      ...blocking.map((entry) => `error ${entry?.code}: ${entry?.message}`),
      ...warnings.map((entry) => `warning ${entry?.code}: ${entry?.message}`),
    ],
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  const root = join(import.meta.dirname, '..');
  const lint = spawnSync(
    join(root, 'node_modules', '.bin', 'web-ext'),
    ['lint', '--source-dir', 'dist', '--output', 'json'],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const { ok, lines } = lintVerdict(lint.stdout ?? '');
  for (const line of lines) console.log(line);
  process.exit(ok ? 0 : 1);
}
