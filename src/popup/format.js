// How the popup writes its numbers.

/**
 * Seconds as m:ss, or h:mm:ss from one hour up, cut down to whole seconds as the Usage table
 * does. Anything but a positive finite number reads 0:00.
 * @param {number} seconds
 * @returns {string}
 */
export function formatSpoken(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
