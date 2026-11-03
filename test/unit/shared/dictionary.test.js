import { describe, it, expect } from 'vitest';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, DICTIONARY_ANY, DICTIONARY_GROUPS,
  isDictionaryGroup, orderedGroupKeys, flattenDictionary, countTerms, setGroupTerms,
} from '../../../src/shared/dictionary.js';

describe('dictionary constants', () => {
  it('SPOKEN_LANGUAGES and MAX_KEYWORDS moved unchanged', () => {
    expect(SPOKEN_LANGUAGES.map((l) => l.code)).toEqual(['en', 'el', 'es', 'fr', 'de', 'it', 'pt']);
    expect(SPOKEN_LANGUAGES.map((l) => l.label)).toEqual(['English', 'Greek', 'Spanish', 'French', 'German', 'Italian', 'Portuguese']);
    expect(Object.isFrozen(SPOKEN_LANGUAGES)).toBe(true);
    expect(SPOKEN_LANGUAGES.every((l) => Object.isFrozen(l))).toBe(true);
    expect(MAX_KEYWORDS).toBe(100);
  });
  it('DICTIONARY_GROUPS lists any first, then the spoken languages', () => {
    expect(DICTIONARY_ANY).toBe('any');
    expect(DICTIONARY_GROUPS).toEqual(['any', 'en', 'el', 'es', 'fr', 'de', 'it', 'pt']);
    expect(Object.isFrozen(DICTIONARY_GROUPS)).toBe(true);
  });
});

describe('isDictionaryGroup', () => {
  it('accepts the known groups only', () => {
    expect(isDictionaryGroup('any')).toBe(true);
    expect(isDictionaryGroup('el')).toBe(true);
    expect(isDictionaryGroup('xx')).toBe(false);
    expect(isDictionaryGroup('EL')).toBe(false);
    expect(isDictionaryGroup(null)).toBe(false);
    expect(isDictionaryGroup('constructor')).toBe(false);
  });
});

describe('orderedGroupKeys', () => {
  it('returns own group keys in DICTIONARY_GROUPS order', () => {
    expect(orderedGroupKeys({ pt: [], xx: ['a'], el: ['b'], any: [] })).toEqual(['any', 'el', 'pt']);
    expect(orderedGroupKeys({})).toEqual([]);
  });
  it('ignores inherited keys', () => {
    expect(orderedGroupKeys(Object.create({ any: ['a'] }))).toEqual([]);
  });
});

describe('flattenDictionary', () => {
  it('flattenDictionary follows display order and drops case-insensitive duplicates', () => {
    expect(flattenDictionary({ el: ['Νόησις', 'palowise'], any: [' Palowise ', '', 'Noesis'], xx: ['Stray'] }))
      .toEqual(['Palowise', 'Noesis', 'Νόησις']);
  });
  it('flattenDictionary tolerates junk', () => {
    expect(flattenDictionary(null)).toEqual([]);
    expect(flattenDictionary([])).toEqual([]);
    expect(flattenDictionary('x')).toEqual([]);
    expect(flattenDictionary({ any: 'x' })).toEqual([]);
    expect(flattenDictionary({ any: [1, 'a'] })).toEqual(['a']);
  });
  it('applies no cap', () => {
    const terms = Array.from({ length: 150 }, (_, i) => `t${i}`);
    expect(flattenDictionary({ any: terms })).toHaveLength(150);
  });
});

describe('countTerms', () => {
  it('countTerms counts stored string terms in known groups', () => {
    expect(countTerms({ any: ['a', 'b'], el: ['c'], xx: ['d'] })).toBe(3);
  });
  it('tolerates junk', () => {
    expect(countTerms(null)).toBe(0);
    expect(countTerms([])).toBe(0);
    expect(countTerms({ any: 'ab', el: [1, 'c'] })).toBe(1);
  });
});

describe('setGroupTerms', () => {
  it('setGroupTerms replaces or removes a group without mutating', () => {
    const input = Object.freeze({ any: Object.freeze(['a']), el: Object.freeze(['b']) });
    expect(setGroupTerms(input, 'any', [])).toEqual({ el: ['b'] });
    expect(setGroupTerms(input, 'el', ['c', 'd'])).toEqual({ any: ['a'], el: ['c', 'd'] });
    expect(input).toEqual({ any: ['a'], el: ['b'] });
    expect(setGroupTerms({}, 'any', ['x'])).toEqual({ any: ['x'] });
  });
  it('returns a new object', () => {
    const input = { any: ['a'] };
    const out = setGroupTerms(input, 'any', ['a']);
    expect(out).not.toBe(input);
  });
});
