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

/** @returns {Bucket} */
function emptyBucket() {
  return {
    sessions: 0, audioSeconds: 0, estimatedCost: 0,
    byProvider: { openai: { sessions: 0, audioSeconds: 0, cost: 0 }, gemini: { sessions: 0, audioSeconds: 0, cost: 0 } },
    modes: {},
  };
}

/** @returns {UsageLog} */
export function emptyLog() {
  return { version: 2, daily: {}, total: emptyBucket() };
}

function isV2(log) {
  return Boolean(log) && log.version === 2 && typeof log.daily === 'object' && typeof log.total === 'object';
}

const finite = (v) => (Number.isFinite(v) ? v : 0);

function addTo(bucket, entry) {
  const audioSeconds = finite(entry.audioSeconds);
  const cost = finite(entry.cost);
  bucket.sessions += 1;
  bucket.audioSeconds += audioSeconds;
  bucket.estimatedCost += cost;
  const p = bucket.byProvider[entry.provider] || (bucket.byProvider[entry.provider] = { sessions: 0, audioSeconds: 0, cost: 0 });
  p.sessions += 1;
  p.audioSeconds += audioSeconds;
  p.cost += cost;
  bucket.modes[entry.mode] = (bucket.modes[entry.mode] || 0) + 1;
}

/**
 * @param {unknown} log
 * @param {UsageEntry} entry
 * @param {Date} [now]
 * @returns {UsageLog}
 */
export function applyUsage(log, entry, now = new Date()) {
  const next = isV2(log) ? structuredClone(log) : emptyLog();
  const key = localDateKey(now);
  const day = next.daily[key] || (next.daily[key] = emptyBucket());
  addTo(day, entry);
  addTo(next.total, entry);

  const cutoffKey = localDateKey(daysAgo(now, RETENTION_DAYS));
  for (const k of Object.keys(next.daily)) if (k < cutoffKey) delete next.daily[k];
  return next;
}

function sumDays(log, keys) {
  const acc = emptyBucket();
  for (const k of keys) {
    const d = log.daily[k];
    if (!d) continue;
    acc.sessions += d.sessions;
    acc.audioSeconds += d.audioSeconds;
    acc.estimatedCost += d.estimatedCost;
    for (const p of PROVIDER_KEYS) {
      acc.byProvider[p].sessions += d.byProvider?.[p]?.sessions || 0;
      acc.byProvider[p].audioSeconds += d.byProvider?.[p]?.audioSeconds || 0;
      acc.byProvider[p].cost += d.byProvider?.[p]?.cost || 0;
    }
    for (const [mode, n] of Object.entries(d.modes || {})) acc.modes[mode] = (acc.modes[mode] || 0) + n;
  }
  return acc;
}

/**
 * @param {unknown} log
 * @param {Date} [now]
 * @returns {{ today: Bucket, last7Days: Bucket, total: Bucket }}
 */
export function summarize(log, now = new Date()) {
  const src = isV2(log) ? log : emptyLog();
  const keys = (n) => Array.from({ length: n }, (_, i) => localDateKey(daysAgo(now, i)));
  return { today: sumDays(src, keys(1)), last7Days: sumDays(src, keys(7)), total: structuredClone(src.total) };
}
