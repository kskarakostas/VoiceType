import { describe, it, expect } from 'vitest';
import { siteKey, ruleFor, withSiteRule, pageSite } from '../../../src/shared/sites.js';
import { SITE_KEYS } from '../../fixtures/site-keys.js';

describe('siteKey', () => {
  it.each(SITE_KEYS)('siteKey(%j) is %j', (input, expected) => {
    expect(siteKey(input)).toBe(expected);
  });

  it.each([
    'https://www.Example.com/path?q', 'http://sub.example.com:8080/', 'Example.COM', 'www.example.com',
    '  docs.google.com  ', 'www.www.example.com', 'https://WWW.Example.COM./x', 'example.com.',
    'example.com:8080/a', 'localhost:3000', 'example.com/login?next=https://x.com',
    'https://user:pw@example.com/', 'http://ελληνικά.gr/', 'ελληνικά.gr', 'http://[::1]:8080/', '__proto__',
    'www.www.a.com', 'a.com..', 'www.www.a.com..', 'www.www.www.a.com...', 'www', 'www.www', 'tel:123',
    'javascript:1', '1.2.3.4', '1.2.3.4.', 'http://0x7f.1/',
  ])('siteKey is idempotent: %j', (input) => {
    const key = siteKey(input);
    expect(key).not.toBeNull();
    expect(siteKey(key)).toBe(key);
  });
});

describe('ruleFor', () => {
  const EMPTY = { hidePill: false, mode: null };
  const modes = { default: {}, email: {} };
  const settings = { modes, siteRules: { 'a.com': { hidePill: true, mode: 'email' } } };

  it.each([
    ['no rule', settings, 'https://b.com/'],
    ['an undefined URL', settings, undefined],
    ['about:blank', settings, 'about:blank'],
    ['a file URL', settings, 'file:///x'],
    ['settings without siteRules', { modes }, 'https://a.com/'],
  ])('ruleFor returns the empty rule for %s', (_name, input, url) => {
    expect(ruleFor(input, url)).toEqual(EMPTY);
  });

  it('ruleFor resolves the host of a page URL', () => {
    expect(ruleFor(settings, 'https://www.a.com/x')).toEqual({ hidePill: true, mode: 'email' });
    expect(ruleFor(settings, 'https://sub.a.com/')).toEqual(EMPTY);
  });

  it('a missing mode reads as null', () => {
    const stale = { modes, siteRules: { 'a.com': { hidePill: true, mode: 'gone' } } };
    expect(ruleFor(stale, 'https://a.com/')).toEqual({ hidePill: true, mode: null });
  });

  it('a mode named after an inherited property reads as null', () => {
    const stale = { modes, siteRules: { 'a.com': { hidePill: true, mode: 'constructor' } } };
    expect(ruleFor(stale, 'https://a.com/')).toEqual({ hidePill: true, mode: null });
  });

  it.each(['https://constructor/', 'https://__proto__/'])('ruleFor ignores inherited names: %s', (url) => {
    expect(ruleFor({ modes, siteRules: {} }, url)).toEqual(EMPTY);
  });
});

describe('withSiteRule', () => {
  const HIDE = { hidePill: true, mode: null };
  const MAIL = { hidePill: false, mode: 'email' };

  it('withSiteRule sets, replaces and deletes without mutating', () => {
    const rules = Object.freeze({ 'a.com': HIDE });
    expect(withSiteRule(rules, 'b.com', MAIL)).toEqual({ 'a.com': HIDE, 'b.com': MAIL });
    expect(withSiteRule(rules, 'a.com', MAIL)).toEqual({ 'a.com': MAIL });
    const two = Object.freeze({ 'a.com': HIDE, 'b.com': MAIL });
    expect(withSiteRule(two, 'a.com', { hidePill: false, mode: null })).toEqual({ 'b.com': MAIL });
    expect(rules).toEqual({ 'a.com': HIDE });
  });

  it('deleting the last rule gives an empty object', () => {
    expect(withSiteRule({ 'a.com': HIDE }, 'a.com', { hidePill: false, mode: null })).toEqual({});
  });

  it('a __proto__ host stays an own key and leaves Object.prototype alone', () => {
    const out = withSiteRule({}, '__proto__', HIDE);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect({}.hidePill).toBeUndefined();
  });
});

describe('pageSite', () => {
  it.each([
    ['https://a.com/', 'a.com'],
    ['a.com', null],
    ['chrome://x', null],
    ['file:///x', null],
    [undefined, null],
    ['https://chromewebstore.google.com/detail/x', null],
    ['https://chrome.google.com/webstore/detail/x', null],
    ['https://chrome.google.com/webstore', null],
    ['https://chrome.google.com/webstorefront', 'chrome.google.com'],
    ['https://chrome.google.com/other', 'chrome.google.com'],
  ])('pageSite: %j -> %j', (url, expected) => {
    expect(pageSite(url)).toBe(expected);
  });
});
