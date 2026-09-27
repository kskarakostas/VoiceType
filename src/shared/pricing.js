import { MODELS, GEMINI_AUDIO_TOKENS_PER_SECOND } from './models.js';

/**
 * @typedef {{ kind: 'duration', seconds: number }
 *         | { kind: 'tokens', audioTokens: number, textTokens: number, outputTokens: number }} SttUsage
 * @typedef {{ inputTokens: number, outputTokens: number }} TextUsage
 */

/**
 * Unknown model ids, inherited names such as `constructor` included, price at 0.
 * @param {string} modelId
 * @param {SttUsage|null} usage
 * @param {number} fallbackSeconds client-measured recording length
 * @returns {number} USD
 */
export function estimateSttCost(modelId, usage, fallbackSeconds) {
  if (!Object.hasOwn(MODELS, modelId)) return 0;
  const p = MODELS[modelId].pricing;
  if ('perMinute' in p) {
    const seconds = usage?.kind === 'duration' ? usage.seconds : fallbackSeconds;
    return (seconds / 60) * p.perMinute;
  }
  if ('audioInputPerM' in p) {
    const audioTokens = usage?.kind === 'tokens' ? usage.audioTokens : fallbackSeconds * GEMINI_AUDIO_TOKENS_PER_SECOND;
    const outputTokens = usage?.kind === 'tokens' ? usage.outputTokens : 0;
    return (audioTokens / 1e6) * p.audioInputPerM + (outputTokens / 1e6) * p.outputPerM;
  }
  return 0;
}

/**
 * Unknown model ids, inherited names such as `constructor` included, price at 0.
 * @param {string} modelId
 * @param {TextUsage|null} usage
 * @returns {number} USD
 */
export function estimateTextCost(modelId, usage) {
  if (!usage || !Object.hasOwn(MODELS, modelId)) return 0;
  const p = MODELS[modelId].pricing;
  if (!('inputPerM' in p)) return 0;
  return (usage.inputTokens / 1e6) * p.inputPerM + (usage.outputTokens / 1e6) * p.outputPerM;
}

/** @param {number} cost */
export function formatCost(cost) {
  if (!cost) return '$0.00';
  if (cost < 0.01) return '<$0.01';
  return '$' + cost.toFixed(2);
}
