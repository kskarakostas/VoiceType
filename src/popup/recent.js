// The popup's list of recent dictations (V76): an arrow beside Copy last opens the newest few, one
// line each, and a press copies that dictation's whole text. Closed, the page holds none of the
// text: it stays in `texts` here and reaches the page only when the arrow is pressed.

/** How many dictations the list offers. */
export const RECENT_MAX = 5;

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

  /** @param {string} text */
  function row(text) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-row';
    // The page gets the first line, which CSS trims; the whole text stays in this closure.
    button.textContent = text.split(/[\r\n]/, 1)[0];
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
    list.replaceChildren(...(open ? texts.map(row) : []));
  }

  toggle.addEventListener('click', () => {
    open = !open;
    paint();
  });

  return {
    render(entries, keepHistory) {
      texts = keepHistory ? entries.slice(0, RECENT_MAX).map((entry) => entry.text) : [];
      paint();
    },
  };
}
