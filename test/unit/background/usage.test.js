import { describe, it, expect } from 'vitest';
import { localDateKey, emptyLog, normalizeLog, applyUsage, summarize, countWords, RETENTION_DAYS } from '../../../src/background/usage.js';

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

describe('countWords', () => {
  it('countWords counts Greek and English words', () => {
    expect(countWords("Hello, world! It's a test.")).toBe(5);
    expect(countWords('Καλημέρα, τι κάνεις; Είμαι καλά.')).toBe(5);
    expect(countWords('')).toBe(0);
    expect(countWords('...!!!')).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(42)).toBe(0);
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
      sessions: 2, audioSeconds: 0, estimatedCost: 0, words: 0, wordSeconds: 0, wordCost: 0,
      byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
      modes: { email: 2 },
    });
    expect(log.daily['2026-09-25']).toBeUndefined();
    expect(log.total.estimatedCost).toBe(0);
    expect(log.total.byProvider.openai).toEqual({ sessions: 2, audioSeconds: 0, cost: 0 });
    expect(log.total.byProvider.gemini).toEqual({ sessions: 0, audioSeconds: 0, cost: 0 });
  });

  it('normalizeLog defaults the word fields of a 2.2 bucket to 0', () => {
    const old = { sessions: 3, audioSeconds: 90, estimatedCost: 0.01 };
    const log = normalizeLog({ version: 2, daily: { '2026-09-26': { ...old } }, total: { ...old } });
    for (const b of [log.daily['2026-09-26'], log.total]) {
      expect(b.sessions).toBe(3);
      expect(b.words).toBe(0);
      expect(b.wordSeconds).toBe(0);
      expect(b.wordCost).toBe(0);
    }
    const bad = normalizeLog({ version: 2, daily: {}, total: { words: 'x', wordSeconds: NaN, wordCost: Infinity } });
    expect(bad.total.words).toBe(0);
    expect(bad.total.wordSeconds).toBe(0);
    expect(bad.total.wordCost).toBe(0);
  });

  it('normalizeLog keeps stored word fields', () => {
    const fields = { words: 120, wordSeconds: 45, wordCost: 0.004 };
    const log = normalizeLog({ version: 2, daily: { '2026-09-26': { ...fields } }, total: { ...fields } });
    expect(log.daily['2026-09-26']).toMatchObject(fields);
    expect(log.total).toMatchObject(fields);
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

  it('applyUsage carries words, wordSeconds and wordCost into the day and the total', () => {
    const now = new Date(2026, 8, 26, 10);
    let log = applyUsage(emptyLog(), { provider: 'openai', audioSeconds: 30, cost: 0.003, mode: 'default', words: 70 }, now);
    log = applyUsage(log, { provider: 'openai', audioSeconds: 15, cost: 0.0015, mode: 'default', words: 0 }, now);
    for (const b of [log.daily['2026-09-26'], log.total]) {
      expect(b.words).toBe(70);
      expect(b.wordSeconds).toBe(45);
      expect(b.wordCost).toBeCloseTo(0.0045, 9);
      expect(Object.hasOwn(b.byProvider.openai, 'words')).toBe(false);
    }
  });

  it('an entry without words counts as a session but not toward word stats', () => {
    const now = new Date(2026, 8, 26, 10);
    const variants = [entry('openai', 30, 0.003), ...[-1, NaN, '5'].map((words) => ({ ...entry('openai', 30, 0.003), words }))];
    for (const e of variants) {
      const log = applyUsage(emptyLog(), e, now);
      for (const b of [log.daily['2026-09-26'], log.total]) {
        expect(b, String(e.words)).toMatchObject({ sessions: 1, audioSeconds: 30, words: 0, wordSeconds: 0, wordCost: 0 });
      }
    }
  });

  it('the word fields survive a second applyUsage', () => {
    const now = new Date(2026, 8, 26, 10);
    let log = applyUsage(emptyLog(), { ...entry('openai', 10, 0.001), words: 10 }, now);
    log = applyUsage(log, { ...entry('openai', 10, 0.001), words: 5 }, now);
    expect(log.daily['2026-09-26'].words).toBe(15);
    expect(log.daily['2026-09-26'].wordSeconds).toBe(20);
    expect(log.total.words).toBe(15);
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

  it('summarize sums word fields in today, last7Days, thisWeek and total', () => {
    const now = new Date(2026, 10, 4, 10); // Wednesday
    let log = applyUsage(emptyLog(), { ...entry('openai', 20, 0.002), words: 40 }, new Date(2026, 10, 3, 12));
    log = applyUsage(log, { ...entry('openai', 10, 0.001), words: 25 }, now);
    const s = summarize(log, now);
    expect(s.today).toMatchObject({ words: 25, wordSeconds: 10 });
    expect(s.today.wordCost).toBeCloseTo(0.001, 9);
    for (const b of [s.last7Days, s.thisWeek, s.total]) {
      expect(b).toMatchObject({ words: 65, wordSeconds: 30 });
      expect(b.wordCost).toBeCloseTo(0.003, 9);
    }
  });

  it('thisWeek runs from Monday through today', () => {
    const now = new Date(2026, 10, 4, 10);
    let log = applyUsage(emptyLog(), entry('openai', 10, 0.001), new Date(2026, 10, 1, 12));
    log = applyUsage(log, entry('openai', 10, 0.001), new Date(2026, 10, 2, 12));
    log = applyUsage(log, entry('openai', 10, 0.001), new Date(2026, 10, 4, 9));
    const s = summarize(log, now);
    expect(s.thisWeek.sessions).toBe(2);
    expect(s.week.days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
    expect(s.week.days.map((d) => d.sessions)).toEqual([1, 0, 1, 0, 0, 0, 0]);
    expect(s.week.todayIndex).toBe(2);
  });

  it('the week runs Monday to Sunday across the March DST change', () => {
    const sunday = summarize(emptyLog(), new Date(2026, 2, 29, 22));
    expect(sunday.week.days[0].date).toBe('2026-03-23');
    expect(sunday.week.days[6].date).toBe('2026-03-29');
    expect(sunday.week.todayIndex).toBe(6);
    expect(new Set(sunday.week.days.map((d) => d.date)).size).toBe(7);

    const now = new Date(2026, 2, 30, 0, 30);
    let log = applyUsage(emptyLog(), entry('openai', 1, 0.001), new Date(2026, 2, 29, 12));
    log = applyUsage(log, entry('openai', 1, 0.001), now);
    const monday = summarize(log, now);
    expect(monday.week.days[0].date).toBe('2026-03-30');
    expect(monday.week.todayIndex).toBe(0);
    expect(new Set(monday.week.days.map((d) => d.date)).size).toBe(7);
    expect(monday.thisWeek.sessions).toBe(1);
  });

  it('summarize of a missing log has an empty thisWeek and a seven-day week', () => {
    const s = summarize(undefined, new Date(2026, 10, 4, 10));
    expect(s.thisWeek).toEqual(emptyLog().total);
    expect(s.week.days).toHaveLength(7);
    expect(s.week.days.every((d) => d.sessions === 0)).toBe(true);
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
