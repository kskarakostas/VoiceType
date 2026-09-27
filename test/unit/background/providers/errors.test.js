import { describe, it, expect } from 'vitest';
import { ProviderError, friendlyHttpError, redact, authError } from '../../../../src/background/providers/errors.js';

describe('redact', () => {
  it('replaces OpenAI and Gemini key patterns', () => {
    expect(redact('Incorrect API key provided: sk-proj-abcdef123456.')).toBe('Incorrect API key provided: [key].');
    expect(redact('bad AIzaSyD9x2KqL0mN3p and AQ.Ab8Rn2xyz')).toBe('bad [key] and [key]');
  });
  it('caps length', () => {
    expect(redact('x'.repeat(500)).length).toBe(160);
  });
  it('redacts a key glued to a word by an underscore', () => {
    expect(redact('token_sk-abcdef123456')).toBe('token_[key]');
  });
  it('redacts an AQ. key with inner dots but keeps the sentence period after it', () => {
    expect(redact('AQ.Ab8Rn2.xyz98765')).toBe('[key]');
    expect(redact('Key AQ.Ab8Rn2.xyz98765.')).toBe('Key [key].');
  });
  it('leaves key-like text inside a longer word alone', () => {
    expect(redact('task-abcdef and mask-12345')).toBe('task-abcdef and mask-12345');
  });
});

describe('authError', () => {
  it('builds the standard auth error for either provider', () => {
    const e = authError('gemini', 400);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: 'Gemini rejected the API key. Check it in the extension settings.' });
    expect(authError('openai', 401)).toMatchObject({ code: 'auth', status: 401, message: 'OpenAI rejected the API key. Check it in the extension settings.' });
  });
});

describe('friendlyHttpError', () => {
  it('401 redacts key', () => {
    const e = friendlyHttpError('openai', 401, 'Incorrect API key provided: sk-proj-abcdef123456');
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe('auth');
    expect(e.message).toContain('OpenAI rejected the API key');
    expect(e.message).not.toContain('sk-proj');
  });
  it('OpenAI 403 is a permissions or region denial, not a bad key', () => {
    const e = friendlyHttpError('openai', 403, 'unsupported_country_region_territory');
    expect(e.code).toBe('forbidden');
    expect(e.status).toBe(403);
    expect(e.message).toBe("OpenAI denied access (HTTP 403). Check the key's permissions or your region.");
    expect(friendlyHttpError('openai', 401, '').code).toBe('auth');
  });
  it('Gemini 403 stays an auth error', () => {
    const e = friendlyHttpError('gemini', 403, '');
    expect(e.code).toBe('auth');
    expect(e.message).toBe('Gemini rejected the API key. Check it in the extension settings.');
  });
  it('maps rate limits, bad requests and server errors', () => {
    expect(friendlyHttpError('gemini', 429, '').message).toContain('Gemini rate limit or quota');
    expect(friendlyHttpError('gemini', 400, 'Unsupported MIME type').message).toBe('Gemini rejected the request: Unsupported MIME type');
    expect(friendlyHttpError('openai', 503, '').message).toContain('HTTP 503');
    expect(friendlyHttpError('openai', 418, '').message).toBe('OpenAI error (HTTP 418).');
  });
});
