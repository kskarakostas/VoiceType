import { describe, it, expect, vi } from 'vitest';
import { lintExitCode, lintVerdict } from '../../../scripts/lint-ext.mjs';

const entry = (code) => ({ code, message: `${code} message`, file: 'manifest.json' });
const report = (errors = [], warnings = []) =>
  JSON.stringify({
    count: errors.length + warnings.length,
    summary: { errors: errors.length, notices: 0, warnings: warnings.length },
    metadata: {},
    errors,
    notices: [],
    warnings,
  });

const exempt = [entry('BACKGROUND_SERVICE_WORKER_NOFALLBACK'), entry('ADDON_ID_REQUIRED')];

describe('lintVerdict', () => {
  it('passes the two exempt codes and prints neither', () => {
    expect(lintVerdict(report(exempt))).toEqual({ ok: true, lines: [] });
  });

  it('passes a clean report', () => {
    expect(lintVerdict(report())).toEqual({ ok: true, lines: [] });
  });

  it('fails on another error and prints it', () => {
    const { ok, lines } = lintVerdict(report([entry('JSON_INVALID')]));
    expect(ok).toBe(false);
    expect(lines).toEqual(['error JSON_INVALID: JSON_INVALID message']);
  });

  it('fails when another error sits beside the exempt ones, and prints only that one', () => {
    const { ok, lines } = lintVerdict(report([...exempt, entry('MANIFEST_FIELD_INVALID')]));
    expect(ok).toBe(false);
    expect(lines).toEqual(['error MANIFEST_FIELD_INVALID: MANIFEST_FIELD_INVALID message']);
  });

  it('passes a warning and prints it', () => {
    const { ok, lines } = lintVerdict(report(exempt, [entry('MANIFEST_PERMISSIONS')]));
    expect(ok).toBe(true);
    expect(lines).toEqual(['warning MANIFEST_PERMISSIONS: MANIFEST_PERMISSIONS message']);
  });

  it('prints every warning even when it fails', () => {
    const { ok, lines } = lintVerdict(report([entry('JSON_INVALID')], [entry('W_ONE'), entry('W_TWO')]));
    expect(ok).toBe(false);
    expect(lines).toEqual([
      'error JSON_INVALID: JSON_INVALID message',
      'warning W_ONE: W_ONE message',
      'warning W_TWO: W_TWO message',
    ]);
  });

  it('does not exempt an error with no code', () => {
    expect(lintVerdict(report([{ message: 'no code' }])).ok).toBe(false);
    expect(lintVerdict(report([null])).ok).toBe(false);
  });

  it.each([
    ['nothing', ''],
    ['text', 'Validation Summary:'],
    ['cut-off JSON', report(exempt).slice(0, 40)],
    ['null', 'null'],
    ['an array', '[]'],
    ['an empty object', '{}'],
    ['no summary', '{"errors":[],"warnings":[]}'],
    ['no warnings list', '{"summary":{"errors":0,"warnings":0},"errors":[]}'],
    ['no errors list', '{"summary":{"errors":0,"warnings":0},"warnings":[]}'],
    ['a summary that disagrees on errors', '{"summary":{"errors":2,"warnings":0},"errors":[],"warnings":[]}'],
    ['a summary that disagrees on warnings', '{"summary":{"errors":0,"warnings":1},"errors":[],"warnings":[]}'],
  ])('fails on a report that is %s, so a broken lint cannot read as clean', (_name, output) => {
    const { ok, lines } = lintVerdict(output);
    expect(ok).toBe(false);
    expect(lines).toEqual(['web-ext lint gave no readable report']);
  });
});

describe('lintExitCode', () => {
  const run = (result) => {
    const print = vi.fn();
    return { code: lintExitCode(result, print), printed: print.mock.calls.map(([line]) => line) };
  };

  it('is 0 for a clean report, whatever the status of web-ext', () => {
    expect(run({ status: 1, stdout: report(exempt) })).toEqual({ code: 0, printed: [] });
  });

  it('is 0 with warnings, and prints them', () => {
    expect(run({ status: 0, stdout: report([], [entry('W_ONE')]) })).toEqual({ code: 0, printed: ['warning W_ONE: W_ONE message'] });
  });

  it('is 1 for another error, and prints it', () => {
    expect(run({ status: 1, stdout: report([entry('JSON_INVALID')]) })).toEqual({ code: 1, printed: ['error JSON_INVALID: JSON_INVALID message'] });
  });

  it('is 1 when web-ext could not run, and prints why', () => {
    expect(run({ error: new Error('spawn web-ext ENOENT'), status: null, stdout: null })).toEqual({
      code: 1,
      printed: ['spawn web-ext ENOENT', 'web-ext lint gave no readable report'],
    });
  });

  it('is 1 when the run failed, even with a clean report in hand', () => {
    expect(run({ error: new Error('spawnSync ETIMEDOUT'), status: null, stdout: report() })).toEqual({ code: 1, printed: ['spawnSync ETIMEDOUT'] });
  });

  it('prints to the console unless told otherwise', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(lintExitCode({ stdout: '' })).toBe(1);
    expect(log).toHaveBeenCalledWith('web-ext lint gave no readable report');
    log.mockRestore();
  });
});
