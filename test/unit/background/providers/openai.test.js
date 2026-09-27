import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { transcribe, refine, validateKey, extractOutputText, normalizeSttUsage } from '../../../../src/background/providers/openai.js';

const AUDIO = btoa('fake-webm-bytes');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let fetchMock;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('transcribe', () => {
  it('posts multipart with model, hints and bearer auth', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: ' hello world ', usage: { type: 'duration', seconds: 12 }, languages: [{ code: 'en' }] }));
    const result = await transcribe({ audioBase64: AUDIO, mimeType: 'audio/webm', key: 'sk-test', languages: ['el', 'en'], keywords: ['Palowise', 'bad<kw>'], prompt: 'Topic:\nAI' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    const form = init.body;
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(form.getAll('languages[]')).toEqual(['el', 'en']);
    expect(form.getAll('keywords[]')).toEqual(['Palowise', 'bad kw']);
    expect(form.get('prompt')).toBe('Topic: AI');
    expect(form.get('file').type).toBe('audio/webm');

    expect(result).toEqual({ text: 'hello world', usage: { kind: 'duration', seconds: 12 }, languages: ['en'] });
  });

  it('omits prompt when empty and handles token usage', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x', usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 59, input_token_details: { audio_tokens: 14, text_tokens: 0 } } }));
    const result = await transcribe({ audioBase64: AUDIO, key: 'sk-test' });
    expect(fetchMock.mock.calls[0][1].body.has('prompt')).toBe(false);
    expect(result.usage).toEqual({ kind: 'tokens', audioTokens: 14, textTokens: 0, outputTokens: 45 });
    expect(result.languages).toEqual([]);
  });

  it('401 redacts key', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'Incorrect API key provided: sk-test-abcdef' } }, 401));
    await expect(transcribe({ audioBase64: AUDIO, key: 'sk-test-abcdef' })).rejects.toMatchObject({ name: 'ProviderError', code: 'auth' });
    await expect(transcribe({ audioBase64: AUDIO, key: 'sk-test-abcdef' })).rejects.not.toThrow(/sk-test/);
  });

  it('400 redacts a key echoed in the provider message', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: { message: 'Bad request for key sk-live-abcdef123456: invalid file' } }, 400));
    const err = await transcribe({ audioBase64: AUDIO, key: 'sk-live-abcdef123456' }).catch((e) => e);
    expect(err).toMatchObject({ name: 'ProviderError', code: 'bad_request' });
    expect(err.message).toContain('[key]');
    expect(err.message).not.toContain('sk-live');
  });

  it('skips malformed language entries', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x', languages: [null, { code: 'en' }] }));
    const result = await transcribe({ audioBase64: AUDIO, key: 'sk-test' });
    expect(result.languages).toEqual(['en']);
  });

  it('passes the abort signal through', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    const controller = new AbortController();
    await transcribe({ audioBase64: AUDIO, key: 'k', signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('caps each keyword at 64 characters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: 'x' }));
    await transcribe({ audioBase64: AUDIO, key: 'k', keywords: ['k'.repeat(70)] });
    expect(fetchMock.mock.calls[0][1].body.getAll('keywords[]')).toEqual(['k'.repeat(64)]);
  });
});

describe('refine', () => {
  it('calls the Responses API and walks the output', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'Dear team,' }, { type: 'output_text', text: ' hello.' }] },
      ],
      usage: { input_tokens: 120, output_tokens: 30 },
    }));
    const result = await refine({ key: 'sk-test', instructions: 'Write an email.', text: 'hi team hello' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ model: 'gpt-6-luna', instructions: 'Write an email.', input: 'hi team hello', reasoning: { effort: 'none' } });
    expect(result).toEqual({ text: 'Dear team, hello.', usage: { inputTokens: 120, outputTokens: 30 } });
  });

  it('posts with bearer auth and passes the abort signal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ output: [] }));
    const controller = new AbortController();
    await refine({ key: 'sk-test', instructions: 'x', text: 'y', signal: controller.signal });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.signal).toBe(controller.signal);
  });
});

describe('validateKey', () => {
  it('resolves true on 200 and throws a friendly error on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    await expect(validateKey({ key: 'sk-ok' })).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/models');
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 401));
    await expect(validateKey({ key: 'sk-bad' })).rejects.toMatchObject({ code: 'auth' });
  });

  it('sends a GET with bearer auth, the abort signal and no body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const controller = new AbortController();
    await validateKey({ key: 'sk-ok', signal: controller.signal });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).not.toContain('sk-ok');
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer sk-ok');
    expect(init.signal).toBe(controller.signal);
  });
});

describe('helpers', () => {
  it('extractOutputText ignores non-message items', () => {
    expect(extractOutputText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'refusal', refusal: 'no' }, { type: 'output_text', text: 'ok' }] }] })).toBe('ok');
    expect(extractOutputText({})).toBe('');
  });
  it('normalizeSttUsage returns null for unknown shapes', () => {
    expect(normalizeSttUsage(undefined)).toBeNull();
    expect(normalizeSttUsage({ type: 'other' })).toBeNull();
  });
  it('normalizeSttUsage returns null instead of throwing on hostile input', () => {
    const hostile = { get type() { throw new Error('boom'); } };
    expect(normalizeSttUsage(hostile)).toBeNull();
  });
});
