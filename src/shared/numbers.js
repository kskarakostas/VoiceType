/**
 * The number itself, or 0 for NaN, an infinity or anything that is not a number.
 * @param {unknown} value
 * @returns {number}
 */
export function finite(value) {
  return Number.isFinite(value) ? /** @type {number} */ (value) : 0;
}
