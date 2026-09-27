import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, joinParts, normalizeSttUsage, toBcp47 } from '../../../../src/background/providers/gemini.js';

const AUDIO = btoa('fake-webm-bytes');
const AUTH_MESSAGE = 'Gemini rejected the API key. Check it in the extension settings.';
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
    const controller = new AbortController();
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'AQ.secret', languages: ['el'], keywords: ['Palowise', 'x<y>'], signal: controller.signal });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent');
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers['x-goog-api-key']).toBe('AQ.secret');
    expect(init.signal).toBe(controller.signal);
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

  it('caps each vocabulary term at 64 characters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }));
    await transcribe({ audioBase64: AUDIO, key: 'k', keywords: ['x'.repeat(70)] });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.audioTranscriptionConfig.customVocabulary).toEqual(['x'.repeat(64)]);
  });

  it('maps a 403 to a friendly auth error without echoing the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: {
        code: 403,
        message: "Permission denied: Consumer 'api_key:AIzaSyD9x2KqL0mN3pQ7rS8t' has been suspended.",
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CONSUMER_SUSPENDED', domain: 'googleapis.com' }],
      },
    }, 403));
    const err = await transcribe({ audioBase64: AUDIO, key: 'AIzaSyD9x2KqL0mN3pQ7rS8t' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', code: 'auth', status: 403, message: AUTH_MESSAGE });
  });

  it('maps a 400 invalid-key body to an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.bad' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', message: AUTH_MESSAGE });
  });

  it('maps a 400 expired-key message to an auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 400, message: 'API key expired. Please renew the API key.', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.old' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: AUTH_MESSAGE });
  });

  it('keeps an ordinary 400 a bad request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { code: 400, message: 'Unsupported MIME type: audio/xyz', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(transcribe({ audioBase64: AUDIO, key: 'AQ.ok' })).rejects.toMatchObject({ code: 'bad_request', message: 'Gemini rejected the request: Unsupported MIME type: audio/xyz' });
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

  it('posts with the key header only and passes the abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const controller = new AbortController();
    await refine({ key: 'AQ.secret', instructions: 'x', text: 'y', signal: controller.signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('key=');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'x-goog-api-key': 'AQ.secret', 'Content-Type': 'application/json' });
    expect(init.signal).toBe(controller.signal);
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

  it('sends a GET with the abort signal and no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [] }));
    const controller = new AbortController();
    await validateKey({ key: 'AQ.ok', signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.signal).toBe(controller.signal);
  });

  it('maps a 400 whose only invalid-key signal is the reason to an auth error', async () => {
    for (const reason of ['API_KEY_INVALID', 'API_KEY_EXPIRED']) {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        error: {
          code: 400,
          message: 'Request contains an invalid argument.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com' }],
        },
      }, 400));
      await expect(validateKey({ key: 'AQ.bad' }), reason).rejects.toMatchObject({ name: 'ProviderError', code: 'auth', status: 400, message: AUTH_MESSAGE });
    }
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
