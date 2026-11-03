import { describe, it, expect } from 'vitest';
import {
  TYPING_WPM, MIN_SPEED_SECONDS, MIN_COST_WORDS,
  typingMinutes, talkingMinutes, minutesSaved, speakingWpm, costPerThousandWords,
  refinedSessions, formatMinutes, formatCount, homeView,
} from '../../../src/options/home-stats.js';

const NOT_COUNTED = 'Counted from 3.0 on';
const BAD_NUMBER = /NaN|Infinity|-\d/;

/** @param {Partial<Record<string, unknown>>} [fields] */
function bucket(fields = {}) {
  return {
    sessions: 0, audioSeconds: 0, estimatedCost: 0, words: 0, wordSeconds: 0, wordCost: 0,
    byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
    modes: {},
    ...fields,
  };
}

/** @param {number[]} sessions @param {number} todayIndex */
function week(sessions, todayIndex) {
  return { days: sessions.map((n, i) => ({ date: `2026-11-0${i + 2}`, sessions: n })), todayIndex };
}

describe('home stat thresholds', () => {
  it('pins the constants', () => {
    expect(TYPING_WPM).toBe(40);
    expect(MIN_SPEED_SECONDS).toBe(30);
    expect(MIN_COST_WORDS).toBe(100);
  });

  it('speakingWpm shows from 30 s', () => {
    expect(speakingWpm(70, 29.9)).toBeNull();
    expect(speakingWpm(70, 30)).toBe(140);
  });

  it('costPerThousandWords shows from 100 words', () => {
    expect(costPerThousandWords(0.01, 99)).toBeNull();
    expect(costPerThousandWords(0.01, 100)).toBeCloseTo(0.1);
  });

  it('minutesSaved is floored at 0', () => {
    expect(minutesSaved(400, 120)).toBe(8);
    expect(minutesSaved(10, 600)).toBe(0);
    expect(typingMinutes(400)).toBe(10);
    expect(talkingMinutes(120)).toBe(2);
  });

  it('refinedSessions skips default', () => {
    expect(refinedSessions({ default: 5, email: 2, translate: 1 })).toBe(3);
    expect(refinedSessions({})).toBe(0);
  });
});

describe('home formatting', () => {
  it('formatMinutes', () => {
    const cases = [[0, '0 min'], [0.4, 'under 1 min'], [0.6, 'under 1 min'], [1.4, '1 min'],
      [59.6, '1 h 0 min'], [60, '1 h 0 min'], [125, '2 h 5 min']];
    for (const [m, s] of cases) expect(formatMinutes(/** @type {number} */ (m))).toBe(s);
  });

  it('formatCount groups thousands', () => {
    expect(formatCount(1234)).toBe('1,234');
    expect(formatCount(0)).toBe('0');
  });
});

