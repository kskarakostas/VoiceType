import { describe, it, expect } from 'vitest';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, DICTIONARY_ANY, DICTIONARY_GROUPS,
  isDictionaryGroup, orderedGroupKeys, flattenDictionary, countTerms, setGroupTerms,
  groupLabel, isTermTooLong, findTermGroup, addTerms, removeTerm,
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

describe('groupLabel', () => {
  it('groupLabel names every group', () => {
    expect(groupLabel('any')).toBe('All languages');
    expect(groupLabel('el')).toBe('Greek');
    expect(groupLabel('xx')).toBe('xx');
  });
});

describe('isTermTooLong', () => {
  it('isTermTooLong counts code points', () => {
    expect(isTermTooLong('a'.repeat(64))).toBe(false);
    expect(isTermTooLong('a'.repeat(65))).toBe(true);
    expect(isTermTooLong('😀'.repeat(64))).toBe(false);
  });
});

describe('findTermGroup', () => {
  it('findTermGroup is case-insensitive and trims', () => {
    const dictionary = { any: ['OpenAI'], el: ['Νόηση'] };
    expect(findTermGroup(dictionary, ' openai ')).toBe('any');
    expect(findTermGroup(dictionary, 'ΝΌΗΣΗ')).toBe('el');
    expect(findTermGroup(dictionary, 'x')).toBe(null);
    expect(findTermGroup({}, 'x')).toBe(null);
  });
  it('trims the stored term as well', () => {
    expect(findTermGroup({ el: [' OpenAI '] }, 'openai')).toBe('el');
  });
  it('returns the first group in display order, whatever the key order', () => {
    expect(findTermGroup({ el: ['x'], any: ['X'] }, 'x')).toBe('any');
  });
});

describe('addTerms', () => {
  const stored = (count) => ({ any: Array.from({ length: count }, (_, i) => `t${i}`) });

  it('addTerms splits on commas and trims', () => {
    expect(addTerms({}, 'any', ' a, b ,,c ')).toEqual({
      dictionary: { any: ['a', 'b', 'c'] }, added: ['a', 'b', 'c'], refused: [],
    });
  });
  it('addTerms appends to an existing group and does not mutate', () => {
    const input = Object.freeze({ el: Object.freeze(['a']) });
    expect(addTerms(input, 'el', 'b').dictionary).toEqual({ el: ['a', 'b'] });
    expect(input).toEqual({ el: ['a'] });
  });
  it('addTerms refuses a term stored in any group', () => {
    const { added, refused } = addTerms({ el: ['Noesis'] }, 'any', 'noesis, x');
    expect(added).toEqual(['x']);
    expect(refused).toEqual([{ term: 'noesis', reason: 'duplicate', group: 'el' }]);
  });
  it('addTerms drops a repeat inside the input', () => {
    const { added, refused } = addTerms({}, 'any', 'a, A');
    expect(added).toEqual(['a']);
    expect(refused).toEqual([]);
  });
  it('reports a refused term once when the input repeats it', () => {
    const { refused } = addTerms({ el: ['a'] }, 'any', 'a, A');
    expect(refused).toEqual([{ term: 'a', reason: 'duplicate', group: 'el' }]);
  });
  it('addTerms refuses a term over 64 code points', () => {
    const { added, refused } = addTerms({}, 'any', 'a'.repeat(65));
    expect(refused[0].reason).toBe('tooLong');
    expect(added).toEqual([]);
  });
  it('addTerms stops at the cap', () => {
    const { added, refused } = addTerms(stored(99), 'any', 'x, y');
    expect(added).toEqual(['x']);
    expect(refused).toEqual([{ term: 'y', reason: 'full' }]);

    const full = stored(100);
    const out = addTerms(full, 'any', 'x, y');
    expect(out.added).toEqual([]);
    expect(out.dictionary).toBe(full);
    expect(out.refused).toEqual([{ term: 'x', reason: 'full' }, { term: 'y', reason: 'full' }]);
  });
  it('counts the cap across groups', () => {
    const { added, refused } = addTerms({ ...stored(99), el: ['e'] }, 'el', 'x');
    expect(added).toEqual([]);
    expect(refused).toEqual([{ term: 'x', reason: 'full' }]);
  });
  it('names a duplicate or an overlong term at the cap for what it is', () => {
    const { refused } = addTerms(stored(100), 'any', `T0, ${'a'.repeat(65)}`);
    expect(refused.map((entry) => entry.reason)).toEqual(['duplicate', 'tooLong']);
  });
  it('returns the same reference when nothing was added', () => {
    const input = { any: ['a'] };
    expect(addTerms(input, 'any', 'A').dictionary).toBe(input);
    expect(addTerms(input, 'any', ' , ').dictionary).toBe(input);
  });
  it('addTerms ignores a group that does not exist', () => {
    const input = {};
    expect(addTerms(input, '__proto__', 'x')).toEqual({ dictionary: {}, added: [], refused: [] });
    expect(({}).x).toBeUndefined();
    expect(addTerms(input, 'xx', 'x').dictionary).toBe(input);
  });
});

describe('removeTerm', () => {
  it('removeTerm keeps the group', () => {
    const input = Object.freeze({ el: Object.freeze(['a', 'b']) });
    expect(removeTerm({ el: ['a'] }, 'el', 'a')).toEqual({ el: [] });
    expect(removeTerm(input, 'el', 'a')).toEqual({ el: ['b'] });
    expect(input).toEqual({ el: ['a', 'b'] });
  });
  it('removes the exact term only', () => {
    expect(removeTerm({ el: ['A', 'a'] }, 'el', 'a')).toEqual({ el: ['A'] });
  });
  it('does not create a group it was not given', () => {
    expect(removeTerm({ el: ['a'] }, 'any', 'a')).toEqual({ el: ['a'] });
    expect(removeTerm({}, '__proto__', 'x')).toEqual({});
  });
});
