// Settings, Sound and clipboard: the two opt-in switches for cues and always-copy. Changes save
// through ctx.commit.

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createSoundSection(ctx) {
  const { $ } = ctx;
  const el = { sounds: $('sounds'), alwaysCopy: $('always-copy') };

  function render() {
    const settings = ctx.settings();
    el.sounds.checked = settings.sounds;
    el.alwaysCopy.checked = settings.alwaysCopy;
  }

  el.sounds.addEventListener('change', () => ctx.commit((s) => { s.sounds = el.sounds.checked; }));
  el.alwaysCopy.addEventListener('change', () => ctx.commit((s) => { s.alwaysCopy = el.alwaysCopy.checked; }));

  return { render };
}
