// Usage log v2. Pure functions; storage is handled by storage.js.

export const RETENTION_DAYS = 90;
const PROVIDER_KEYS = ['openai', 'gemini'];

/**
 * @typedef {{ sessions: number, audioSeconds: number, cost: number }} ProviderBucket
 * @typedef {{ sessions: number, audioSeconds: number, estimatedCost: number,
 *             byProvider: { openai: ProviderBucket, gemini: ProviderBucket }, modes: Record<string, number> }} Bucket
 * @typedef {{ version: 2, daily: Record<string, Bucket>, total: Bucket }} UsageLog
 * @typedef {{ provider: 'openai'|'gemini', audioSeconds: number, cost: number, mode: string }} UsageEntry
 */

/** Local calendar date as YYYY-MM-DD. */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Local noon n calendar days before `now`; noon keeps DST shifts from skipping or doubling a day. */
function daysAgo(now, n) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12);
}

/** @returns {ProviderBucket} */
function emptyProviderBucket() {
  return { sessions: 0, audioSeconds: 0, cost: 0 };
}

/** @returns {Bucket} */
function emptyBucket() {
  return {
    sessions: 0, audioSeconds: 0, estimatedCost: 0,
    byProvider: { openai: emptyProviderBucket(), gemini: emptyProviderBucket() },
    modes: {},
  };
}

/** @returns {UsageLog} */
export function emptyLog() {
  return { version: 2, daily: {}, total: emptyBucket() };
}

const finite = (v) => (Number.isFinite(v) ? v : 0);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Add n to record[key], reading own properties only so a mode named 'constructor' counts from 0. */
function bump(record, key, n) {
  record[key] = (Object.hasOwn(record, key) ? record[key] : 0) + n;
}

/**
 * @param {unknown} value
 * @returns {Bucket}
 */
function normalizeBucket(value) {
  const src = isObject(value) ? /** @type {any} */ (value) : {};
  const bucket = emptyBucket();
  bucket.sessions = finite(src.sessions);
  bucket.audioSeconds = finite(src.audioSeconds);
  bucket.estimatedCost = finite(src.estimatedCost);
  const byProvider = isObject(src.byProvider) ? src.byProvider : {};
  for (const p of PROVIDER_KEYS) {
    const b = Object.hasOwn(byProvider, p) && isObject(byProvider[p]) ? byProvider[p] : {};
    bucket.byProvider[p] = { sessions: finite(b.sessions), audioSeconds: finite(b.audioSeconds), cost: finite(b.cost) };
  }
  if (isObject(src.modes)) {
    for (const [mode, n] of Object.entries(src.modes)) if (Number.isFinite(n)) bump(bucket.modes, mode, n);
  }
  return bucket;
}

/**
 * The one validator for stored usage data. A v2 log keeps its data with every bucket field
 * defaulted to 0 and only the openai and gemini provider buckets; anything else is an empty
 * log. Always returns a fresh object.
 * @param {unknown} value
 * @returns {UsageLog}
 */
export function normalizeLog(value) {
  if (!isObject(value) || /** @type {any} */ (value).version !== 2) return emptyLog();
  const v = /** @type {any} */ (value);
  const log = emptyLog();
  if (isObject(v.daily)) {
    for (const [day, bucket] of Object.entries(v.daily)) if (isObject(bucket)) log.daily[day] = normalizeBucket(bucket);
  }
  log.total = normalizeBucket(v.total);
  return log;
}

function addTo(bucket, entry) {
  const audioSeconds = finite(entry.audioSeconds);
  const cost = finite(entry.cost);
  bucket.sessions += 1;
  bucket.audioSeconds += audioSeconds;
  bucket.estimatedCost += cost;
  if (PROVIDER_KEYS.includes(entry.provider)) {
    const p = bucket.byProvider[entry.provider];
    p.sessions += 1;
    p.audioSeconds += audioSeconds;
    p.cost += cost;
  }
  bump(bucket.modes, String(entry.mode), 1);
}

/**
 * @param {unknown} log
 * @param {UsageEntry} entry
 * @param {Date} [now]
 * @returns {UsageLog}
 */
export function applyUsage(log, entry, now = new Date()) {
  const next = normalizeLog(log);
  const key = localDateKey(now);
  const day = Object.hasOwn(next.daily, key) ? next.daily[key] : (next.daily[key] = emptyBucket());
  addTo(day, entry);
  addTo(next.total, entry);

  const cutoffKey = localDateKey(daysAgo(now, RETENTION_DAYS));
  for (const k of Object.keys(next.daily)) if (k < cutoffKey) delete next.daily[k];
  return next;
}

function sumDays(log, keys) {
  const acc = emptyBucket();
  for (const k of keys) {
    if (!Object.hasOwn(log.daily, k)) continue;
    const d = log.daily[k];
    acc.sessions += d.sessions;
    acc.audioSeconds += d.audioSeconds;
    acc.estimatedCost += d.estimatedCost;
    for (const p of PROVIDER_KEYS) {
      acc.byProvider[p].sessions += d.byProvider[p].sessions;
      acc.byProvider[p].audioSeconds += d.byProvider[p].audioSeconds;
      acc.byProvider[p].cost += d.byProvider[p].cost;
    }
    for (const [mode, n] of Object.entries(d.modes)) bump(acc.modes, mode, n);
  }
  return acc;
}

/**
 * @param {unknown} log
 * @param {Date} [now]
 * @returns {{ today: Bucket, last7Days: Bucket, total: Bucket }}
 */
export function summarize(log, now = new Date()) {
  const src = normalizeLog(log);
  const keys = (n) => Array.from({ length: n }, (_, i) => localDateKey(daysAgo(now, i)));
  return { today: sumDays(src, keys(1)), last7Days: sumDays(src, keys(7)), total: src.total };
}
