import { describe, it, expect } from 'vitest';
import { sameList } from '../../../src/ui/lists.js';

describe('sameList', () => {
  it('is true for the same items in the same order', () => {
    expect(sameList([1], [1])).toBe(true);
    expect(sameList([], [])).toBe(true);
  });
  it('is false when the order differs', () => {
    expect(sameList([1, 2], [2, 1])).toBe(false);
  });
  it('is false when the length differs', () => {
    expect(sameList([1], [1, 2])).toBe(false);
    expect(sameList([1, 2], [1])).toBe(false);
  });
  it('compares items by identity', () => {
    const item = {};
    expect(sameList([item], [item])).toBe(true);
    expect(sameList([item], [{}])).toBe(false);
  });
});
