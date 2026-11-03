// Site keys for per-site rules (V8).

/**
 * Normalize an `http:`/`https:` URL or a bare hostname to a site key: the hostname
 * lowercased with one leading `www.` dropped. Returns null for non-strings, blank input,
 * any other scheme, or input the URL parser rejects.
 * @param {unknown} input
 * @returns {string|null}
 */
export function siteKey(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  let url;
  try {
    url = new URL(text.includes('://') ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // URL already lowercases the hostname of http(s) URLs.
  return url.hostname.replace(/^www\./, '') || null;
}
