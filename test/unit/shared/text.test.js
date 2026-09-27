import { describe, it, expect } from 'vitest';
import { sanitizeHint, fillTemplate } from '../../../src/shared/text.js';

describe('sanitizeHint', () => {
  it('removes characters the transcription API rejects', () => {
    expect(sanitizeHint('Kostas <Karakostas>\r\nPalowise')).toBe('Kostas Karakostas Palowise');
  });
  it('collapses whitespace and trims', () => {
    expect(sanitizeHint('  a   b\t c ')).toBe('a b c');
  });
  it('truncates to maxLen', () => {
    expect(sanitizeHint('abcdefgh', 4)).toBe('abcd');
  });
  it('tolerates null and numbers', () => {
    expect(sanitizeHint(null)).toBe('');
    expect(sanitizeHint(42)).toBe('42');
  });
  it('trims a space left at the end of the cut', () => {
    expect(sanitizeHint('ab cd', 3)).toBe('ab');
  });
  it('treats a negative maxLen as 0', () => {
    expect(sanitizeHint('abc', -1)).toBe('');
  });
  it('cuts by code point, never inside a surrogate pair', () => {
    expect(sanitizeHint('a😀b', 2)).toBe('a😀');
  });
});

describe('fillTemplate', () => {
  it('replaces known variables and blanks unknown ones', () => {
    expect(fillTemplate('to {{targetLanguage}} and {{ other }} end', { targetLanguage: 'Greek' })).toBe('to Greek and  end');
  });
  it('returns the template untouched when it has no variables', () => {
    expect(fillTemplate('plain', {})).toBe('plain');
  });
  it('does not resolve inherited object properties', () => {
    expect(fillTemplate('{{constructor}}{{toString}}', {})).toBe('');
  });
  it('keeps falsy values that are not null or undefined', () => {
    expect(fillTemplate('{{a}}|{{b}}|{{c}}', { a: 0, b: false, c: '' })).toBe('0|false|');
  });
  it('blanks every placeholder when vars is null', () => {
    expect(fillTemplate('x{{a}}y', null)).toBe('xy');
  });
  it('fills a known name written with inner spaces', () => {
    expect(fillTemplate('Into {{ targetLanguage }}.', { targetLanguage: 'Greek' })).toBe('Into Greek.');
  });
});
