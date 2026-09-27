import { describe, it, expect } from 'vitest';
import { estimateSttCost, estimateTextCost, formatCost } from '../../../src/shared/pricing.js';

describe('estimateSttCost', () => {
  it('prices OpenAI by reported duration', () => {
    expect(estimateSttCost('gpt-transcribe', { kind: 'duration', seconds: 30 }, 99)).toBeCloseTo(0.00225, 6);
  });
  it('falls back to measured seconds when OpenAI reports tokens', () => {
    const usage = { kind: 'tokens', audioTokens: 500, textTokens: 0, outputTokens: 40 };
    expect(estimateSttCost('gpt-transcribe', usage, 60)).toBeCloseTo(0.0045, 6);
  });
  it('falls back to measured seconds when usage is missing', () => {
    expect(estimateSttCost('gpt-transcribe', null, 120)).toBeCloseTo(0.009, 6);
  });
  it('prices Gemini by audio and output tokens', () => {
    const usage = { kind: 'tokens', audioTokens: 1920, textTokens: 0, outputTokens: 100 };
    const expected = (1920 / 1e6) * 2.0 + (100 / 1e6) * 12.0;
    expect(estimateSttCost('gemini-3.5-transcribe', usage, 0)).toBeCloseTo(expected, 9);
  });
  it('estimates Gemini from seconds at 32 tokens per second when usage is missing', () => {
    expect(estimateSttCost('gemini-3.5-transcribe', null, 60)).toBeCloseTo((1920 / 1e6) * 2.0, 9);
  });
  it('returns 0 for unknown models', () => {
    expect(estimateSttCost('nope', null, 60)).toBe(0);
  });
  it('prices inherited property names at 0 instead of throwing', () => {
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(estimateSttCost(id, null, 1), id).toBe(0);
    }
  });
});

describe('estimateTextCost', () => {
  it('prices input and output tokens', () => {
    expect(estimateTextCost('gpt-6-luna', { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.0001 + 0.0001, 9);
    expect(estimateTextCost('gemini-3.8-flash', { inputTokens: 1e6, outputTokens: 0 })).toBeCloseTo(0.75, 9);
  });
  it('prices Gemini 3.8 Flash output tokens', () => {
    expect(estimateTextCost('gemini-3.8-flash', { inputTokens: 0, outputTokens: 1e6 })).toBeCloseTo(3.75, 9);
  });
  it('returns 0 without usage', () => {
    expect(estimateTextCost('gpt-6-luna', null)).toBe(0);
  });
  it('prices unknown and inherited model ids at 0 instead of throwing', () => {
    for (const id of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(estimateTextCost(id, { inputTokens: 1, outputTokens: 1 }), id).toBe(0);
    }
  });
});

describe('formatCost', () => {
  it('formats zero, sub-cent and normal amounts', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(0.1234)).toBe('$0.12');
  });
  it('shows exactly one cent as $0.01', () => {
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.0099)).toBe('<$0.01');
  });
});
