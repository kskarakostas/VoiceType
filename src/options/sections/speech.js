// Settings, Speech: spoken languages and the vocabulary, which edits `dictionary.any`. Ported from
// the 2.2 popup unchanged in behaviour; changes save through ctx.commit.
import {
  DICTIONARY_ANY, SPOKEN_LANGUAGES, MAX_KEYWORDS, countTerms, flattenDictionary, setGroupTerms,
} from '../../shared/dictionary.js';
import { parseKeywords, formatKeywords, toggleLanguage } from '../../ui/form.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createSpeechSection(ctx) {
  const { $, document } = ctx;
  const el = { languages: $('languages'), keywords: $('keywords'), keywordCount: $('keyword-count') };
  const keywordSave = ctx.typingSave(saveKeywords);

  // The focused vocabulary field is never overwritten, so a save while typing keeps the caret.
  function render() {
    const settings = ctx.settings();
    const chosen = new Set(settings.languages);
    for (const box of el.languages.querySelectorAll('input[type="checkbox"]')) {
      box.checked = box.value === 'auto' ? settings.languages.length === 0 : chosen.has(box.value);
    }
    if (document.activeElement !== el.keywords) el.keywords.value = formatKeywords(settings.dictionary.any ?? []);
    el.keywordCount.textContent = `${countTerms(settings.dictionary)} of ${MAX_KEYWORDS} terms`;
  }

  for (const { code, label } of [{ code: 'auto', label: 'Auto' }, ...SPOKEN_LANGUAGES]) {
    const wrap = document.createElement('label');
    wrap.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `lang-${code}`;
    box.value = code;
    box.addEventListener('change', () => ctx.commit((s) => { s.languages = toggleLanguage(s.languages, code, box.checked); }));
    wrap.append(box, document.createTextNode(label));
    el.languages.append(wrap);
  }

  // shortcut: this textarea edits only the `any` group, until the L2 Dictionary page replaces it.
  async function saveKeywords() {
    keywordSave.cancel();
    const { dictionary } = ctx.settings();
    const others = setGroupTerms(dictionary, DICTIONARY_ANY, []);
    const exclude = new Set(flattenDictionary(others).map((term) => term.toLowerCase()));
    const next = parseKeywords(el.keywords.value, { limit: MAX_KEYWORDS - countTerms(others), exclude });
    if (sameList(next, dictionary.any ?? [])) {
      render();
      return;
    }
    await ctx.commit((s) => { s.dictionary = setGroupTerms(s.dictionary, DICTIONARY_ANY, next); });
  }

  el.keywords.addEventListener('input', () => keywordSave.schedule());
  el.keywords.addEventListener('change', saveKeywords);
  el.keywords.addEventListener('blur', saveKeywords);

  return { render, typingSaves: [keywordSave] };
}
