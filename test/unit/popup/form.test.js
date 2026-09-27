// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SPOKEN_LANGUAGES, MAX_KEYWORDS, parseKeywords, formatKeywords, toggleLanguage, createInlineConfirm,
} from '../../../src/popup/form.js';

afterEach(() => { vi.useRealTimers(); });

describe('SPOKEN_LANGUAGES', () => {
  it('lists the seven spoken-language hints in order', () => {
    expect(SPOKEN_LANGUAGES.map((l) => l.code)).toEqual(['en', 'el', 'es', 'fr', 'de', 'it', 'pt']);
    expect(SPOKEN_LANGUAGES.map((l) => l.label)).toEqual(['English', 'Greek', 'Spanish', 'French', 'German', 'Italian', 'Portuguese']);
  });
  it('is frozen', () => {
    expect(Object.isFrozen(SPOKEN_LANGUAGES)).toBe(true);
    expect(Object.isFrozen(SPOKEN_LANGUAGES[0])).toBe(true);
  });
});

describe('parseKeywords', () => {
  it('keeps one trimmed term per line and drops empty lines', () => {
    expect(parseKeywords('  Palowise \n\n Kubernetes\r\n\t\nK. S. Karakostas  ')).toEqual(['Palowise', 'Kubernetes', 'K. S. Karakostas']);
  });
  it('drops case-insensitive duplicates and keeps the first spelling', () => {
    expect(parseKeywords('OpenAI\nopenai\nOPENAI\nGemini')).toEqual(['OpenAI', 'Gemini']);
  });
  it('keeps at most 100 terms', () => {
    const text = Array.from({ length: 130 }, (_, i) => `term${i}`).join('\n');
    const out = parseKeywords(text);
    expect(MAX_KEYWORDS).toBe(100);
    expect(out).toHaveLength(100);
    expect(out[99]).toBe('term99');
  });
  it('returns an empty list for blank or non-string input', () => {
    expect(parseKeywords('')).toEqual([]);
    expect(parseKeywords(' \n \n')).toEqual([]);
    expect(parseKeywords(undefined)).toEqual([]);
  });
});

describe('formatKeywords', () => {
  it('joins terms with newlines', () => {
    expect(formatKeywords(['a', 'b c'])).toBe('a\nb c');
    expect(formatKeywords([])).toBe('');
  });
  it('round-trips through parseKeywords', () => {
    const list = ['Palowise', 'Commetric'];
    expect(parseKeywords(formatKeywords(list))).toEqual(list);
  });
});

describe('toggleLanguage', () => {
  it('checking Auto returns an empty list', () => {
    expect(toggleLanguage(['en', 'el'], 'auto', true)).toEqual([]);
  });
  it('unchecking Auto leaves the list as it was', () => {
    expect(toggleLanguage([], 'auto', false)).toEqual([]);
    expect(toggleLanguage(['el'], 'auto', false)).toEqual(['el']);
  });
  it('adds a language in SPOKEN_LANGUAGES order', () => {
    expect(toggleLanguage(['de'], 'en', true)).toEqual(['en', 'de']);
    expect(toggleLanguage(['en', 'de'], 'el', true)).toEqual(['en', 'el', 'de']);
  });
  it('removes a language and never duplicates one', () => {
    expect(toggleLanguage(['en', 'el'], 'en', false)).toEqual(['el']);
    expect(toggleLanguage(['en'], 'en', true)).toEqual(['en']);
  });
  it('ignores unknown codes and does not mutate the input', () => {
    const list = ['en'];
    expect(toggleLanguage(list, 'xx', true)).toEqual(['en']);
    toggleLanguage(list, 'el', true);
    expect(list).toEqual(['en']);
  });
});

describe('createInlineConfirm', () => {
  function setup(options = {}) {
    vi.useFakeTimers();
    document.body.innerHTML = '<button type="button" id="b">Clear history</button>';
    const button = document.getElementById('b');
    const onConfirm = vi.fn();
    createInlineConfirm(button, { onConfirm, setTimeout, clearTimeout, ...options });
    return { button, onConfirm };
  }

  it('first click swaps the label to the prompt without confirming', () => {
    const { button, onConfirm } = setup();
    button.click();
    expect(button.textContent).toBe('Click again to confirm');
    expect(button.dataset.confirming).toBe('true');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a second click within the window confirms once and restores the label', () => {
    const { button, onConfirm } = setup({ prompt: 'Click again to clear usage history' });
    button.click();
    expect(button.textContent).toBe('Click again to clear usage history');
    vi.advanceTimersByTime(2999);
    button.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Clear history');
    expect(button.dataset.confirming).toBeUndefined();
  });

  it('a second click within 400 ms of arming does not confirm and the button stays armed', () => {
    const { button, onConfirm } = setup();
    button.click();
    vi.advanceTimersByTime(399);
    button.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Click again to confirm');
    expect(button.dataset.confirming).toBe('true');
    vi.advanceTimersByTime(1);
    button.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('a click with detail 2 does not confirm and the label reverts at the normal timeout', () => {
    const { button, onConfirm } = setup();
    button.click();
    vi.advanceTimersByTime(1000);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Click again to confirm');
    vi.advanceTimersByTime(2000);
    expect(button.textContent).toBe('Clear history');
    expect(button.dataset.confirming).toBeUndefined();
  });

  it('a click 400 ms after arming confirms', () => {
    const { button, onConfirm } = setup();
    button.click();
    vi.advanceTimersByTime(400);
    button.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Clear history');
  });

  it('an armed button prevents repeated Enter and Space keydowns and does not confirm', () => {
    const { button, onConfirm } = setup();
    button.click();
    vi.advanceTimersByTime(500);
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented, key).toBe(true);
    }
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.dataset.confirming).toBe('true');
  });

  it('a non-repeated Enter keydown is not prevented', () => {
    const { button } = setup();
    button.click();
    vi.advanceTimersByTime(500);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('the label reverts after the window and the next click starts over', () => {
    const { button, onConfirm } = setup({ ms: 1000 });
    button.click();
    vi.advanceTimersByTime(1000);
    expect(button.textContent).toBe('Clear history');
    button.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Click again to confirm');
  });
});
