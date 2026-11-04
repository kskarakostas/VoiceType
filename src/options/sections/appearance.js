// Settings, Appearance: the pill style, one card with a static preview per style. A choice saves
// through ctx.commit at once.

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createAppearanceSection(ctx) {
  const radios = [...ctx.document.querySelectorAll('input[name="pill-style"]')];

  function render() {
    const { pillStyle } = ctx.settings();
    for (const radio of radios) radio.checked = radio.value === pillStyle;
  }

  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (radio.checked) ctx.commit((s) => { s.pillStyle = radio.value; });
    });
  }

  return { render };
}
