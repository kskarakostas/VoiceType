import { describe, it, expect } from 'vitest';
import { localDateKey, emptyLog, normalizeLog, applyUsage, summarize, RETENTION_DAYS } from '../../../src/background/usage.js';

const entry = (provider, audioSeconds, cost, mode = 'default') => ({ provider, audioSeconds, cost, mode });

describe('localDateKey', () => {
  it('uses local calendar date, not UTC', () => {
    const lateLocal = {
      getFullYear: () => 2026, getMonth: () => 8, getDate: () => 26,
      getUTCFullYear: () => 2026, getUTCMonth: () => 8, getUTCDate: () => 27,
      toISOString: () => '2026-09-27T02:00:00.000Z',
    };
    expect(localDateKey(lateLocal)).toBe('2026-09-26');
    expect(localDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('normalizeLog', () => {
  it('turns anything that is not a v2 log into an empty log', () => {
    for (const value of [undefined, null, 'x', 42, [], { daily: {}, total: { sessions: 9 } }, { version: 1, daily: {}, total: {} }]) {
      expect(normalizeLog(value), JSON.stringify(value)).toEqual(emptyLog());
    }
  });

  it('defaults every missing or non-finite bucket field to 0', () => {
    const log = normalizeLog({
      version: 2,
      daily: { '2026-09-26': { sessions: 2, audioSeconds: 'x', modes: { email: 2, bad: 'y' } }, '2026-09-25': 'junk' },
      total: { sessions: 2, estimatedCost: NaN, byProvider: { openai: { sessions: 2 }, gemini: null } },
    });
    expect(log.daily['2026-09-26']).toEqual({
      sessions: 2, audioSeconds: 0, estimatedCost: 0,
      byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
      modes: { email: 2 },
    });
    expect(log.daily['2026-09-25']).toBeUndefined();
    expect(log.total.estimatedCost).toBe(0);
    expect(log.total.byProvider.openai).toEqual({ sessions: 2, audioSeconds: 0, cost: 0 });
    expect(log.total.byProvider.gemini).toEqual({ sessions: 0, audioSeconds: 0, cost: 0 });
  });

  it('keeps only the openai and gemini provider buckets', () => {
    const log = normalizeLog({ version: 2, daily: {}, total: { byProvider: { openai: { sessions: 1 }, azure: { sessions: 5 } } } });
    expect(Object.keys(log.total.byProvider)).toEqual(['openai', 'gemini']);
  });

  it('returns a fresh object that shares nothing with its input', () => {
    const input = { version: 2, daily: {}, total: { sessions: 1, modes: { email: 1 } } };
    const log = normalizeLog(input);
    log.total.modes.email = 99;
    expect(input.total.modes.email).toBe(1);
  });
});

describe('applyUsage', () => {
  it('creates the day bucket and accumulates totals per provider and mode', () => {
    const now = new Date(2026, 8, 26, 10);
    let log = applyUsage(emptyLog(), entry('openai', 30, 0.002, 'email'), now);
    log = applyUsage(log, entry('gemini', 60, 0.004), now);
    const day = log.daily['2026-09-26'];
    expect(day.sessions).toBe(2);
    expect(day.audioSeconds).toBe(90);
    expect(day.estimatedCost).toBeCloseTo(0.006, 9);
    expect(day.byProvider.openai).toEqual({ sessions: 1, audioSeconds: 30, cost: 0.002 });
    expect(day.byProvider.gemini).toEqual({ sessions: 1, audioSeconds: 60, cost: 0.004 });
    expect(day.modes).toEqual({ email: 1, default: 1 });
    expect(log.total.sessions).toBe(2);
    expect(log.total.byProvider.gemini.audioSeconds).toBe(60);
  });

  it('does not mutate its input', () => {
    const before = emptyLog();
    applyUsage(before, entry('openai', 1, 0.1), new Date(2026, 8, 26));
    expect(before.total.sessions).toBe(0);
  });

  it('counts a mode named constructor as an ordinary mode', () => {
    const now = new Date(2026, 8, 26, 12);
    const log = applyUsage(emptyLog(), entry('openai', 5, 0.001, 'constructor'), now);
    expect(Object.hasOwn(log.total.modes, 'constructor')).toBe(true);
    expect(log.total.modes.constructor).toBe(1);
    expect(log.daily['2026-09-26'].modes.constructor).toBe(1);
    expect(summarize(log, now).today.modes.constructor).toBe(1);
  });

  it('gives only openai and gemini a byProvider entry', () => {
    const log = applyUsage(emptyLog(), entry('azure', 5, 0.001), new Date(2026, 8, 26));
    expect(Object.keys(log.total.byProvider)).toEqual(['openai', 'gemini']);
    expect(log.total.sessions).toBe(1);
    expect(log.total.byProvider.openai.sessions).toBe(0);
  });

  it('accepts a v2 log whose buckets are missing fields', () => {
    const log = applyUsage({ version: 2, daily: {}, total: {} }, entry('openai', 3, 0.001), new Date(2026, 8, 26));
    expect(log.total.sessions).toBe(1);
    expect(log.total.byProvider.openai).toEqual({ sessions: 1, audioSeconds: 3, cost: 0.001 });
  });

  it('keeps the day 90 days back and prunes the day 91 days back, but keeps totals', () => {
    const now = new Date(2026, 8, 26, 12);
    const day90 = new Date(2026, 8, 26 - RETENTION_DAYS, 12);
    const day91 = new Date(2026, 8, 26 - RETENTION_DAYS - 1, 12);
    let log = applyUsage(emptyLog(), entry('openai', 10, 0.001), day91);
    log = applyUsage(log, entry('openai', 10, 0.001), day90);
    log = applyUsage(log, entry('openai', 10, 0.001), now);
    expect(RETENTION_DAYS).toBe(90);
    expect(log.daily[localDateKey(day90)].sessions).toBe(1);
    expect(log.daily[localDateKey(day91)]).toBeUndefined();
    expect(log.total.sessions).toBe(3);
  });

  it('treats a non-finite audioSeconds or cost as zero', () => {
    const log = applyUsage(emptyLog(), { provider: 'openai', audioSeconds: NaN, cost: undefined, mode: 'default' }, new Date(2026, 8, 26));
    expect(log.total.audioSeconds).toBe(0);
    expect(log.total.estimatedCost).toBe(0);
    expect(log.total.sessions).toBe(1);
  });

  it('discards a v1 log shape', () => {
    const v1 = { daily: { '2026-09-01': { sessions: 5 } }, total: { sessions: 5, audioSeconds: 1, estimatedCost: 1 } };
    const log = applyUsage(v1, entry('openai', 1, 0.001), new Date(2026, 8, 26));
    expect(log.version).toBe(2);
    expect(log.total.sessions).toBe(1);
  });
});

describe('summarize', () => {
  it('sums today, the last seven days and all time', () => {
    const now = new Date(2026, 8, 26, 12);
    const daysAgo = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return d; };
    let log = emptyLog();
    log = applyUsage(log, entry('openai', 10, 0.01), now);
    log = applyUsage(log, entry('gemini', 20, 0.02), daysAgo(3));
    log = applyUsage(log, entry('openai', 40, 0.04), daysAgo(6));
    log = applyUsage(log, entry('openai', 80, 0.08), daysAgo(7));
    const s = summarize(log, now);
    expect(s.today.sessions).toBe(1);
    expect(s.today.audioSeconds).toBe(10);
    expect(s.last7Days.sessions).toBe(3);
    expect(s.last7Days.audioSeconds).toBe(70);
    expect(s.last7Days.byProvider.gemini.cost).toBeCloseTo(0.02, 9);
    expect(s.total.sessions).toBe(4);
    expect(s.total.audioSeconds).toBe(150);
  });

  it('runs where 29 March 2026 lasts 23 hours (vitest.config.js pins Europe/Athens)', () => {
    expect(new Date(2026, 2, 30) - new Date(2026, 2, 29)).toBe(23 * 60 * 60 * 1000);
  });

  it('counts seven distinct days across a DST-like boundary', () => {
    // Half past midnight on the first full day of summer time in Athens: stepping back
    // 24 hours from here lands on 28 March and would skip the 23-hour 29 March.
    const now = new Date(2026, 2, 30, 0, 30);
    let log = emptyLog();
    for (let i = 0; i < 7; i++) log = applyUsage(log, entry('openai', 1, 0.001), new Date(2026, 2, 30 - i, 12));
    expect(summarize(log, now).last7Days.sessions).toBe(7);
  });

  it('returns empty buckets for a missing log', () => {
    const s = summarize(undefined);
    expect(s.today.sessions).toBe(0);
    expect(s.total.byProvider.openai.cost).toBe(0);
  });

  it('returns empty buckets for a v1 log', () => {
    const now = new Date(2026, 8, 26, 12);
    const v1 = { daily: { '2026-09-26': { sessions: 5, audioSeconds: 50, estimatedCost: 1 } }, total: { sessions: 5, audioSeconds: 50, estimatedCost: 1 } };
    const s = summarize(v1, now);
    expect(s.today).toEqual(emptyLog().total);
    expect(s.last7Days).toEqual(emptyLog().total);
    expect(s.total).toEqual(emptyLog().total);
  });

  it('sums a partial v2 day bucket without throwing', () => {
    const now = new Date(2026, 8, 26, 12);
    const s = summarize({ version: 2, daily: { '2026-09-26': { sessions: 2 } }, total: {} }, now);
    expect(s.today.sessions).toBe(2);
    expect(s.today.byProvider.gemini.sessions).toBe(0);
  });
});
