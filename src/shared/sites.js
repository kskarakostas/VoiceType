// Site keys and per-site rules (V8).

/** @typedef {{ hidePill: boolean, mode: string|null }} SiteRule */

/**
 * Normalize an `http:`/`https:` URL or a bare hostname to a site key: the hostname
 * lowercased, every leading `www.` and trailing dot dropped, so a key maps to itself. A
 * scheme counts only at the start of the input and needs `://`, so `tel:123` and
 * `javascript:1` read as host and port. Returns null for non-strings, blank input, any
 * other scheme, a bare host carrying `@`, or input the URL parser rejects.
 * @param {unknown} input
 * @returns {string|null}
 */
export function siteKey(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  if (!hasScheme && text.split(/[/?#]/)[0].includes('@')) return null;
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  // URL already lowercases the hostname of http(s) URLs.
  return url.hostname.replace(/^(?:www\.)+/, '').replace(/\.+$/, '') || null;
}

/**
 * The rule that applies to a page URL. Exact host match, no subdomain wildcard (V8).
 * The empty rule for an unusable URL, no rule, or a missing `siteRules`; a mode that no
 * longer exists reads null.
 * @param {{ siteRules?: Record<string, SiteRule>, modes: Record<string, unknown> }} settings
 * @param {unknown} url
 * @returns {SiteRule}
 */
export function ruleFor(settings, url) {
  const key = siteKey(url);
  const siteRules = settings.siteRules ?? {};
  if (key === null || !Object.hasOwn(siteRules, key)) return { hidePill: false, mode: null };
  const { hidePill, mode } = siteRules[key];
  return { hidePill, mode: Object.hasOwn(settings.modes, mode) ? mode : null };
}

/**
 * A copy of `siteRules` with `rule` set on `host`, or without `host` when the rule does
 * nothing. Never mutates.
 * @param {Record<string, SiteRule>} siteRules
 * @param {string} host
 * @param {SiteRule} rule
 * @returns {Record<string, SiteRule>}
 */
export function withSiteRule(siteRules, host, rule) {
  const entries = Object.entries(siteRules).filter(([key]) => key !== host);
  if (rule.hidePill || rule.mode !== null) entries.push([host, rule]);
  // fromEntries defines own properties, so a `__proto__` host never reaches the prototype.
  return Object.fromEntries(entries);
}

/**
 * The site key of a tab that can run the content script: an `http:` or `https:` URL
 * outside the Chrome Web Store. Null for anything else.
 * @param {unknown} url
 * @returns {string|null}
 */
export function pageSite(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  const site = siteKey(url);
  if (site === 'chromewebstore.google.com') return null;
  if (site === 'chrome.google.com' && /^\/webstore(\/|$)/.test(new URL(url).pathname)) return null;
  return site;
}
