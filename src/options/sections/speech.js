// Settings, Speech: spoken languages. Ported from the 2.2 popup unchanged in behaviour; changes
// save through ctx.commit.
import { SPOKEN_LANGUAGES } from '../../shared/dictionary.js';
import { toggleLanguage } from '../../ui/form.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createSpeechSection(ctx) {
  const { $, document } = ctx;
  const el = { languages: $('languages') };

  function render() {
    const settings = ctx.settings();
    const chosen = new Set(settings.languages);
    for (const box of el.languages.querySelectorAll('input[type="checkbox"]')) {
      box.checked = box.value === 'auto' ? settings.languages.length === 0 : chosen.has(box.value);
    }
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

  return { render };
}
