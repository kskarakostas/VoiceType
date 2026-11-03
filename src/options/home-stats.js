// Home dashboard stats: pure functions from the GET_USAGE summary to the strings Home shows.
// homeView takes the reply as unknown and reads every number through one clamp, so a corrupt
// or 2.2 log never puts NaN, Infinity or a negative number on the page.
import { formatCost } from '../shared/pricing.js';

/** Typing speed Home compares dictation against (V14). */
export const TYPING_WPM = 40;
/** Talking time below which speaking speed stays hidden. */
export const MIN_SPEED_SECONDS = 30;
/** Word count below which cost per 1,000 words stays hidden. */
export const MIN_COST_WORDS = 100;

export const NOT_COUNTED = 'Counted from 3.0 on';
export const GATED_SPEED = 'Shows after 30 s of talking';
export const GATED_COST = 'Shows after 100 words';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * @typedef {{
 *   state: 'error'|'empty'|'noWords'|'full',
 *   saved: string,
 *   savedDetail: string,
 *   wordsWeek: string,
 *   wordsTotal: string,
 *   speed: string,
 *   refined: string,
 *   costWeek: string,
 *   costPer1k: string,
 *   days: Array<{ label: string, name: string, state: 'dictated'|'missed'|'upcoming', today: boolean }>,
 *   daysCount: string,
 * }} HomeView
 * @typedef {{ sessions: number, estimatedCost: number, words: number, wordSeconds: number,
 *             wordCost: number, modes: Record<string, number> }} HomeBucket
 */

/** @param {number} words */
export function typingMinutes(words) {
  return words / TYPING_WPM;
}

/** @param {number} wordSeconds */
export function talkingMinutes(wordSeconds) {
  return wordSeconds / 60;
}

/** @param {number} words @param {number} wordSeconds */
export function minutesSaved(words, wordSeconds) {
  return Math.max(0, typingMinutes(words) - talkingMinutes(wordSeconds));
}

/**
 * @param {number} words
 * @param {number} wordSeconds
 * @returns {number|null} null below MIN_SPEED_SECONDS of talking
 */
export function speakingWpm(words, wordSeconds) {
  return wordSeconds >= MIN_SPEED_SECONDS ? (words / wordSeconds) * 60 : null;
}

/**
 * @param {number} wordCost
 * @param {number} words
 * @returns {number|null} USD; null below MIN_COST_WORDS words
 */
export function costPerThousandWords(wordCost, words) {
  return words >= MIN_COST_WORDS ? (wordCost / words) * 1000 : null;
}

/**
 * Sessions run in any mode other than default.
 * @param {Record<string, number>} modes
 */
export function refinedSessions(modes) {
  let n = 0;
  for (const [mode, count] of Object.entries(modes)) if (mode !== 'default') n += count;
  return n;
}

/** @param {number} minutes */
export function formatMinutes(minutes) {
  if (!(minutes > 0)) return '0 min';
  if (minutes < 1) return 'under 1 min';
  const m = Math.round(minutes);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** @param {number} n */
export function formatCount(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} v */
const clamp = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * @param {unknown} value
 * @returns {HomeBucket}
 */
function readBucket(value) {
  const src = isObject(value) ? /** @type {any} */ (value) : {};
  // Object.fromEntries defines own properties, so a mode named __proto__ stays a plain count.
  const modes = isObject(src.modes)
    ? Object.fromEntries(Object.entries(src.modes).map(([mode, n]) => [mode, clamp(n)]))
    : {};
  return {
    sessions: clamp(src.sessions), estimatedCost: clamp(src.estimatedCost), words: clamp(src.words),
    wordSeconds: clamp(src.wordSeconds), wordCost: clamp(src.wordCost), modes,
  };
}

/**
 * Seven Monday-first days; a week that is not seven days with todayIndex 0 to 6 reads as
 * seven missed days with no today.
 * @param {unknown} value
 * @returns {HomeView['days']}
 */
function readDays(value) {
  const src = isObject(value) ? /** @type {any} */ (value) : {};
  const valid = Array.isArray(src.days) && src.days.length === 7
    && Number.isInteger(src.todayIndex) && src.todayIndex >= 0 && src.todayIndex <= 6;
  return DAY_LABELS.map((label, i) => {
    /** @type {'dictated'|'missed'|'upcoming'} */
    let state = 'missed';
    if (valid && i > src.todayIndex) state = 'upcoming';
    else if (valid && isObject(src.days[i]) && clamp(src.days[i].sessions) > 0) state = 'dictated';
    return { label, name: DAY_NAMES[i], state, today: valid && i === src.todayIndex };
  });
}

/**
 * The one function the Home section calls. Survives any shape of GET_USAGE reply.
 * @param {unknown} summary
 * @returns {HomeView}
 */
export function homeView(summary) {
  const src = isObject(summary) ? /** @type {any} */ (summary) : {};
  const hasTotal = isObject(src.total);
  const week = readBucket(src.thisWeek);
  const total = readBucket(src.total);
  const days = readDays(src.week);

  /** @type {HomeView['state']} */
  let state = 'full';
  if (!hasTotal) state = 'error';
  else if (total.sessions === 0) state = 'empty';
  else if (total.words === 0) state = 'noWords';

  const saved = minutesSaved(week.words, week.wordSeconds);
  const wpm = speakingWpm(week.words, week.wordSeconds);
  const per1k = costPerThousandWords(week.wordCost, week.words);
  const wordStats = {
    saved: (saved >= 1 ? 'about ' : '') + formatMinutes(saved),
    savedDetail: `${formatMinutes(talkingMinutes(week.wordSeconds))} talking instead of `
      + `${formatMinutes(typingMinutes(week.words))} typing`,
    wordsWeek: formatCount(week.words),
    wordsTotal: formatCount(total.words),
    speed: wpm === null ? GATED_SPEED : `${Math.round(wpm)} words per minute`,
    costPer1k: per1k === null ? GATED_COST : formatCost(per1k),
  };
  if (state === 'noWords') for (const key of Object.keys(wordStats)) wordStats[key] = NOT_COUNTED;

  const dictated = days.filter((d) => d.state === 'dictated').length;
  return {
    state,
    ...wordStats,
    refined: week.sessions === 0 ? 'No sessions yet' : `${refinedSessions(week.modes)} of ${week.sessions} sessions`,
    costWeek: formatCost(week.estimatedCost),
    days,
    daysCount: `${dictated} of 7 days`,
  };
}
