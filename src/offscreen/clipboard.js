/**
 * Writes through a `copy` listener, with no textarea and no selection, so the text stays exact.
 * `execCommand` can return true and write nothing, so success also needs the listener to have run.
 * @param {unknown} text
 * @param {Document} doc
 * @returns {boolean}
 */
export function copyToClipboard(text, doc) {
  if (typeof text !== 'string' || text === '') return false;
  let supplied = false;
  /** @param {ClipboardEvent} event */
  const supply = (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', text);
    supplied = true;
  };
  doc.addEventListener('copy', supply, true);
  try {
    return doc.execCommand('copy') === true && supplied;
  } catch {
    return false;
  } finally {
    doc.removeEventListener('copy', supply, true);
  }
}
