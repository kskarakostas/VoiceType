import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, joinParts, normalizeSttUsage, toBcp47 } from '../../../../src/background/providers/gemini.js';

const AUDIO = btoa('fake-webm-bytes');
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transcribe', () => {
  it('posts inline audio with SMART mode, header auth and no key in the URL', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'Καλημέρα ' }, { text: 'κόσμε' }] } }],
      usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 6, totalTokenCount: 206, promptTokensDetails: [{ modality: 'AUDIO', tokenCount: 192 }, { modality: 'TEXT', tokenCount: 8 }] },
    }));
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'AQ.secret', languages: ['el'], keywords: ['Palowise', 'x<y>'] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
    expect(url).not.toContain('key=');
    expect(init.headers['x-goog-api-key']).toBe('AQ.secret');
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'audio/webm', data: AUDIO } });
    expect(body.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'SMART', languageCodes: ['el-GR'], customVocabulary: ['Palowise', 'x y'] });

    expect(result.text).toBe('Καλημέρα κόσμε');
    expect(result.usage).toEqual({ kind: 'tokens', audioTokens: 192, textTokens: 8, outputTokens: 6 });
    expect(result.languages).toEqual([]);
  });

  it('omits empty hint fields', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await transcribe({ audioBase64: AUDIO, key: 'k' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.audioTranscriptionConfig).toEqual({ mode: 'SMART' });
  });

  it('maps 403 to a friendly auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 403));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.bad' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth' });
  });

  it('maps a 400 invalid-key body to an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.bad' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', message: 'Gemini rejected the API key. Check it in the extension settings.' });
  });
});

describe('refine', () => {
  it('sends a system instruction with low thinking and joins non-thought parts', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: 'Dear team,' }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
    }));
    const result = await refine({ key: 'k', instructions: 'Write an email.', text: 'hi team' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(JSON.parse(init.body)).toEqual({
      system_instruction: { parts: [{ text: 'Write an email.' }] },
      contents: [{ parts: [{ text: 'hi team' }] }],
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
    });
    expect(result).toEqual({ text: 'Dear team,', usage: { inputTokens: 100, outputTokens: 25 } });
  });
});

describe('validateKey', () => {
  it('lists models with header auth', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    await expect(validateKey({ key: 'AQ.ok' })).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
    expect(init.headers['x-goog-api-key']).toBe('AQ.ok');
  });
});

describe('helpers', () => {
  it('joinParts tolerates missing candidates', () => {
    expect(joinParts({})).toBe('');
  });
  it('normalizeSttUsage handles missing details', () => {
    expect(normalizeSttUsage(undefined)).toBeNull();
    // No prompt count at all: null, so pricing falls back to the recording length.
    expect(normalizeSttUsage({ candidatesTokenCount: 3 })).toBeNull();
  });
  it('normalizeSttUsage derives audio tokens from the prompt count when details lack AUDIO', () => {
    expect(normalizeSttUsage({ promptTokenCount: 200, candidatesTokenCount: 3 })).toEqual({ kind: 'tokens', audioTokens: 200, textTokens: 0, outputTokens: 3 });
    expect(normalizeSttUsage({ promptTokenCount: 200, candidatesTokenCount: 3, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 8 }] }))
      .toEqual({ kind: 'tokens', audioTokens: 192, textTokens: 8, outputTokens: 3 });
  });
  it('normalizeSttUsage tolerates malformed details', () => {
    expect(normalizeSttUsage({ promptTokensDetails: 'oops' })).toBeNull();
    expect(normalizeSttUsage({ promptTokensDetails: [null, { modality: 'AUDIO', tokenCount: 5 }] })).toEqual({ kind: 'tokens', audioTokens: 5, textTokens: 0, outputTokens: 0 });
  });
  it('toBcp47 maps known codes and passes others through', () => {
    expect(toBcp47('el')).toBe('el-GR');
    expect(toBcp47('en')).toBe('en-US');
    expect(toBcp47('ja')).toBe('ja');
    expect(toBcp47('pt-BR')).toBe('pt-BR');
  });
});
