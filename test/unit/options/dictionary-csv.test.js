import { describe, it, expect } from 'vitest';
import {
  MAX_IMPORT_BYTES, serializeDictionary, parseCsv, importDictionaryCsv,
} from '../../../src/options/dictionary-csv.js';

const BOM = '﻿';
const NOT_UTF8 = 'This file is not UTF-8. Save it as CSV UTF-8 and try again. Nothing was imported.';
const NO_TERMS = { ok: false, message: 'No terms in that file.' };

const ok = (text, d = {}) => {
  const r = importDictionaryCsv(text, d);
  expect(r.ok, r.message).toBe(true);
  return r;
};
const fieldsOf = (result) => result.records.map((record) => record.fields);
const linesOf = (result) => result.records.map((record) => record.line);
const terms = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('MAX_IMPORT_BYTES', () => {
  it('is one million bytes', () => {
    expect(MAX_IMPORT_BYTES).toBe(1_000_000);
  });
});

describe('serializeDictionary', () => {
  it('serializes with BOM, header and CRLF in display order', () => {
    expect(serializeDictionary({ el: ['Νόηση'], any: ['OpenAI'] }))
      .toBe(`${BOM}language,term\r\nany,OpenAI\r\nel,Νόηση\r\n`);
  });

  it('quotes fields with separators and quotes', () => {
    expect(serializeDictionary({ any: ['Acme, Inc', 'say "hi"', 'a;b'] }))
      .toBe(`${BOM}language,term\r\nany,"Acme, Inc"\r\nany,"say ""hi"""\r\nany,"a;b"\r\n`);
  });

  it('an empty dictionary serializes to the header', () => {
    expect(serializeDictionary({ en: [] })).toBe(`${BOM}language,term\r\n`);
  });
});

