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

/** Longest term in code points; Gemini's hint sanitizer cuts at 64. */
export const MAX_TERM_LENGTH = 64;

/**
 * @param {string} group
 * @returns {string} `All languages` for `any`, else the language label, else `group`.
 */
export function groupLabel(group) {
  if (group === DICTIONARY_ANY) return 'All languages';
  return SPOKEN_LANGUAGES.find((language) => language.code === group)?.label ?? group;
}

/**
 * @param {string} term
 * @returns {boolean} True past MAX_TERM_LENGTH code points.
 */
export function isTermTooLong(term) {
  return [...term].length > MAX_TERM_LENGTH;
}

/**
 * The group holding `term`, first in display order; case-insensitive after trim.
 * @param {Record<string, string[]>} dictionary
 * @param {string} term
 * @returns {string|null}
 */
export function findTermGroup(dictionary, term) {
  const folded = term.trim().toLowerCase();
  const holds = (group) => dictionary[group].some((stored) => stored.trim().toLowerCase() === folded);
  return orderedGroupKeys(dictionary).find(holds) ?? null;
}

/**
 * Adds the comma-separated terms of `text` to `group`: trimmed, empties dropped, a repeat
 * inside `text` dropped silently. Stored terms, overlong terms and terms past MAX_KEYWORDS
 * are refused, in that order. Never mutates `dictionary`; the same reference comes back
 * when nothing was added, and an unknown group adds and refuses nothing.
 * @param {Record<string, string[]>} dictionary
 * @param {string} group
 * @param {string} text
 * @returns {{
 *   dictionary: Record<string, string[]>,
 *   added: string[],
 *   refused: Array<{ term: string, reason: 'duplicate'|'tooLong'|'full', group?: string }>,
 * }}
 */
export function addTerms(dictionary, group, text) {
  const added = [];
  const refused = [];
  if (!isDictionaryGroup(group)) return { dictionary, added, refused };

  const room = MAX_KEYWORDS - countTerms(dictionary);
  const seen = new Set();
  for (const raw of text.split(',')) {
    const term = raw.trim();
    const folded = term.toLowerCase();
    if (!term || seen.has(folded)) continue;
    seen.add(folded);

    const holder = findTermGroup(dictionary, term);
    if (holder !== null) refused.push({ term, reason: 'duplicate', group: holder });
    else if (isTermTooLong(term)) refused.push({ term, reason: 'tooLong' });
    else if (added.length >= room) refused.push({ term, reason: 'full' });
    else added.push(term);
  }

  if (!added.length) return { dictionary, added, refused };
  const next = setGroupTerms(dictionary, group, [...(dictionary[group] ?? []), ...added]);
  return { dictionary: next, added, refused };
}

/**
 * A new dictionary without that exact term. The group stays, even empty; a group that is
 * not in `dictionary` is not created.
 * @param {Record<string, string[]>} dictionary
 * @param {string} group
 * @param {string} term
 * @returns {Record<string, string[]>}
 */
export function removeTerm(dictionary, group, term) {
  if (!Object.hasOwn(dictionary, group)) return { ...dictionary };
  return { ...dictionary, [group]: dictionary[group].filter((stored) => stored !== term) };
}
