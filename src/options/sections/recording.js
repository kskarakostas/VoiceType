// Settings, Recording: length limits, silence auto-stop and the two hotkey recorders. Ported from
// the 2.2 popup; changes save through ctx.commit.
import { AUTO_STOP_CHOICES } from '../../shared/defaults.js';
import { formatChord, chordFromEvent, matchesChord } from '../../shared/chord.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const HOTKEY_IDLE_HINT = 'Tap to toggle, hold to talk.';
const EDIT_HOTKEY_IDLE_HINT = 'Select text in a field, press this and say how to change it. The selected text goes to your provider.';
const HOTKEY_ARMED_HINT = 'Press the new hotkey. Esc cancels.';
const HOTKEY_INVALID_HINT = 'Use Ctrl, Alt or Cmd with a key';
const SAME_AS_DICTATION_HINT = 'Same as the dictation hotkey.';
const SAME_AS_EDIT_HINT = 'Same as the edit hotkey.';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS']);

/**
 * One chord button. A press the other recorder holds is refused like an invalid one: nothing
 * saves and the button stays armed for another press (V41).
 * @param {PageContext} ctx
 * @param {{ button: HTMLElement, hint: HTMLElement, idleHint: string, field: 'hotkey'|'editHotkey',
 *   otherField: 'hotkey'|'editHotkey', sameHint: string, savedLabel: string }} recorder
 * @returns {{ render: () => void }}
 */
function createChordRecorder(ctx, { button, hint, idleHint, field, otherField, sameHint, savedLabel }) {
  const { mac } = ctx;
  let armed = false;

  function render() {
    button.textContent = armed ? 'Press keys' : formatChord(ctx.settings()[field], { mac });
    button.setAttribute('aria-pressed', String(armed));
  }

  function setHint(text, tone) {
    hint.textContent = text;
    if (tone) hint.dataset.tone = tone;
    else delete hint.dataset.tone;
  }

  function disarm() {
    armed = false;
    setHint(idleHint);
    render();
  }

  button.addEventListener('click', () => {
    if (armed) {
      disarm();
      return;
    }
    armed = true;
    setHint(HOTKEY_ARMED_HINT);
    render();
    button.focus();
  });
  button.addEventListener('blur', () => { if (armed) disarm(); });
  button.addEventListener('keydown', (event) => {
    if (!armed || event.key === 'Tab') return;
    // Also keeps Space or Enter from clicking the button.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      disarm();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const chord = chordFromEvent(event);
    if (!chord) {
      setHint(HOTKEY_INVALID_HINT, 'error');
      return;
    }
    if (matchesChord(event, ctx.settings()[otherField])) {
      setHint(sameHint, 'error');
      return;
    }
    // Disarm first: commit renders nothing when the chord is the one already saved.
    disarm();
    ctx.commit((s) => { s[field] = chord; }, `${savedLabel}: ${formatChord(chord, { mac })}`);
  });

  return { render };
}

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createRecordingSection(ctx) {
  const { $, document } = ctx;
  const el = { minTime: $('min-time'), maxTime: $('max-time'), autoStop: $('auto-stop') };
  const recorders = [
    createChordRecorder(ctx, {
      button: $('hotkey'), hint: $('hotkey-hint'), idleHint: HOTKEY_IDLE_HINT,
      field: 'hotkey', otherField: 'editHotkey', sameHint: SAME_AS_EDIT_HINT, savedLabel: 'Hotkey',
    }),
    createChordRecorder(ctx, {
      button: $('edit-hotkey'), hint: $('edit-hotkey-hint'), idleHint: EDIT_HOTKEY_IDLE_HINT,
      field: 'editHotkey', otherField: 'hotkey', sameHint: SAME_AS_DICTATION_HINT, savedLabel: 'Edit hotkey',
    }),
  ];

  function setSelect(select, value) {
    const wanted = String(value);
    if (![...select.options].some((o) => o.value === wanted)) {
      const option = document.createElement('option');
      option.value = wanted;
      option.textContent = `${wanted} s`;
      select.append(option);
    }
    select.value = wanted;
  }

  function render() {
    const settings = ctx.settings();
    setSelect(el.minTime, settings.minRecordingTime);
    setSelect(el.maxTime, settings.maxRecordingTime);
    el.autoStop.value = String(settings.autoStopSilenceSec);
    for (const recorder of recorders) recorder.render();
  }

  for (const seconds of AUTO_STOP_CHOICES) {
    const option = document.createElement('option');
    option.value = String(seconds);
    option.textContent = seconds === 0 ? 'Off' : `${seconds} s`;
    el.autoStop.append(option);
  }

  el.minTime.addEventListener('change', () => ctx.commit((s) => { s.minRecordingTime = Number(el.minTime.value); }));
  el.maxTime.addEventListener('change', () => ctx.commit((s) => { s.maxRecordingTime = Number(el.maxTime.value); }));
  el.autoStop.addEventListener('change', () => ctx.commit((s) => { s.autoStopSilenceSec = Number(el.autoStop.value); }));

  return { render };
}
