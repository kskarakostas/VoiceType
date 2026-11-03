// Settings, Recording: length limits, silence auto-stop and the hotkey recorder. Ported from the
// 2.2 popup unchanged in behaviour; changes save through ctx.commit.
import { AUTO_STOP_CHOICES } from '../../shared/defaults.js';
import { formatChord, chordFromEvent } from '../../shared/chord.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

const HOTKEY_IDLE_HINT = 'Tap to toggle, hold to talk.';
const HOTKEY_ARMED_HINT = 'Press the new hotkey. Esc cancels.';
const HOTKEY_INVALID_HINT = 'Use Ctrl, Alt or Cmd with a key';
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'AltGraph', 'Meta', 'OS']);

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createRecordingSection(ctx) {
  const { $, document, mac } = ctx;
  const el = {
    minTime: $('min-time'), maxTime: $('max-time'), autoStop: $('auto-stop'),
    hotkey: $('hotkey'), hotkeyHint: $('hotkey-hint'),
  };
  let hotkeyArmed = false;

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
    renderHotkey();
  }

  function renderHotkey() {
    el.hotkey.textContent = hotkeyArmed ? 'Press keys' : formatChord(ctx.settings().hotkey, { mac });
    el.hotkey.setAttribute('aria-pressed', String(hotkeyArmed));
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

  function setHotkeyHint(text, tone) {
    el.hotkeyHint.textContent = text;
    if (tone) el.hotkeyHint.dataset.tone = tone;
    else delete el.hotkeyHint.dataset.tone;
  }

  function disarmHotkey() {
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    renderHotkey();
  }

  el.hotkey.addEventListener('click', () => {
    if (hotkeyArmed) {
      disarmHotkey();
      return;
    }
    hotkeyArmed = true;
    setHotkeyHint(HOTKEY_ARMED_HINT);
    renderHotkey();
    el.hotkey.focus();
  });
  el.hotkey.addEventListener('blur', () => { if (hotkeyArmed) disarmHotkey(); });
  el.hotkey.addEventListener('keydown', (event) => {
    if (!hotkeyArmed || event.key === 'Tab') return;
    // Also keeps Space or Enter from clicking the button.
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      disarmHotkey();
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const chord = chordFromEvent(event);
    if (!chord) {
      setHotkeyHint(HOTKEY_INVALID_HINT, 'error');
      return;
    }
    hotkeyArmed = false;
    setHotkeyHint(HOTKEY_IDLE_HINT);
    ctx.commit((s) => { s.hotkey = chord; }, `Hotkey: ${formatChord(chord, { mac })}`);
  });

  return { render };
}
