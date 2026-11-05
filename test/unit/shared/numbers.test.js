import { describe, it, expect } from 'vitest';
import { finite } from '../../../src/shared/numbers.js';

describe('finite', () => {
  it('keeps a finite number', () => {
    expect(finite(2)).toBe(2);
    expect(finite(-1.5)).toBe(-1.5);
  });
  it('reads NaN and the infinities as 0', () => {
    expect(finite(NaN)).toBe(0);
    expect(finite(Infinity)).toBe(0);
    expect(finite(-Infinity)).toBe(0);
  });
  it('reads anything that is not a number as 0, without coercing it', () => {
    expect(finite('2')).toBe(0);
    expect(finite(null)).toBe(0);
    expect(finite(undefined)).toBe(0);
  });
});
