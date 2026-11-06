// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRecent, RECENT_MAX } from '../../../src/popup/recent.js';

// jsdom replaces the global URL, so resolve paths with node:path rather than new URL().
const HTML = readFileSync(join(import.meta.dirname, '../../../src/popup/popup.html'), 'utf8');

const entries = (n) => Array.from({ length: n }, (_, i) => ({ text: `dictation ${i}` }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup() {
  document.body.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').body.innerHTML;
  const toast = vi.fn();
  const copy = vi.fn(async () => {});
  const recent = createRecent({ document, toast, copy });
  return {
    recent, toast, copy,
    list: document.getElementById('recent-list'),
    toggle: document.getElementById('recent-toggle'),
  };
}

const rows = (list) => [...list.querySelectorAll('button')];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('recent dictations (V76)', () => {
  it('shows the newest 5', () => {
    expect(RECENT_MAX).toBe(5);
  });

  it('stays closed until the arrow, and shows no text', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(3), true);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.body.textContent).not.toContain('dictation');
  });

  it('opens the newest 5', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(8), true);
    toggle.click();
    expect(rows(list).map((b) => b.textContent)).toEqual(entries(5).map((e) => e.text));
    expect(list.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows one line and copies the whole text', async () => {
    const { recent, list, toggle, copy } = setup();
    const text = `first line\nsecond line ${'x'.repeat(5000)}`;
    recent.render([{ text }, { text: 'b' }], true);
    toggle.click();
    const row = list.querySelector('button');
    expect(row.textContent).toBe('first line');
    row.click();
    await settle();
    expect(copy).toHaveBeenCalledWith(text);
  });

  it('cuts at a carriage return as at a line feed', () => {
    const { recent, list, toggle } = setup();
    recent.render([{ text: 'one\r\ntwo' }, { text: 'three\rfour' }], true);
    toggle.click();
    expect(rows(list).map((b) => b.textContent)).toEqual(['one', 'three']);
  });

  it('keeps the rest of the text out of the page, open or closed', () => {
    const { recent, list, toggle } = setup();
    recent.render([{ text: 'first line\nsecond line' }, { text: 'b' }], true);
    toggle.click();
    const [row] = rows(list);
    expect(row.title).toBe('');
    expect(row.getAttributeNames().sort()).toEqual(['class', 'type']);
    expect(document.body.innerHTML).not.toContain('second line');
    toggle.click();
    expect(document.body.innerHTML).not.toContain('first line');
  });

  it('builds rows from text, never from HTML', () => {
    const { recent, list, toggle } = setup();
    recent.render([{ text: '<img src=x onerror=alert(1)> <b>bold</b>' }, { text: 'b' }], true);
    toggle.click();
    expect(list.querySelector('img, b')).toBeNull();
    expect(rows(list)[0].textContent).toBe('<img src=x onerror=alert(1)> <b>bold</b>');
  });

  it('copies the row that was pressed', async () => {
    const { recent, list, toggle, copy } = setup();
    recent.render(entries(4), true);
    toggle.click();
    rows(list)[2].click();
    await settle();
    expect(copy).toHaveBeenCalledExactlyOnceWith('dictation 2');
  });

  it('stays open after a copy, says so, and says so when the copy fails', async () => {
    const { recent, list, toggle, copy, toast } = setup();
    recent.render(entries(2), true);
    toggle.click();
    list.querySelector('button').click();
    await settle();
    expect(toast).toHaveBeenLastCalledWith('Copied to clipboard.', 'success');
    copy.mockRejectedValueOnce(new Error('refused'));
    list.querySelector('button').click();
    await settle();
    expect(toast).toHaveBeenLastCalledWith('Could not copy.', 'error');
    expect(list.hidden).toBe(false);
    expect(rows(list)).toHaveLength(2);
  });

  it('a refused copy throws nothing out of the page', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const { recent, list, toggle, copy } = setup();
    copy.mockRejectedValue(new Error('NotAllowedError'));
    recent.render(entries(2), true);
    toggle.click();
    list.querySelector('button').click();
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('the arrow closes the list again, and takes the text out of the page', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(3), true);
    toggle.click();
    toggle.click();
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('hides the arrow below 2 entries, and with history off', () => {
    const { recent, toggle } = setup();
    recent.render(entries(1), true);
    expect(toggle.hidden).toBe(true);
    recent.render(entries(3), false);
    expect(toggle.hidden).toBe(true);
    recent.render(entries(2), true);
    expect(toggle.hidden).toBe(false);
  });

  it('a clear empties an open list', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(3), true);
    toggle.click();
    recent.render([], true);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('falling to one entry closes an open list', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(3), true);
    toggle.click();
    recent.render(entries(1), true);
    expect(toggle.hidden).toBe(true);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
  });

  it('history off closes and empties an open list, and it stays closed when history returns', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(3), true);
    toggle.click();
    recent.render(entries(3), false);
    expect(toggle.hidden).toBe(true);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    recent.render(entries(3), true);
    expect(toggle.hidden).toBe(false);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
  });

  it('a new dictation updates an open list, and a closed one stays closed', () => {
    const { recent, list, toggle } = setup();
    recent.render(entries(2), true);
    recent.render([{ text: 'newest' }, ...entries(2)], true);
    expect(list.hidden).toBe(true);
    expect(list.textContent).toBe('');
    toggle.click();
    expect(rows(list).map((b) => b.textContent)).toEqual(['newest', 'dictation 0', 'dictation 1']);
    recent.render([{ text: 'newer still' }, { text: 'newest' }, ...entries(2)], true);
    expect(list.hidden).toBe(false);
    expect(rows(list).map((b) => b.textContent)).toEqual(['newer still', 'newest', 'dictation 0', 'dictation 1']);
  });
});