describe('homeView', () => {
  it('homeView of a full week', () => {
    const thisWeek = bucket({ sessions: 9, words: 600, wordSeconds: 180, wordCost: 0.02, estimatedCost: 0.025,
      modes: { default: 5, email: 4 } });
    const summary = { today: bucket(), last7Days: thisWeek, thisWeek,
      total: bucket({ sessions: 30, words: 2000 }), week: week([1, 0, 2, 0, 0, 0, 0], 2) };
    const view = homeView(summary);
    expect(view).toMatchObject({
      state: 'full',
      saved: 'about 12 min',
      savedDetail: '3 min talking instead of 15 min typing',
      wordsWeek: '600',
      wordsTotal: '2,000',
      speed: '200 words per minute',
      refined: '4 of 9 sessions',
      costWeek: '$0.03',
      costPer1k: '$0.03',
      daysCount: '2 of 7 days',
    });
    expect(view.days).toHaveLength(7);
    expect(view.days[0]).toEqual({ label: 'Mon', name: 'Monday', state: 'dictated', today: false });
    expect(view.days[1].state).toBe('missed');
    expect(view.days[2]).toEqual({ label: 'Wed', name: 'Wednesday', state: 'dictated', today: true });
    expect(view.days[3].state).toBe('upcoming');
    expect(view.days[6]).toEqual({ label: 'Sun', name: 'Sunday', state: 'upcoming', today: false });
  });

  it('a 2.2 summary gives the noWords state with no NaN', () => {
    // A 2.2 bucket: sessions, audio and cost, no word fields.
    const old = { sessions: 4, audioSeconds: 90, estimatedCost: 0.02,
      byProvider: { openai: { sessions: 4, audioSeconds: 90, cost: 0.02 } }, modes: { default: 3, email: 1 } };
    const view = homeView({ today: old, last7Days: old, thisWeek: old, total: { ...old, sessions: 12 },
      week: week([2, 2, 0, 0, 0, 0, 0], 1) });
    expect(view.state).toBe('noWords');
    for (const key of ['saved', 'savedDetail', 'wordsWeek', 'wordsTotal', 'speed', 'costPer1k']) {
      expect(view[key]).toBe(NOT_COUNTED);
    }
    expect(view.refined).toBe('1 of 4 sessions');
    expect(view.costWeek).toBe('$0.02');
    expect(view.daysCount).toBe('2 of 7 days');
    expect(JSON.stringify(view)).not.toMatch(BAD_NUMBER);
  });

  it('an empty log gives the empty state', () => {
    const view = homeView({ today: bucket(), last7Days: bucket(), thisWeek: bucket(), total: bucket(),
      week: week([0, 0, 0, 0, 0, 0, 0], 4) });
    expect(view.state).toBe('empty');
    expect(JSON.stringify(view)).not.toMatch(BAD_NUMBER);
  });

  it('a non-object summary or one without total gives the error state', () => {
    for (const summary of [null, 'x', {}, undefined, 42, [], { total: 'x' }]) {
      const view = homeView(summary);
      expect(view.state).toBe('error');
      expect(view.days).toHaveLength(7);
      expect(JSON.stringify(view)).not.toMatch(BAD_NUMBER);
    }
  });

  it('homeView reads negative and non-finite numbers as 0', () => {
    const thisWeek = { words: -50, wordSeconds: Infinity, wordCost: 'x', sessions: -1,
      estimatedCost: -Infinity, modes: { default: -2, email: -3, translate: NaN, grammar: 'x' } };
    const view = homeView({ thisWeek, total: { sessions: 3, words: 10 },
      week: { days: [-1, NaN, Infinity, 'x', null, { sessions: -4 }, { sessions: Infinity }], todayIndex: 6 } });
    for (const value of Object.values(view)) {
      if (typeof value === 'string') expect(value).not.toMatch(BAD_NUMBER);
    }
    expect(JSON.stringify(view)).not.toMatch(BAD_NUMBER);
    expect(view.refined).toBe('No sessions yet');
    expect(view.daysCount).toBe('0 of 7 days');
  });

  it('negative mode counts do not reduce refined sessions', () => {
    const thisWeek = bucket({ sessions: 5, words: 200, wordSeconds: 60, modes: { default: 1, email: 3, translate: -9 } });
    expect(homeView({ thisWeek, total: thisWeek, week: week([5, 0, 0, 0, 0, 0, 0], 0) }).refined).toBe('3 of 5 sessions');
  });

  it('gated stats below the thresholds', () => {
    const view = homeView({ thisWeek: bucket({ sessions: 2, words: 50, wordSeconds: 20 }),
      total: bucket({ sessions: 2, words: 50 }), week: week([2, 0, 0, 0, 0, 0, 0], 0) });
    expect(view.speed).toBe('Shows after 30 s of talking');
    expect(view.costPer1k).toBe('Shows after 100 words');
  });

  it('saved drops "about" under one minute', () => {
    const view = homeView({ thisWeek: bucket({ sessions: 1, words: 20, wordSeconds: 6 }),
      total: bucket({ sessions: 1, words: 20 }), week: week([1, 0, 0, 0, 0, 0, 0], 0) });
    expect(view.saved).toBe('under 1 min');
  });

  it('a malformed week gives seven missed days', () => {
    for (const bad of [{ days: [], todayIndex: 9 }, { days: [{}, {}, {}, {}, {}, {}, {}], todayIndex: 1.5 }, 'x', null]) {
      const view = homeView({ thisWeek: bucket(), total: bucket({ sessions: 1 }), week: bad });
      expect(view.days).toHaveLength(7);
      expect(view.days.every((d) => d.state === 'missed' && !d.today)).toBe(true);
      expect(view.daysCount).toBe('0 of 7 days');
    }
  });
});
