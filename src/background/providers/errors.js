export class ProviderError extends Error {
  /**
   * @param {string} message user-facing text
   * @param {{ status?: number, code?: string }} [info]
   */
  constructor(message, { status, code = 'provider' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
  }
}

const KEY_PATTERN = /\b(sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{4,}|AQ\.[A-Za-z0-9_-]{4,})/g;

/** Strip anything that looks like an API key and cap the length. */
export function redact(text) {
  return String(text ?? '').replace(KEY_PATTERN, '[key]').slice(0, 160);
}

/**
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @param {string} apiMessage message from the provider body, may be empty
 */
export function friendlyHttpError(provider, status, apiMessage) {
  const label = provider === 'openai' ? 'OpenAI' : 'Gemini';
  if (status === 401 || status === 403) {
    return new ProviderError(`${label} rejected the API key. Check it in the extension settings.`, { status, code: 'auth' });
  }
  if (status === 429) {
    return new ProviderError(`${label} rate limit or quota reached. Try again shortly or check billing.`, { status, code: 'rate_limit' });
  }
  if (status === 400) {
    const detail = apiMessage ? `: ${redact(apiMessage)}` : '.';
    return new ProviderError(`${label} rejected the request${detail}`, { status, code: 'bad_request' });
  }
  if (status >= 500) {
    return new ProviderError(`${label} is having trouble (HTTP ${status}). Try again.`, { status, code: 'server' });
  }
  return new ProviderError(`${label} error (HTTP ${status}).`, { status, code: 'http' });
}
