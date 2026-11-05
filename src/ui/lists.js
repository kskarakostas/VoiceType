/**
 * True when both lists hold the same items, by identity, in the same order.
 * @param {unknown[]} a
 * @param {unknown[]} b
 * @returns {boolean}
 */
export function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
