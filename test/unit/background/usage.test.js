import { describe, it, expect } from 'vitest';
import { localDateKey, emptyLog, applyUsage, summarize, RETENTION_DAYS } from '../../../src/background/usage.js';

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

  it('prunes days older than the retention window but keeps totals', () => {
    const old = new Date(2026, 0, 1);
    let log = applyUsage(emptyLog(), entry('openai', 10, 0.001), old);
    const now = new Date(2026, 8, 26);
    log = applyUsage(log, entry('openai', 10, 0.001), now);
    expect(log.daily['2026-01-01']).toBeUndefined();
    expect(log.daily['2026-09-26'].sessions).toBe(1);
    expect(log.total.sessions).toBe(2);
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
    expect(RETENTION_DAYS).toBe(90);
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

  it('counts seven distinct days across a DST-like boundary', () => {
    const now = new Date(2026, 2, 29, 23, 30);
    let log = emptyLog();
    for (let i = 0; i < 7; i++) log = applyUsage(log, entry('openai', 1, 0.001), new Date(2026, 2, 29 - i, 12));
    expect(summarize(log, now).last7Days.sessions).toBe(7);
  });

  it('returns empty buckets for a missing log', () => {
    const s = summarize(undefined);
    expect(s.today.sessions).toBe(0);
    expect(s.total.byProvider.openai.cost).toBe(0);
  });
});
