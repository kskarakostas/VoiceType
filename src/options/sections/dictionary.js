// Dictionary: one card per group, each with a chip per term, an add field and a group remove,
// and CSV export and import. A file's text reaches the page through textContent only.
// Cards stay in place across renders, so typed text and focus survive a save or an external change.
import {
  DICTIONARY_ANY, MAX_KEYWORDS, MAX_TERM_LENGTH, SPOKEN_LANGUAGES,
  addTerms, countTerms, groupLabel, orderedGroupKeys, removeTerm, setGroupTerms,
} from '../../shared/dictionary.js';
import { MSG } from '../../shared/messages.js';
import { createInlineConfirm } from '../../ui/form.js';
import { MAX_IMPORT_BYTES, importDictionaryCsv, serializeDictionary } from '../dictionary-csv.js';

/** @typedef {import('../options.js').PageContext} PageContext */
/** @typedef {import('../options.js').Section} Section */
/** @typedef {import('../options.js').TypingSave} TypingSave */
/** @typedef {{ root: HTMLElement, input: HTMLInputElement, add(): Promise<void>, render(terms: string[]): void }} Card */

const REMOVE_GROUP_PROMPT = 'Click again to remove this group and its terms';
/** Under the service worker's 30 s idle limit, so a field holding text keeps it awake. */
const HEARTBEAT_MS = 20000;
const EXPORT_FILE_NAME = 'voicetype-dictionary.csv';
const EXPORT_TYPE = 'text/csv;charset=utf-8';
/** Long enough for the browser to start the download. */
const REVOKE_DELAY_MS = 1000;

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * @param {{ reason: 'duplicate'|'tooLong'|'full', group?: string }} refusal
 * @returns {string}
 */
function refusalText({ reason, group }) {
  if (reason === 'duplicate') return `Already in ${groupLabel(group)}`;
  if (reason === 'tooLong') return `Terms can have at most ${MAX_TERM_LENGTH} characters`;
  return `The dictionary is full (${MAX_KEYWORDS} terms)`;
}

/** @param {number} count */
const termCount = (count) => `${count} ${count === 1 ? 'term' : 'terms'}`;

/**
 * @param {number} added
 * @param {number} skipped
 * @returns {string}
 */
function importedText(added, skipped) {
  const imported = `Imported ${termCount(added)}`;
  return skipped ? `${imported}, skipped ${skipped} already in the dictionary.` : `${imported}.`;
}

/**
 * @param {number} count Terms in the file, all already in the dictionary.
 * @returns {string}
 */
function nothingNewText(count) {
  return count === 1
    ? 'Nothing new: that term is already in the dictionary.'
    : `Nothing new: all ${count} terms are already in the dictionary.`;
}

/**
 * Keeps focus where it is when the mouse presses `button`. Otherwise the press blurs a field
 * holding text, the blur adds it, the page shifts under the pointer and the click never lands.
 * @param {HTMLButtonElement} button
 */
function holdFocusOnPress(button) {
  button.addEventListener('mousedown', (event) => event.preventDefault());
}

/**
 * @param {PageContext} ctx
 * @returns {Section}
 */
