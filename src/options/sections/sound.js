// Settings, Sound and clipboard: the two opt-in switches for cues and always-copy, and the sound
// set with a Play button per set. Changes save through ctx.commit. Play uses the same cue player
// as the offscreen document, in this page, and plays with the sounds switch off too.
import { createCuePlayer, CUE_NAMES } from '../../offscreen/cues.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createSoundSection(ctx) {
  const { $ } = ctx;
  const el = { sounds: $('sounds'), alwaysCopy: $('always-copy') };
  const setRadios = [...ctx.document.querySelectorAll('input[name="sound-set"]')];
  const playButtons = [...ctx.document.querySelectorAll('[data-play]')];

  function render() {
    const settings = ctx.settings();
    el.sounds.checked = settings.sounds;
    el.alwaysCopy.checked = settings.alwaysCopy;
    for (const radio of setRadios) radio.checked = radio.value === settings.soundSet;
  }

  el.sounds.addEventListener('change', () => ctx.commit((s) => { s.sounds = el.sounds.checked; }));
  el.alwaysCopy.addEventListener('change', () => ctx.commit((s) => { s.alwaysCopy = el.alwaysCopy.checked; }));
  for (const radio of setRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) ctx.commit((s) => { s.soundSet = radio.value; });
    });
  }

  // Built at the first press: a page nobody plays on holds no audio.
  let player = null;
  let playing = false;

  /** @param {boolean} busy aria-disabled, not disabled: a pressed button keeps the keyboard focus. */
  function markBusy(busy) {
    for (const button of playButtons) {
      if (busy) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
  }

  /** One set at a time; a press while one plays does nothing. Never rejects. */
  async function playSet(set) {
    if (playing) return;
    playing = true;
    markBusy(true);
    try {
      player ??= createCuePlayer({ createContext: () => new AudioContext() });
      for (const name of CUE_NAMES) {
        const result = await player.play(name, set);
        // A cue that could not start means the rest cannot: each would wait out the resume timeout.
        if (result?.ok === false) break;
      }
    } catch {
      // No audio here: the button does nothing and the page keeps working.
    } finally {
      playing = false;
      markBusy(false);
    }
  }

  for (const button of playButtons) button.addEventListener('click', () => playSet(button.dataset.play));

  return { render };
}
