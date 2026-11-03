// Dictionary CSV: pure export, parser and all-or-nothing import behind the Dictionary page.
// importDictionaryCsv takes a dictionary already validated by settings repair.
import {
  DICTIONARY_ANY, MAX_KEYWORDS, MAX_TERM_LENGTH,
  countTerms, flattenDictionary, isDictionaryGroup, isTermTooLong, orderedGroupKeys,
} from '../shared/dictionary.js';

/** Largest file the Dictionary page reads. */
export const MAX_IMPORT_BYTES = 1_000_000;

const BOM = '\uFEFF';
const HEADER = ['language', 'term'];
const NOTHING_IMPORTED = 'Nothing was imported.';
/** Longest unknown language code a refusal repeats, in code points. */
const MAX_QUOTED_CODE = 32;

/**
 * @param {string} field
 * @returns {string} `field`, quoted when it holds a separator, a quote or a line break.
 */
function escapeField(field) {
  return /[,;"\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/**
 * @param {Record<string, string[]>} dictionary
 * @returns {string} CSV for Excel: BOM, CRLF, one `group,term` row per term in display order.
 */
export function serializeDictionary(dictionary) {
  const rows = orderedGroupKeys(dictionary).flatMap((group) => (
    dictionary[group].map((term) => `${group},${escapeField(term)}`)
  ));
  return `${BOM}${[HEADER.join(','), ...rows].map((row) => `${row}\r\n`).join('')}`;
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {number} Length of the line break at `at`; 0 when there is none.
 */
function lineBreakLength(text, at) {
  if (text[at] === '\r') return text[at + 1] === '\n' ? 2 : 1;
  return text[at] === '\n' ? 1 : 0;
}

/**
 * @param {string} text
 * @param {number} open Index of the opening quote.
 * @returns {{ value: string, end: number, lineBreaks: number }|null} null when never closed.
 */
function readQuotedField(text, open) {
  let value = '';
  let lineBreaks = 0;
  let at = open + 1;
  while (at < text.length) {
    if (text[at] === '"') {
      if (text[at + 1] !== '"') return { value, end: at + 1, lineBreaks };
      value += '"';
      at += 2;
    } else {
      const breakLength = lineBreakLength(text, at);
      if (breakLength) lineBreaks += 1;
      const length = breakLength || 1;
      value += text.slice(at, at + length);
      at += length;
    }
  }
  return null;
}

/**
 * RFC 4180 with any line ending. Blank records are dropped; `line` is where a record starts,
 * for records and failures alike.
 * @param {string} text
 * @param {string} [delimiter] One character.
 * @returns {{ ok: true, records: Array<{ line: number, fields: string[] }> }
 *   | { ok: false, line: number, reason: string }}
 */
export function parseCsv(text, delimiter = ',') {
  const input = text.startsWith(BOM) ? text.slice(1) : text;
  const atFieldEnd = (at) => at >= input.length || input[at] === delimiter
    || lineBreakLength(input, at) > 0;

  const records = [];
  let fields = [];
  let line = 1;
  let recordLine = 1;
  let at = 0;
  const endRecord = () => {
    if (fields.some((field) => field.trim())) records.push({ line: recordLine, fields });
    fields = [];
  };

  for (;;) {
    if (input[at] === '"') {
      const quoted = readQuotedField(input, at);
      if (!quoted) return { ok: false, line: recordLine, reason: 'a quote is never closed' };
      if (!atFieldEnd(quoted.end)) {
        return { ok: false, line: recordLine, reason: 'text follows a closing quote' };
      }
      fields.push(quoted.value);
      line += quoted.lineBreaks;
      at = quoted.end;
    } else {
      const start = at;
      while (!atFieldEnd(at)) at += 1;
      fields.push(input.slice(start, at));
    }

    if (at >= input.length) break;
    if (input[at] === delimiter) {
      at += 1;
    } else {
      at += lineBreakLength(input, at);
      line += 1;
      endRecord();
      recordLine = line;
    }
  }
  endRecord();
  return { ok: true, records };
}

/**
 * @param {string} text
 * @returns {string} `;` when the first non-blank line is a semicolon header, else `,`.
 */
function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\r|\n/).map((line) => line.trim()).find(Boolean);
  return firstLine !== undefined && /^language;term;*$/i.test(firstLine) ? ';' : ',';
}

/**
 * @param {string[]} fields
 * @returns {boolean} True when `fields` is the two-column header.
 */
function isHeader(fields) {
  const cells = fields.map((field) => field.trim().toLowerCase());
  while (cells.at(-1) === '') cells.pop();
  return cells.length === HEADER.length && HEADER.every((name, i) => cells[i] === name);
}

/** @param {string} message */
const refuse = (message) => ({ ok: false, message });

/**
 * Merges a CSV file into `dictionary`, or refuses the whole file. Every column and language
 * is checked before any term is judged. A term stored in any group, or earlier in the file,
 * is skipped. Never mutates `dictionary`; the same reference comes back when nothing is added.
 * @param {string} text
 * @param {Record<string, string[]>} dictionary
 * @returns {{ ok: true, dictionary: Record<string, string[]>, added: number, skipped: number }
 *   | { ok: false, message: string }}
 */
export function importDictionaryCsv(text, dictionary) {
  if (/[\uFFFD\0]/.test(text)) {
    return refuse(`This file is not UTF-8. Save it as CSV UTF-8 and try again. ${NOTHING_IMPORTED}`);
  }

  const parsed = parseCsv(text, detectDelimiter(text));
  if (!parsed.ok) return refuse(`Line ${parsed.line}: ${parsed.reason}. ${NOTHING_IMPORTED}`);

  const hasHeader = parsed.records.length > 0 && isHeader(parsed.records[0].fields);
  const columns = hasHeader ? 2 : 1;
  const rows = [];
  for (const { line, fields } of parsed.records.slice(hasHeader ? 1 : 0)) {
    if (fields.slice(columns).some((field) => field.trim())) {
      return refuse(hasHeader
        ? `Line ${line} has more than two columns. Quote terms that contain commas. ${NOTHING_IMPORTED}`
        : `Line ${line} has more than one column. Add a language,term header or quote terms that contain commas. ${NOTHING_IMPORTED}`);
    }
    const group = hasHeader ? fields[0].trim().toLowerCase() : DICTIONARY_ANY;
    if (!isDictionaryGroup(group)) {
      const code = [...group].slice(0, MAX_QUOTED_CODE).join('');
      return refuse(`Line ${line}: unknown language "${code}". ${NOTHING_IMPORTED}`);
    }
    const term = (fields[columns - 1] ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (term) rows.push({ line, group, term });
  }
  if (!rows.length) return refuse('No terms in that file.');

  const seen = new Set(flattenDictionary(dictionary).map((term) => term.toLowerCase()));
  const next = { ...dictionary };
  let added = 0;
  let skipped = 0;
  for (const { line, group, term } of rows) {
    const folded = term.toLowerCase();
    if (seen.has(folded)) {
      skipped += 1;
    } else if (term.includes('\t')) {
      return refuse(`Line ${line}: the term contains a tab. ${NOTHING_IMPORTED}`);
    } else if (isTermTooLong(term)) {
      return refuse(`Line ${line}: the term is over ${MAX_TERM_LENGTH} characters. ${NOTHING_IMPORTED}`);
    } else {
      seen.add(folded);
      // One copy per group: a file can hold far more rows than the cap, and the count must finish.
      if (next[group] === dictionary[group]) next[group] = [...(dictionary[group] ?? [])];
      next[group].push(term);
      added += 1;
    }
  }

  const over = countTerms(dictionary) + added - MAX_KEYWORDS;
  if (over > 0) {
    return refuse(`This import would go over the ${MAX_KEYWORDS} term limit by ${over}. ${NOTHING_IMPORTED}`);
  }
  return { ok: true, dictionary: added ? next : dictionary, added, skipped };
}
