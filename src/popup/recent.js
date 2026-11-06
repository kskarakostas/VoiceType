// The popup's list of recent dictations (V76): an arrow beside Copy last opens the newest few, one
// short line each, and a press copies that dictation's whole text. Closed, the page holds none of the
// text: it stays in `texts` here and reaches the page only when the arrow is pressed.

/** How many dictations the list offers. */
export const RECENT_MAX = 5;
/** The most characters of a dictation's first line that a row puts in the page. */
export const RECENT_LINE_MAX = 120;

const COPIED = 'Copied to clipboard.';
const COPY_ERROR = 'Could not copy.';
/** The list needs two entries to be worth an arrow: Copy last already reaches the newest. */
const MIN_ENTRIES = 2;

/**
 * @param {{
 *   document: Document,
 *   toast: (text: string, tone?: 'info'|'success'|'error') => void,
 *   copy: (text: string) => Promise<void>,
 * }} env
 * @returns {{ render: (entries: Array<{ text: string }>, keepHistory: boolean) => void }}
 */
export function createRecent({ document, toast, copy }) {
  const toggle = /** @type {HTMLButtonElement} */ (document.getElementById('recent-toggle'));
  const list = /** @type {HTMLElement} */ (document.getElementById('recent-list'));

  /** @type {string[]} */
  let texts = [];
  let open = false;
  /** The texts the list's rows show now. */
  let shown = [];

  /**
   * The first non-blank line, cut to RECENT_LINE_MAX characters. Counted by code point, so a cut never splits a pair.
   * @param {string} text
   */
  function firstLine(text) {
    const [line] = text.trimStart().split(/[\r\n]/, 1);
    return Array.from(line).slice(0, RECENT_LINE_MAX).join('');
  }

  /** @param {string} text */
  function row(text) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-row';
    // The page gets a short first line, which CSS trims to the width; the whole text stays in this closure.
    button.textContent = firstLine(text);
    button.addEventListener('click', async () => {
      try {
        await copy(text);
        toast(COPIED, 'success');
      } catch {
        toast(COPY_ERROR, 'error');
      }
    });
    item.append(button);
    return item;
  }

  function paint() {
    toggle.hidden = texts.length < MIN_ENTRIES;
    if (toggle.hidden) open = false;
    toggle.setAttribute('aria-expanded', String(open));
    list.hidden = !open;
    // Rows stay while their texts do: a rebuild would drop a focused row and a press that spans it.
    const next = open ? texts : [];
    if (next.length === shown.length && next.every((text, i) => text === shown[i])) return;
    shown = next;
    list.replaceChildren(...next.map(row));
  }

  toggle.addEventListener('click', () => {
    open = !open;
    paint();
  });

  return {
    render(entries, keepHistory) {
      texts = keepHistory
        ? entries.filter((entry) => typeof entry?.text === 'string').slice(0, RECENT_MAX).map((entry) => entry.text)
        : [];
      paint();
    },
  };
}
