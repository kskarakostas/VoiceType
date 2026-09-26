/**
 * Make a string safe for OpenAI `prompt` and `keywords[]` fields, which reject
 * `<`, `>`, CR and LF, and keep hints short.
 * @param {unknown} text
 * @param {number} [maxLen]
 */
export function sanitizeHint(text, maxLen = 1000) {
  return String(text ?? '')
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/**
 * Replace `{{name}}` placeholders. Unknown names become empty strings.
 * @param {string} template
 * @param {Record<string, unknown>} vars
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
    vars && typeof vars === 'object' && Object.hasOwn(vars, name) && vars[name] != null
      ? String(vars[name])
      : '');
}