describe('parseCsv', () => {
  it('parses CRLF, LF and CR', () => {
    const result = parseCsv('a\r\nb\nc\rd');
    expect(fieldsOf(result)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(linesOf(result)).toEqual([1, 2, 3, 4]);
  });

  it('handles quotes per RFC 4180', () => {
    expect(fieldsOf(parseCsv('"a,b","c""d"\r\n'))).toEqual([['a,b', 'c"d']]);
  });

  it('keeps line numbers across quoted line breaks and blank lines', () => {
    const result = parseCsv('"a\nb"\n\nc');
    expect(linesOf(result)).toEqual([1, 4]);
    expect(result.records[0].fields[0]).toBe('a\nb');
  });

  it('counts a quoted CRLF as one line break', () => {
    expect(linesOf(parseCsv('"a\r\nb"\r\nc'))).toEqual([1, 3]);
  });

  it('strips a BOM', () => {
    expect(fieldsOf(parseCsv(`${BOM}a`))).toEqual([['a']]);
  });

  it('a quote inside an unquoted field is literal', () => {
    expect(fieldsOf(parseCsv('5" disk'))).toEqual([['5" disk']]);
  });

  it("fails on an unclosed quote at the record's line", () => {
    expect(parseCsv('a\n"b\nc')).toEqual({ ok: false, line: 2, reason: 'a quote is never closed' });
  });

  it('fails on text after a closing quote', () => {
    expect(parseCsv('"a"b')).toEqual({ ok: false, line: 1, reason: 'text follows a closing quote' });
  });

  it('reports failures at the line the record starts on', () => {
    expect(parseCsv('x\n"a\nb","c')).toEqual({ ok: false, line: 2, reason: 'a quote is never closed' });
    expect(parseCsv('x\n"a\nb"c')).toEqual({ ok: false, line: 2, reason: 'text follows a closing quote' });
  });

  it('drops records with only blank fields', () => {
    expect(parseCsv('\n , \n,\n')).toEqual({ ok: true, records: [] });
  });

  it('honours another delimiter', () => {
    expect(fieldsOf(parseCsv('a;b', ';'))).toEqual([['a', 'b']]);
  });
});

describe('importDictionaryCsv', () => {
  const d = { any: ['OpenAI', 'Acme, Inc'], el: ['Νόηση'], de: [] };

  it('export then import changes nothing', () => {
    const result = ok(serializeDictionary(d), d);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.dictionary).toBe(d);
  });

  it('export into an empty dictionary restores it', () => {
    expect(ok(serializeDictionary(d), {}).dictionary)
      .toEqual({ any: ['OpenAI', 'Acme, Inc'], el: ['Νόηση'] });
  });

  it('round-trips commas, quotes and semicolons', () => {
    const tricky = ['a,b', 'c"d', 'e;f', 'g,"h;'];
    expect(ok(serializeDictionary({ any: tricky }), {}).dictionary).toEqual({ any: tricky });
  });

  it('imports a one-column file into any', () => {
    expect(ok('Palowise\r\n\r\n  Noesis  \n').dictionary).toEqual({ any: ['Palowise', 'Noesis'] });
  });

  it('a one-column line with a comma is refused', () => {
    expect(importDictionaryCsv('a\nb,c', {})).toEqual({
      ok: false,
      message: 'Line 2 has more than one column. Add a language,term header or quote terms that contain commas. Nothing was imported.',
    });
    expect(ok('"b,c"').dictionary).toEqual({ any: ['b,c'] });
  });

  it('merges into existing groups, skipping terms in any group', () => {
    const result = ok('language,term\nel,new\nen,OLD\n', { any: ['old'], el: ['a'] });
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.dictionary).toEqual({ any: ['old'], el: ['a', 'new'] });
  });

  it('a repeat inside the file is skipped', () => {
    const result = ok('language,term\nen,x\nel,X\n');
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.dictionary).toEqual({ en: ['x'] });
  });

  it('header and codes are case-insensitive and trimmed', () => {
    expect(ok('Language , TERM\n EN ,x\n').dictionary).toEqual({ en: ['x'] });
  });

  it('refuses an unknown code with its line, importing nothing', () => {
    expect(importDictionaryCsv('language,term\nen,a\n\nxx,b\n', {})).toEqual({
      ok: false, message: 'Line 4: unknown language "xx". Nothing was imported.',
    });
  });

  it('quotes at most 32 characters of an unknown code', () => {
    const code = '\u{1F600}'.repeat(40);
    expect(importDictionaryCsv(`language,term\n${code},a\n`, {}).message)
      .toBe(`Line 2: unknown language "${'\u{1F600}'.repeat(32)}". Nothing was imported.`);
  });

  it('refuses __proto__ and constructor as languages', () => {
    for (const code of ['__proto__', 'constructor']) {
      const result = importDictionaryCsv(`language,term\n${code},x\n`, {});
      expect(result.ok).toBe(false);
      expect(result.message).toBe(`Line 2: unknown language "${code}". Nothing was imported.`);
    }
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
  });

  it('an unknown code is refused even with a blank term', () => {
    expect(importDictionaryCsv('language,term\nxx,\n', {}).message)
      .toBe('Line 2: unknown language "xx". Nothing was imported.');
    expect(importDictionaryCsv('language,term\nen,\n', {})).toEqual(NO_TERMS);
  });

  it('ignores trailing empty columns', () => {
    expect(ok('language,term,,\nen,a,,\n').dictionary).toEqual({ en: ['a'] });
    expect(ok('a,,\n').dictionary).toEqual({ any: ['a'] });
  });

  it('refuses a third column with content', () => {
    expect(importDictionaryCsv('language,term\nen,a,b\n', {}).message)
      .toBe('Line 2 has more than two columns. Quote terms that contain commas. Nothing was imported.');
  });

  it('accepts a semicolon file only through its header', () => {
    expect(ok(`${BOM}language;term\r\nel;Νόηση\r\n`).dictionary).toEqual({ el: ['Νόηση'] });
    expect(ok('a;b\n').dictionary).toEqual({ any: ['a;b'] });
  });

  it('refuses a file that was not UTF-8', () => {
    for (const text of ['caf�\n', 'a\0b\n']) {
      expect(importDictionaryCsv(text, {})).toEqual({ ok: false, message: NOT_UTF8 });
    }
  });

  it('reports a quote error with its line', () => {
    expect(importDictionaryCsv('language,term\nen,"a\n', {}).message)
      .toBe('Line 2: a quote is never closed. Nothing was imported.');
  });

  it('refuses a new term over 64 characters', () => {
    expect(importDictionaryCsv('a'.repeat(65), {}).message)
      .toBe('Line 1: the term is over 64 characters. Nothing was imported.');
    expect(ok('a'.repeat(64)).dictionary).toEqual({ any: ['a'.repeat(64)] });
  });

  it('measures term length in code points', () => {
    const term = '\u{1F600}'.repeat(64);
    expect(ok(term).dictionary).toEqual({ any: [term] });
  });

  it('a stored term over 64 characters round-trips', () => {
    const stored = { any: ['a'.repeat(70)] };
    const result = ok(serializeDictionary(stored), stored);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('a line break inside a quoted term becomes a space', () => {
    expect(ok('"a\r\nb"').dictionary).toEqual({ any: ['a b'] });
  });

  it('checks every column and language before any term length', () => {
    const text = `language,term\nen,${'a'.repeat(65)}\nxx,b\n`;
    expect(importDictionaryCsv(text, {}).message)
      .toBe('Line 3: unknown language "xx". Nothing was imported.');
  });

  it('the cap holds exactly at 100', () => {
    const stored = { en: terms(90, 'stored') };
    const fits = ok(terms(10, 'new').join('\n'), stored);
    expect(fits.added).toBe(10);
    expect(importDictionaryCsv(terms(15, 'new').join('\n'), stored)).toEqual({
      ok: false, message: 'This import would go over the 100 term limit by 5. Nothing was imported.',
    });
    const withRepeats = ok([...terms(10, 'new'), ...terms(5, 'STORED')].join('\n'), stored);
    expect(withRepeats.added).toBe(10);
    expect(withRepeats.skipped).toBe(5);
  });

  // A copy of the group per added term took about 41 s on this file; one copy per group, under 0.2 s.
  it('a file of 100,000 distinct terms is refused quickly with the exact overage', () => {
    const text = terms(100_000, 't').join('\n');
    expect(text.length).toBeLessThan(MAX_IMPORT_BYTES);
    const started = performance.now();
    const result = importDictionaryCsv(text, {});
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result).toEqual({
      ok: false, message: 'This import would go over the 100 term limit by 99900. Nothing was imported.',
    });
  }, 120_000);

  it('a file with no terms says so', () => {
    for (const text of ['', BOM, 'language,term\r\n']) {
      expect(importDictionaryCsv(text, {})).toEqual(NO_TERMS);
    }
  });

  it('never mutates the dictionary', () => {
    const frozen = Object.freeze({ any: Object.freeze(['a']), el: Object.freeze(['b']) });
    const result = ok('language,term\nany,c\nel,d\nen,e\n', frozen);
    expect(result.dictionary).toEqual({ any: ['a', 'c'], el: ['b', 'd'], en: ['e'] });
    expect(frozen).toEqual({ any: ['a'], el: ['b'] });
  });
});