export function createDictionarySection(ctx) {
  const { $, document } = ctx;
  const el = {
    count: $('dictionary-count'), groups: $('dictionary-groups'), addLanguage: $('dictionary-add-language'),
    language: $('dictionary-language'), addGroup: $('dictionary-add-group'),
    export: $('dictionary-export'), import: $('dictionary-import'), file: $('dictionary-file'),
    status: $('dictionary-status'),
  };
  /** @type {Map<string, Card>} */
  const cards = new Map();

  // The text in a field goes with the page's last message, and a closing page's message reaches
  // the worker only if the worker is awake; a live page's message wakes it. Read-only.
  const firstBeat = ctx.typingSave(heartbeat);
  let beatTimer;

  function heartbeat() {
    ctx.clearTimer(beatTimer);
    ctx.send({ action: MSG.GET_SETTINGS });
    beatTimer = ctx.setTimer(heartbeat, HEARTBEAT_MS);
  }

  /** Runs after any change to a field's text. */
  function followFieldText() {
    if (save.pending) {
      firstBeat.schedule();
    } else {
      firstBeat.cancel();
      ctx.clearTimer(beatTimer);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * @param {string} group
   * @returns {Card}
   */
  function createCard(group) {
    const headingId = `dictionary-heading-${group}`;
    const inputId = `dictionary-input-${group}`;
    const messageId = `dictionary-message-${group}`;

    const root = element('div', 'card dictionary-group');
    root.dataset.group = group;
    const heading = element('h2', '', groupLabel(group));
    heading.id = headingId;
    const list = element('ul', 'chips');
    list.setAttribute('aria-labelledby', headingId);

    const label = element('label', 'field-label', 'Add a term');
    label.htmlFor = inputId;
    const input = element('input');
    input.type = 'text';
    input.id = inputId;
    input.placeholder = 'Type a term, then press Enter';
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-describedby', messageId);
    const message = element('p', 'hint');
    message.id = messageId;
    message.setAttribute('role', 'status');
    const field = element('div', 'field');
    field.append(label, input, message);

    const removeGroup = element('button', 'btn btn-danger', 'Remove group');
    removeGroup.type = 'button';
    removeGroup.dataset.role = 'remove-group';
    removeGroup.setAttribute('aria-describedby', headingId);
    const actions = element('div', 'card-actions');
    actions.append(removeGroup);
    root.append(heading, list, field, actions);

    /** The remove button of each chip drawn, by term. */
    const chips = new Map();
    let drawn = [];

    function showRefusal(refusal) {
      message.textContent = refusal ? refusalText(refusal) : '';
      if (refusal) message.dataset.tone = 'error';
      else delete message.dataset.tone;
    }

    // The field takes the refused text before the commit, so a blur right after Enter finds
    // nothing new. A failed save hands back all the text, unless the field has changed since.
    async function add() {
      const text = input.value;
      if (!text.trim()) return;
      const { dictionary, added, refused } = addTerms(ctx.settings().dictionary, group, text);
      const kept = refused.map(({ term }) => term).join(', ');
      input.value = kept;
      followFieldText();
      showRefusal(refused[0]);
      const saved = await ctx.commit((s) => { s.dictionary = dictionary; });
      if (saved || input.value !== kept) return;
      input.value = text;
      followFieldText();
    }

    // Adds the field's text first. Left to the blur that the focus move below causes, that add
    // would rebuild the chips while no element has focus, and the moved focus would be lost.
    function removeChip(term) {
      add();
      const terms = ctx.settings().dictionary[group] ?? [];
      const index = terms.indexOf(term);
      const neighbour = terms[index + 1] ?? terms[index - 1];
      ctx.commit((s) => { s.dictionary = removeTerm(s.dictionary, group, term); });
      (chips.get(neighbour) ?? input).focus();
    }

    function createChip(term) {
      const item = element('li', 'chip');
      const button = element('button', 'chip-remove', '×');
      button.type = 'button';
      button.setAttribute('aria-label', `Remove ${term}`);
      holdFocusOnPress(button);
      // Focus moves to the next chip, so a held key would remove one term after another.
      button.addEventListener('keydown', (event) => {
        if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
      });
      button.addEventListener('click', () => removeChip(term));
      item.append(element('span', 'chip-text', term), button);
      chips.set(term, button);
      return item;
    }

    function render(terms) {
      removeGroup.hidden = group === DICTIONARY_ANY && terms.length === 0;
      if (sameList(terms, drawn)) return;
      drawn = terms;
      const focused = [...chips.keys()].find((term) => chips.get(term) === document.activeElement);
      chips.clear();
      list.replaceChildren(...terms.map((term) => createChip(term)));
      chips.get(focused)?.focus();
    }

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      add();
    });
    input.addEventListener('blur', add);
    input.addEventListener('input', followFieldText);

    holdFocusOnPress(removeGroup);
    createInlineConfirm(removeGroup, {
      prompt: REMOVE_GROUP_PROMPT,
      setTimeout: ctx.setTimer,
      clearTimeout: ctx.clearTimer,
      // Focus moves first, so the field's blur adds while the card is there. Chrome blurs a
      // focused field as it is removed, which would run that add inside this commit's render.
      onConfirm: () => {
        cards.get(DICTIONARY_ANY)?.input.focus();
        ctx.commit((s) => { s.dictionary = setGroupTerms(s.dictionary, group, []); });
      },
    });

    return { root, input, add, render };
  }

  function renderLanguages(dictionary) {
    const missing = SPOKEN_LANGUAGES.filter(({ code }) => !Object.hasOwn(dictionary, code));
    el.addLanguage.hidden = missing.length === 0;
    if (document.activeElement === el.language) return;
    const chosen = el.language.value;
    el.language.replaceChildren(...missing.map(({ code, label }) => {
      const option = element('option', '', label);
      option.value = code;
      return option;
    }));
    if (missing.some(({ code }) => code === chosen)) el.language.value = chosen;
  }

  function render() {
    const { dictionary } = ctx.settings();
    el.count.textContent = `${countTerms(dictionary)} of ${MAX_KEYWORDS} terms`;

    const groups = [...new Set([DICTIONARY_ANY, ...orderedGroupKeys(dictionary)])];
    // Over a copy: removing a focused field can blur it, and that blur can add and render again.
    for (const [group, card] of [...cards]) {
      if (groups.includes(group)) continue;
      cards.delete(group);
      card.root.remove();
      followFieldText();
    }
    // Last to first, so a new card knows the next one.
    let next = null;
    for (const group of groups.toReversed()) {
      if (!cards.has(group)) {
        cards.set(group, createCard(group));
        el.groups.insertBefore(cards.get(group).root, next);
      }
      cards.get(group).render(dictionary[group] ?? []);
      next = cards.get(group).root;
    }
    renderLanguages(dictionary);
  }

  holdFocusOnPress(el.addGroup);
  // A stale select can name a group that exists by now, and committing `[]` would wipe its terms.
  // The select can keep focus through the press, which skips its rebuild, so it rebuilds here.
  el.addGroup.addEventListener('click', () => {
    const code = el.language.value;
    if (!code) return;
    if (!Object.hasOwn(ctx.settings().dictionary, code)) {
      ctx.commit((s) => { s.dictionary = { ...s.dictionary, [code]: [] }; });
    }
    cards.get(code)?.input.focus();
    renderLanguages(ctx.settings().dictionary);
  });

  /**
   * @param {string} text
   * @param {'error'} [tone]
   */
  function showStatus(text, tone) {
    el.status.textContent = text;
    if (tone) el.status.dataset.tone = tone;
    else delete el.status.dataset.tone;
  }

  el.export.addEventListener('click', async () => {
    showStatus('');
    await save.flush();
    const blob = new Blob([serializeDictionary(ctx.settings().dictionary)], { type: EXPORT_TYPE });
    const url = ctx.window.URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = EXPORT_FILE_NAME;
    link.click();
    ctx.setTimer(() => ctx.window.URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  });

  el.import.addEventListener('click', () => el.file.click());

  /** @param {File} file */
  async function importFile(file) {
    if (file.size > MAX_IMPORT_BYTES) {
      showStatus('That file is too large. Nothing was imported.', 'error');
      return;
    }
    let text;
    try {
      text = await file.text();
    } catch {
      showStatus('Could not read that file. Nothing was imported.', 'error');
      return;
    }
    const result = importDictionaryCsv(text, ctx.settings().dictionary);
    if (!result.ok) {
      showStatus(result.message, 'error');
    } else if (result.added === 0) {
      showStatus(nothingNewText(result.skipped));
    } else if (await ctx.commit((s) => { s.dictionary = result.dictionary; })) {
      showStatus(importedText(result.added, result.skipped));
    } else {
      showStatus('Could not save. Nothing was imported.', 'error');
    }
  }

  el.file.addEventListener('change', () => {
    const [file] = el.file.files;
    // Without this, picking the same file again fires no change.
    el.file.value = '';
    if (!file) return;
    showStatus('');
    importFile(file);
  });

  /** @type {TypingSave} */
  const save = {
    get pending() {
      return [...cards.values()].some(({ input }) => input.value.trim() !== '');
    },
    schedule() {},
    cancel() {},
    flush() {
      return Promise.all([...cards.values()].map(({ add }) => add()));
    },
  };

  return { render, typingSaves: [save] };
}
