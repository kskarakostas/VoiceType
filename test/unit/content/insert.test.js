// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { insertText, readValue } from '../../../src/content/insert.js';

const noopExec = vi.fn(() => false);
/** execCommand stand-in that behaves like Chrome for form fields. */
function realisticExec(text) {
  const el = document.activeElement;
  if (!el || !('value' in el)) return false;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.setSelectionRange(start + text.length, start + text.length);
  return true;
}

function textarea(value = '', caret = value.length) {
  document.body.innerHTML = '<textarea id="ta"></textarea>';
  const el = document.getElementById('ta');
  el.value = value; el.focus(); el.setSelectionRange(caret, caret);
  return el;
}

describe('insertText', () => {
  it('uses execCommand when it changes the field', async () => {
    const el = textarea('Hello ', 6);
    const outcome = await insertText(el, 'world', { execCommand: realisticExec, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.value).toBe('Hello world');
  });

  it('falls back to the native setter at the caret and fires input events', async () => {
    const el = textarea('ab', 1);
    const events = [];
    el.addEventListener('input', (e) => events.push(e.inputType));
    const clipboard = vi.fn();
    const outcome = await insertText(el, 'X', { execCommand: noopExec, writeClipboard: clipboard });
    expect(outcome).toBe('inserted');
    expect(el.value).toBe('aXb');
    expect(el.selectionStart).toBe(2);
    expect(events).toEqual(['insertText']);
    expect(clipboard).not.toHaveBeenCalled();
  });

  it('appends to a contenteditable when there is no selection inside it', async () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">Hi</div>';
    const el = document.getElementById('ce');
    const outcome = await insertText(el, ' there', { execCommand: noopExec, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.textContent).toBe('Hi there');
  });

  it('restores a caret that was inside the contenteditable', async () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">Hello</div>';
    const el = document.getElementById('ce');
    const range = document.createRange();
    range.setStart(el.firstChild, 2); range.collapse(true);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const outcome = await insertText(el, 'X', { execCommand: noopExec, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.textContent).toBe('HeXllo');
  });

  it('rung one inserts at the restored caret on a contenteditable', async () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">Hello</div>';
    const el = document.getElementById('ce');
    const range = document.createRange();
    range.setStart(el.firstChild, 2); range.collapse(true);
    const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const execAtSelection = (text) => { const r = document.getSelection().getRangeAt(0); r.insertNode(document.createTextNode(text)); return true; };
    const outcome = await insertText(el, 'X', { execCommand: execAtSelection, writeClipboard: vi.fn() });
    expect(outcome).toBe('inserted');
    expect(el.textContent).toBe('HeXllo');
  });

  it('does not write into a role=textbox that is not editable', async () => {
    document.body.innerHTML = '<div id="tb" role="textbox">x</div>';
    const el = document.getElementById('tb');
    const clipboard = vi.fn(async () => {});
    const outcome = await insertText(el, 'Y', { execCommand: noopExec, writeClipboard: clipboard });
    expect(outcome).toBe('clipboard');
    expect(clipboard).toHaveBeenCalledWith('Y');
    expect(el.textContent).toBe('x');
  });

  it('disconnected target copies to clipboard', async () => {
    const el = document.createElement('textarea');
    const clipboard = vi.fn(async () => {});
    const outcome = await insertText(el, 'lost text', { execCommand: noopExec, writeClipboard: clipboard });
    expect(outcome).toBe('clipboard');
    expect(clipboard).toHaveBeenCalledWith('lost text');
  });

  it('null target copies to clipboard and clipboard failure reports failed', async () => {
    expect(await insertText(null, 't', { execCommand: noopExec, writeClipboard: vi.fn(async () => {}) })).toBe('clipboard');
    expect(await insertText(null, 't', { execCommand: noopExec, writeClipboard: vi.fn(async () => { throw new Error('denied'); }) })).toBe('failed');
  });

  it('does nothing for empty text', async () => {
    const el = textarea('keep');
    expect(await insertText(el, '', { execCommand: realisticExec, writeClipboard: vi.fn() })).toBe('failed');
    expect(el.value).toBe('keep');
  });

  it('readValue reads value for fields and textContent for editables', () => {
    document.body.innerHTML = '<input id="i" value="v"><div id="d">t</div>';
    expect(readValue(document.getElementById('i'))).toBe('v');
    expect(readValue(document.getElementById('d'))).toBe('t');
  });
});
