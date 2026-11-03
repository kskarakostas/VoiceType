// Settings, Provider: the provider switch and one key row per provider with Test and Clear.
// Moved from the 2.2 popup unchanged in behaviour; keys save through ctx.commit.
import { MSG } from '../../shared/messages.js';
import { PROVIDERS } from '../../shared/models.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */

function maskKey(key) {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)} (saved)` : 'Key saved';
}

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createProviderSection(ctx) {
  const { $, document } = ctx;
  const providerIds = Object.keys(PROVIDERS);
  const el = {
    providerRadios: [...document.querySelectorAll('input[name="provider"]')],
    keyRow: {}, keyInput: {}, testKey: {}, clearKey: {}, spendHint: $('spend-hint'),
  };
  for (const id of providerIds) {
    el.keyRow[id] = $(`key-row-${id}`);
    el.keyInput[id] = $(`key-${id}`);
    el.testKey[id] = $(`test-${id}`);
    el.clearKey[id] = $(`clear-${id}`);
  }
  const keySaves = Object.fromEntries(providerIds.map((id) => [id, ctx.typingSave(() => saveKey(id))]));

  // A focused key field is never overwritten, so a save while typing keeps the caret.
  function render() {
    const settings = ctx.settings();
    for (const radio of el.providerRadios) radio.checked = radio.value === settings.provider;
    for (const id of providerIds) {
      const key = settings.keys[id] || '';
      el.keyRow[id].hidden = id !== settings.provider;
      el.keyInput[id].placeholder = key ? maskKey(key) : PROVIDERS[id].keyPlaceholder;
      if (document.activeElement !== el.keyInput[id]) el.keyInput[id].value = '';
      el.clearKey[id].disabled = !key;
    }
    el.spendHint.hidden = !providerIds.some((id) => settings.keys[id]?.trim());
  }

  async function saveKey(id) {
    keySaves[id].cancel();
    const value = el.keyInput[id].value.trim();
    if (!value || value === ctx.settings().keys[id]) {
      render();
      return;
    }
    await ctx.commit((s) => { s.keys[id] = value; }, 'Key saved');
  }

  async function testKey(id) {
    const key = el.keyInput[id].value.trim() || ctx.settings().keys[id]?.trim();
    if (!key) {
      ctx.toast('Enter a key first', 'error');
      return;
    }
    const button = el.testKey[id];
    button.disabled = true;
    button.textContent = 'Testing…';
    const result = await ctx.send({ action: MSG.VALIDATE_KEY, provider: id, key });
    button.disabled = false;
    button.textContent = 'Test';
    if (result?.ok) ctx.toast(`${PROVIDERS[id].label} key works`, 'success');
    else ctx.toast(result?.error || 'Could not reach the provider.', 'error');
  }

  for (const radio of el.providerRadios) {
    radio.addEventListener('change', () => {
      if (radio.checked) ctx.commit((s) => { s.provider = radio.value; });
    });
  }

  for (const id of providerIds) {
    const input = el.keyInput[id];
    input.addEventListener('input', () => keySaves[id].schedule());
    input.addEventListener('change', () => saveKey(id));
    input.addEventListener('blur', () => saveKey(id));
    el.testKey[id].addEventListener('click', () => testKey(id));
    el.clearKey[id].addEventListener('click', () => {
      keySaves[id].cancel();
      input.value = '';
      ctx.commit((s) => { s.keys[id] = ''; }, 'Key cleared');
    });
  }

  return { render, typingSaves: providerIds.map((id) => keySaves[id]) };
}
