import { describe, it, expect } from 'vitest';
import { ProviderError, friendlyHttpError, redact } from '../../../../src/background/providers/errors.js';

describe('redact', () => {
  it('replaces OpenAI and Gemini key patterns', () => {
    expect(redact('Incorrect API key provided: sk-proj-abcdef123456.')).toBe('Incorrect API key provided: [key].');
    expect(redact('bad AIzaSyD9x2KqL0mN3p and AQ.Ab8Rn2xyz')).toBe('bad [key] and [key]');
  });
  it('caps length', () => {
    expect(redact('x'.repeat(500)).length).toBe(160);
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
  it('maps rate limits, bad requests and server errors', () => {
    expect(friendlyHttpError('gemini', 429, '').message).toContain('Gemini rate limit or quota');
    expect(friendlyHttpError('gemini', 400, 'Unsupported MIME type').message).toBe('Gemini rejected the request: Unsupported MIME type');
    expect(friendlyHttpError('openai', 503, '').message).toContain('HTTP 503');
    expect(friendlyHttpError('openai', 418, '').message).toBe('OpenAI error (HTTP 418).');
  });
});
