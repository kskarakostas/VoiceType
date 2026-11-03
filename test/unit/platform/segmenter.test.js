// Pins the platform behaviour spec V15 relies on: Intl.Segmenter with word granularity and an
// undefined locale counts Greek and English words through `isWordLike`. Runs on Node's ICU; the L1
// smoke checklist repeats the core cases in Chrome.
import { describe, it, expect } from 'vitest';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const words = (text) => [...segmenter.segment(text)].filter((s) => s.isWordLike).map((s) => s.segment);

describe('Intl.Segmenter word granularity (V15)', () => {
  it('counts English words, keeping contractions whole and skipping punctuation', () => {
    expect(words("Hello, world! It's a test.")).toEqual(['Hello', 'world', "It's", 'a', 'test']);
    expect(words('don’t won\'t')).toEqual(['don’t', "won't"]);
  });

  it('counts Greek words with accents and final sigma, skipping the Greek question mark', () => {
    expect(words('Καλημέρα, τι κάνεις; Είμαι καλά.')).toEqual(['Καλημέρα', 'τι', 'κάνεις', 'Είμαι', 'καλά']);
  });

  it('counts mixed Greek and Latin text, with a number as one word', () => {
    expect(words('Το API του OpenAI κοστίζει 0,006 $ ανά λεπτό.'))
      .toEqual(['Το', 'API', 'του', 'OpenAI', 'κοστίζει', '0,006', 'ανά', 'λεπτό']);
  });

  it('splits across newlines', () => {
    expect(words('Γεια σου κόσμε\nνέα γραμμή')).toHaveLength(5);
  });

  it('counts nothing in empty, blank or punctuation-only text', () => {
    expect(words('')).toEqual([]);
    expect(words('   \n\t')).toEqual([]);
    expect(words('...!!! ;')).toEqual([]);
  });

  it('splits hyphenated words and the Greek ό,τι in two (accepted edge cases)', () => {
    expect(words('e-mail co-op')).toEqual(['e', 'mail', 'co', 'op']);
    expect(words('ό,τι')).toEqual(['ό', 'τι']);
  });
});
