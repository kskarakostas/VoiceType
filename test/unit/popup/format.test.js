import { describe, it, expect } from 'vitest';
import { formatSpoken } from '../../../src/popup/format.js';

describe('formatSpoken', () => {
  it.each([
    [0, '0:00'],
    [59, '0:59'],
    [59.9, '0:59'],
    [200, '3:20'],
    [3600, '1:00:00'],
    [3725.4, '1:02:05'],
    [36000, '10:00:00'],
    [NaN, '0:00'],
    [Infinity, '0:00'],
    [-5, '0:00'],
  ])('formatSpoken(%s)', (seconds, text) => {
    expect(formatSpoken(seconds)).toBe(text);
  });
});
