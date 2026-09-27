/**
 * Make a string safe for OpenAI `prompt` and `keywords[]` fields, which reject
 * `<`, `>`, CR and LF, and keep hints short.
 * @param {unknown} text
 * @param {number} [maxLen] maximum length in code points; a negative value counts as 0
 * @returns {string}
 */
export function sanitizeHint(text, maxLen = 1000) {
  const clean = String(text ?? '')
    .replace(/[<>\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = Math.max(0, maxLen);
  if (clean.length <= limit) return clean;
  // Cut by code point so an emoji is never split, then drop a space the cut exposed.
  return Array.from(clean).slice(0, limit).join('').trimEnd();
}

/**
 * Replace `{{name}}` placeholders (spaces inside the braces allowed) with values from `vars`.
 * Only own properties of `vars` count: inherited names such as `constructor`, unknown
 * names and null or undefined values all become empty strings. Other values are
 * converted with `String`, so `0` and `false` are kept.
 * @param {string} template
 * @param {Record<string, unknown>|null|undefined} vars
 * @returns {string}
 */
export function fillTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) =>
    vars && typeof vars === 'object' && Object.hasOwn(vars, name) && vars[name] != null
      ? String(vars[name])
      : '');
}
