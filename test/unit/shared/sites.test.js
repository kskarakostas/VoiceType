import { describe, it, expect } from 'vitest';
import { siteKey } from '../../../src/shared/sites.js';

describe('siteKey', () => {
  it.each([
    ['https://www.Example.com/path?q', 'example.com'],
    ['http://sub.example.com:8080/', 'sub.example.com'],
    ['Example.COM', 'example.com'],
    ['www.example.com', 'example.com'],
    ['  docs.google.com  ', 'docs.google.com'],
    ['www.www.example.com', 'www.example.com'],
    ['chrome://extensions', null],
    ['file:///tmp/a.html', null],
    ['about:blank', null],
    ['chrome-extension://abc/options.html', null],
    ['', null],
    ['   ', null],
    [null, null],
    [42, null],
    ['http://', null],
  ])('siteKey normalizes hosts per V8: %j -> %j', (input, expected) => {
    expect(siteKey(input)).toBe(expected);
  });
});
