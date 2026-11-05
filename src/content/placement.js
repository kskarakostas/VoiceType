// Where a finished result lands: the insert ladder into the bound field or the clipboard, how
// that ended, and the mark Undo AI edit works from. The controller owns the state and decides
// when; everything from it arrives through deps.
import { formatCost } from '../shared/pricing.js';
import { sameSelection } from './insert.js';

/**
 * @typedef {{
 *   pill: Pick<import('./pill.js').Pill, 'setState'>,
 *   insertText: typeof import('./insert.js').insertText,
 *   copyText: typeof import('./insert.js').copyText,
 *   markInsertion: typeof import('./insert.js').markInsertion,
 *   replaceInsertion: typeof import('./insert.js').replaceInsertion,
 *   isValidInput: (el: Element|null) => boolean,
 *   hasLiveFocus: (el: Element|null) => boolean,
 *   notify: (text: string, options?: { tone?: string, sticky?: boolean, clickable?: boolean }) => void,
 *   inactive: () => boolean,
 *   whileLanding: <T>(step: () => Promise<T>) => Promise<T>,
 *   lastRaw: () => string,
 * }} PlacementDeps
 */

const NOT_COPIED = ' Not copied.';
const CLICK_TO_COPY = 'Could not insert. Click here to copy the text.';
const SELECTION_CHANGED = 'Selection changed. Result copied to clipboard.';

/**
 * @param {PlacementDeps} deps
 */
export function createPlacement(deps) {
  const { pill, insertText, copyText, markInsertion, replaceInsertion, isValidInput, hasLiveFocus, notify, inactive, whileLanding, lastRaw } = deps;

  /** Where the last verified insert in a form field lies, for Undo AI edit (V31): `{ el, start, end, length, text, raw }`. */
  let insertMark = null;

  /**
   * The mark for text just inserted into el. A field that cannot be read gets none, so Undo
   * copies: the insert itself went well and still has its status to report.
   * @param {Element} el
   * @param {string} text
   */
  function markFor(el, text) {
    try {
      const mark = markInsertion(el, text);
      return mark && { ...mark, el, text, raw: lastRaw() };
    } catch {
      return null;
    }
  }

  /**
   * Say how an insert ended.
   * @param {import('./insert.js').InsertOutcome} outcome
   * @param {() => void} inserted says it for a verified insert
   */
  function reportInsert(outcome, inserted) {
    if (outcome === 'inserted') {
      pill.setState('done');
      inserted();
    } else if (outcome === 'unverified') {
      pill.setState('done');
      notify('Could not confirm the insert. The text is also on the clipboard.', { tone: 'warning' });
    } else if (outcome === 'clipboard') {
      pill.setState('done');
      notify('Copied to clipboard. The field could not be edited.', { tone: 'warning' });
    } else {
      pill.setState('error');
      notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
    }
  }

  /**
   * D12: the text goes into the field bound at REC start only while that field has focus,
   * this frame included; otherwise to the clipboard. An edit also needs the selection captured at
   * the press, checked here in the same task as the ladder's first step (V47).
   * @param {Element|null} bound
   * @param {{ text: string, cost: number, warning: string|null, copied: boolean|null, unpaid?: boolean,
   *   edit?: boolean, selection?: ReturnType<typeof import('./insert.js').readSelection> }} result
   *   copied: the worker's always-copy outcome, false when that copy failed;
   *   unpaid: a history action, so a verified insert has no cost to report (V30);
   *   edit: an edit's replacement; selection: what the press captured, null when this frame has none
   */
  async function placeResult(bound, { text, cost, warning, copied: alwaysCopied, unpaid = false, edit = false, selection = null }) {
    if (hasLiveFocus(bound) && (!edit || sameSelection(bound, selection))) {
      let outcome;
      try {
        outcome = await (edit ? insertText(bound, text, { replacing: true }) : insertText(bound, text));
      } catch {
        // A paid transcript is never dropped: the click-to-copy status keeps it.
        outcome = 'failed';
      }
      if (inactive()) return;
      // No mark for an edit: its raw is the instruction, and Ctrl+Z is the undo (V48).
      if (outcome === 'inserted' && !edit) insertMark = markFor(bound, text);
      reportInsert(outcome, () => {
        const suffix = alwaysCopied === false ? NOT_COPIED : '';
        if (unpaid) notify('Inserted.', { tone: 'success' });
        else if (warning) notify(`${warning}${suffix}`, { tone: 'warning' });
        else notify(`Done ${formatCost(cost)}${suffix}`, { tone: 'success' });
      });
      return;
    }

    const copied = await copyText(text);
    if (inactive()) return;
    if (!copied) {
      pill.setState('error');
      notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
    } else if (edit) {
      pill.setState('done');
      notify(SELECTION_CHANGED, { tone: 'warning' });
    } else if (bound) {
      pill.setState('done');
      notify('The field lost focus. Text copied to clipboard.', { tone: 'warning' });
    } else {
      pill.setState('done');
      notify('Copied to clipboard.', { tone: 'info' });
    }
  }
  /**
   * @param {Element|null} bound
   * @param {{ text: string, cost: number, warning: string|null, copied: boolean|null, unpaid?: boolean,
   *   edit?: boolean, selection?: ReturnType<typeof import('./insert.js').readSelection> }} result
   */
  function place(bound, result) {
    return whileLanding(() => placeResult(bound, result));
  }

  /**
   * V31: in place only over the exact text inserted here, in the field that still has the focus.
   * Anything else copies raw. Text the mark no longer covers is never searched for.
   * @param {string} raw
   * @param {string} text
   */
  async function undoEdit(raw, text) {
    const mark = insertMark;
    insertMark = null;
    const inPlace = mark?.text === text && mark.raw === raw && isValidInput(mark.el) && hasLiveFocus(mark.el);
    let outcome = null;
    if (inPlace) {
      try {
        outcome = await replaceInsertion(mark.el, mark, text, raw);
      } catch {
        outcome = 'failed';
      }
      if (inactive()) return;
    }
    if (outcome) {
      reportInsert(outcome, () => notify('Original text restored.', { tone: 'success' }));
      return;
    }
    const copied = await copyText(raw);
    if (inactive()) return;
    if (copied) {
      pill.setState('done');
      notify('Original text copied.', { tone: 'info' });
    } else {
      pill.setState('error');
      notify(CLICK_TO_COPY, { tone: 'error', sticky: true, clickable: true });
    }
  }
  /** Drop the mark: a newer result took over, or this instance is going away. */
  function clearMark() {
    insertMark = null;
  }

  return { place, reportInsert, undoEdit, clearMark };
}
