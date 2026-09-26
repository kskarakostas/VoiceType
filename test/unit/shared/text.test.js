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
});
