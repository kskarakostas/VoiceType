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

// A key starts after any character that is not a letter or digit, so `token_sk-...` is caught
// where `\b` would miss it. AQ. keys may contain inner dots; a trailing sentence period is kept.
const KEY_PATTERN = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{4,}|AIza[A-Za-z0-9_-]{4,}|AQ\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)*)/g;

/** Strip anything that looks like an API key and cap the length. */
export function redact(text) {
  return String(text ?? '').replace(KEY_PATTERN, '[key]').slice(0, 160);
}

/** @param {'openai'|'gemini'} provider */
function providerLabel(provider) {
  return provider === 'openai' ? 'OpenAI' : 'Gemini';
}

/**
 * The standard error for a key the provider refused.
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @returns {ProviderError}
 */
export function authError(provider, status) {
  return new ProviderError(`${providerLabel(provider)} rejected the API key. Check it in the extension settings.`, { status, code: 'auth' });
}

/**
 * @param {'openai'|'gemini'} provider
 * @param {number} status
 * @param {string} apiMessage message from the provider body, may be empty
 */
export function friendlyHttpError(provider, status, apiMessage) {
  const label = providerLabel(provider);
  // OpenAI answers 403 for a valid key without access (project permissions, unsupported region).
  if (status === 403 && provider === 'openai') {
    return new ProviderError("OpenAI denied access (HTTP 403). Check the key's permissions or your region.", { status, code: 'forbidden' });
  }
  if (status === 401 || status === 403) return authError(provider, status);
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
