// Pure dictionary helpers shared by the popup, the options page and the settings layer.
// A dictionary maps a group (`any` or a spoken-language code) to its list of terms.

/** Spoken-language hints offered in the popup. `languages: []` in settings means Auto. */
export const SPOKEN_LANGUAGES = Object.freeze([
  { code: 'en', label: 'English' },
  { code: 'el', label: 'Greek' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
].map((entry) => Object.freeze(entry)));

export const MAX_KEYWORDS = 100;

/** The group whose terms apply whatever language is spoken. */
export const DICTIONARY_ANY = 'any';

/** Every dictionary group in display order: `any`, then the spoken languages. */
export const DICTIONARY_GROUPS = Object.freeze([DICTIONARY_ANY, ...SPOKEN_LANGUAGES.map((l) => l.code)]);

/**
 * @param {unknown} code
 * @returns {boolean}
 */
export function isDictionaryGroup(code) {
  return typeof code === 'string' && DICTIONARY_GROUPS.includes(code);
}

/**
 * Own keys of `dictionary` that are groups, in DICTIONARY_GROUPS order.
 * @param {Record<string, string[]>} dictionary
 * @returns {string[]}
 */
export function orderedGroupKeys(dictionary) {
  return DICTIONARY_GROUPS.filter((group) => Object.hasOwn(dictionary, group));
}

/**
 * Term lists of the known groups in display order; junk input or junk lists are skipped.
 * @param {unknown} dictionary
 * @returns {unknown[][]}
 */
function groupLists(dictionary) {
  if (typeof dictionary !== 'object' || dictionary === null || Array.isArray(dictionary)) return [];
  return orderedGroupKeys(/** @type {Record<string, string[]>} */ (dictionary))
    .map((group) => dictionary[group])
    .filter((list) => Array.isArray(list));
}

/**
 * Every term of every group in display order: trimmed, empties dropped, case-insensitive
 * duplicates dropped (first spelling kept), non-string terms skipped. No cap here;
 * settings validation caps what is stored.
 * @param {unknown} dictionary
 * @returns {string[]}
 */
export function flattenDictionary(dictionary) {
  const seen = new Set();
  const terms = [];
  for (const list of groupLists(dictionary)) {
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const term = raw.trim();
      const folded = term.toLowerCase();
      if (!term || seen.has(folded)) continue;
      seen.add(folded);
      terms.push(term);
    }
  }
  return terms;
}

/**
 * Total stored string terms across the known groups (the MAX_KEYWORDS cap counts these).
 * @param {unknown} dictionary
 * @returns {number}
 */
export function countTerms(dictionary) {
  return groupLists(dictionary)
    .reduce((total, list) => total + list.filter((term) => typeof term === 'string').length, 0);
}

/**
 * A new dictionary with `group` set to `terms`, or without `group` when `terms` is empty.
 * Never mutates `dictionary`.
 * @param {Record<string, string[]>} dictionary
 * @param {string} group
 * @param {string[]} terms
 * @returns {Record<string, string[]>}
 */
export function setGroupTerms(dictionary, group, terms) {
  const next = { ...dictionary };
  delete next[group];
  if (terms.length) next[group] = terms;
  return next;
}
