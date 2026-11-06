// Settings, Appearance: the pill style, one card with a static preview per style, then Minimal's
// size (shown only while Minimal is the style) and the recording colour. A choice saves through
// ctx.commit at once.

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

/** The radio group name on the page, and the setting it saves. */
const CHOICES = Object.freeze([
  ['pill-style', 'pillStyle'],
  ['mini-size', 'miniSize'],
  ['rec-color', 'recColor'],
]);

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createAppearanceSection(ctx) {
  const choices = CHOICES.map(([name, field]) => ({
    field,
    radios: [...ctx.document.querySelectorAll(`input[name="${name}"]`)],
  }));
  const sizeGroup = ctx.$('mini-size-group');

  function render() {
    const settings = ctx.settings();
    for (const { field, radios } of choices) {
      for (const radio of radios) radio.checked = radio.value === settings[field];
    }
    sizeGroup.hidden = settings.pillStyle !== 'minimal';
  }

  for (const { field, radios } of choices) {
    for (const radio of radios) {
      radio.addEventListener('change', () => {
        if (radio.checked) ctx.commit((s) => { s[field] = radio.value; });
      });
    }
  }

  return { render };
}
