// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  insertText, copyText, readValue, normalizeForCompare, markInsertion, replaceInsertion, readSelection, sameSelection,
  CLIPBOARD_ONLY_HOSTS, WRITE_LIMIT_MS,
} from '../../../src/content/insert.js';

// jsdom has no execCommand, DataTransfer or ClipboardEvent, and every event a script
// dispatches is untrusted. The stand-ins below mimic Chrome; events they mark count as trusted.
const trustedEvents = new WeakSet();
const isTrusted = (event) => trustedEvents.has(event);

function trustedInput(text) {
  const event = new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text });
  trustedEvents.add(event);
  return event;
}

/** One macrotask, then a single read-back: enough for microtask commits and fast. */
async function quickSettle(check) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return check();
}

/** execCommand('insertText') as Chrome runs it in a focused form field. */
function formExec(text) {
  const el = document.activeElement;
  if (!el || !('value' in el)) return false;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.setSelectionRange(start + text.length, start + text.length);
  el.dispatchEvent(trustedInput(text));
  return true;
}

/** execCommand('insertText') as Chrome runs it in a focused contenteditable. */
function editableExec(text) {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  document.activeElement.dispatchEvent(trustedInput(text));
  return true;
}

/** A paste event jsdom can build: plain Event plus a text/plain clipboardData. */
function fakePasteEvent(text) {
  const event = new Event('paste', { bubbles: true, cancelable: true, composed: true });
  event.clipboardData = { types: ['text/plain'], getData: (type) => (type === 'text/plain' ? text : '') };
  return event;
}

/** What an editor's paste or beforeinput handler does: insert at the caret itself. */
function insertAtCaret(text) {
  const sel = document.getSelection();
  const range = sel.getRangeAt(0);
  range.insertNode(document.createTextNode(text));
}

function deps(overrides = {}) {
  return {
    execCommand: vi.fn(() => false),
    writeClipboard: vi.fn(async () => {}),
    // The copy fallback fails unless a test says otherwise, so a rejected write means no copy.
    execCopy: vi.fn(() => false),
    settle: quickSettle,
    confirm: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 0))),
    isTrusted,
    createPasteEvent: () => null,
    hostname: 'example.com',
    ...overrides,
  };
}

function textarea(value = '', caret = value.length) {
  document.body.innerHTML = '<textarea id="ta"></textarea>';
  const el = document.getElementById('ta');
  el.value = value;
  el.focus();
  el.setSelectionRange(caret, caret);
  return el;
}

function editable(html, attrs = 'contenteditable="true"') {
  document.body.innerHTML = `<div id="ce" ${attrs}>${html}</div>`;
  document.getSelection().removeAllRanges();
  return document.getElementById('ce');
}

function setCaret(node, offset) {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Lexical stand-in: its MutationObserver sees a foreign DOM change and the editor restores
 * its own DOM a microtask after that, well before any timer fires.
 */
function revertForeignWrites(el) {
  const snapshot = [...el.childNodes].map((node) => node.cloneNode(true));
  const seen = [];
  const observer = new MutationObserver((records) => {
    seen.push(...records);
    observer.disconnect();
    queueMicrotask(() => el.replaceChildren(...snapshot.map((node) => node.cloneNode(true))));
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.execCommand;
  document.body.innerHTML = '';
});

describe('normalizeForCompare', () => {
  it('normalizes newlines, then drops spaces, newlines, NBSP, U+200B and U+FEFF', () => {
    expect(normalizeForCompare('a b\r\nc\rd\u00A0e\u200Bf\uFEFFg\n')).toBe('abcdefg');
    expect(normalizeForCompare('a\tb')).toBe('a\tb');
  });
});

describe('readValue', () => {
  it('reads value for fields and textContent for editables', () => {
    document.body.innerHTML = '<input id="i" value="v"><div id="d">t</div>';
    expect(readValue(document.getElementById('i'))).toBe('v');
    expect(readValue(document.getElementById('d'))).toBe('t');
  });
});

describe('insertText in form fields', () => {
  it('re-applies the selection before execCommand and inserts once', async () => {
    const el = textarea('Hello ', 6);
    const select = vi.spyOn(el, 'setSelectionRange');
    const exec = vi.fn(formExec);
    const d = deps({ execCommand: exec });
    expect(await insertText(el, 'world', d)).toBe('inserted');
    expect(el.value).toBe('Hello world');
    expect(select).toHaveBeenNthCalledWith(1, 6, 6);
    expect(select.mock.invocationCallOrder[0]).toBeLessThan(exec.mock.invocationCallOrder[0]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('never trusts the execCommand return value: true without a change falls to beforeinput and the setter', async () => {
    const el = textarea('ab', 1);
    const events = [];
    el.addEventListener('beforeinput', (e) => events.push(['beforeinput', el.value, e.cancelable, e.composed, e.inputType, e.data]));
    el.addEventListener('input', (e) => events.push(['input', el.value, e.composed, e.inputType, e.data]));
    el.addEventListener('change', () => events.push(['change', el.value]));
    const d = deps({ execCommand: vi.fn(() => true) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(el.value).toBe('aXb');
    expect(el.selectionStart).toBe(2);
    expect(events).toEqual([
      ['beforeinput', 'ab', true, true, 'insertText', 'X'],
      ['input', 'aXb', true, 'insertText', 'X'],
      ['change', 'aXb'],
    ]);
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a false execCommand skips the settle', async () => {
    const el = textarea('ab', 2);
    const settle = vi.fn(quickSettle);
    const d = deps({ settle });
    expect(await insertText(el, 'c', d)).toBe('inserted');
    expect(d.execCommand).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
    expect(el.value).toBe('abc');
  });

  it('a trusted input without a change stops the ladder: unverified, copied, no setter', async () => {
    const el = textarea('ab', 2);
    const beforeinput = vi.fn();
    el.addEventListener('beforeinput', beforeinput);
    const exec = vi.fn((text) => el.dispatchEvent(trustedInput(text)));
    const d = deps({ execCommand: exec });
    expect(await insertText(el, 'X', d)).toBe('unverified');
    expect(el.value).toBe('ab');
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
    expect(beforeinput).not.toHaveBeenCalled();
  });

  it('an ambiguous execCommand (partial text) is unverified, copied and never followed by another rung', async () => {
    const el = textarea('', 0);
    const dispatch = vi.fn((target, event) => target.dispatchEvent(event));
    const exec = vi.fn(() => formExec('hello'));
    const d = deps({ execCommand: exec, dispatch });
    expect(await insertText(el, 'hello world', d)).toBe('unverified');
    expect(el.value).toBe('hello');
    expect(d.writeClipboard).toHaveBeenCalledWith('hello world');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('an unverified insert whose copy fails reports failed', async () => {
    const el = textarea('', 0);
    const d = deps({
      execCommand: () => formExec('hello'),
      writeClipboard: vi.fn(async () => { throw new Error('denied'); }),
    });
    expect(await insertText(el, 'hello world', d)).toBe('failed');
  });

  it('an execCommand that commits in a microtask inserts exactly once (default settle)', async () => {
    const el = textarea('Hi', 2);
    const exec = vi.fn((text) => {
      queueMicrotask(() => { el.value += text; });
      return true;
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec, settle: undefined }))).toBe('inserted');
    expect(el.value).toBe('Hi there');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('an editor that renders the insert 20 ms later still gets it exactly once (default settle)', async () => {
    const el = textarea('Hi', 2);
    const exec = vi.fn((text) => {
      setTimeout(() => { el.value += text; }, 20);
      return true;
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec, settle: undefined }))).toBe('inserted');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(el.value).toBe('Hi there');
  });

  it('a prevented beforeinput stops before the setter', async () => {
    const el = textarea('ab', 2);
    const input = vi.fn();
    el.addEventListener('beforeinput', (e) => e.preventDefault());
    el.addEventListener('input', input);
    const d = deps();
    expect(await insertText(el, 'X', d)).toBe('unverified');
    expect(el.value).toBe('ab');
    expect(input).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('a page that prevents beforeinput and inserts itself counts as inserted', async () => {
    const el = textarea('ab', 2);
    el.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      el.value += e.data;
    });
    const d = deps();
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(el.value).toBe('abX');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('refused focus skips execCommand; the setter still inserts', async () => {
    document.body.innerHTML = '<input id="other"><textarea id="ta"></textarea>';
    const other = document.getElementById('other');
    const el = document.getElementById('ta');
    el.value = 'ab';
    el.setSelectionRange(2, 2);
    other.focus();
    el.focus = () => {};
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(el.value).toBe('abX');
    expect(other.value).toBe('');
  });

  it('inputs without selection support (email) get the text appended', async () => {
    document.body.innerHTML = '<input id="em" type="email" value="a@b">';
    const el = document.getElementById('em');
    expect(await insertText(el, '.com', deps())).toBe('inserted');
    expect(el.value).toBe('a@b.com');
  });

  it('replacing a selection with identical text reads as inserted', async () => {
    const el = textarea('hello', 0);
    el.setSelectionRange(0, 5);
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, 'hello', d)).toBe('inserted');
    expect(el.value).toBe('hello');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });
});

describe('insertText in contenteditable', () => {
  function recordRungs(el, order) {
    el.addEventListener('paste', () => order.push('paste'));
    el.addEventListener('beforeinput', () => order.push('beforeinput'));
    return vi.fn(() => {
      order.push('exec');
      return false;
    });
  }

  it('single-line text tries execCommand before paste', async () => {
    const el = editable('Hi');
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('inserted');
    expect(order).toEqual(['exec', 'paste', 'beforeinput']);
    expect(el.textContent).toBe('Hi there');
  });

  it('multi-line text tries paste before execCommand', async () => {
    const el = editable('Hi');
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, 'one\ntwo', d)).toBe('inserted');
    expect(order).toEqual(['paste', 'exec', 'beforeinput']);
    expect(el.textContent).toBe('Hione\ntwo');
  });

  it('Slate editors get the paste rung first for single-line text', async () => {
    const el = editable('<p>Hi</p>', 'contenteditable="true" data-slate-editor="true"');
    const paste = vi.fn((e) => {
      e.preventDefault();
      insertAtCaret(e.clipboardData.getData('text/plain'));
    });
    el.addEventListener('paste', paste);
    const d = deps({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('inserted');
    expect(paste).toHaveBeenCalledTimes(1);
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(el.textContent).toBe('Hi there');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a Slate editor that ignores the paste gets execCommand second, then beforeinput, never a raw insert', async () => {
    const el = editable('Hi', 'contenteditable="true" data-slate-editor="true"');
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(order).toEqual(['paste', 'exec', 'beforeinput']);
    expect(el.textContent).toBe('Hi');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it.each([
    ['Lexical', 'data-lexical-editor="true"'],
    ['ProseMirror', 'class="ProseMirror"'],
    ['Quill', 'class="ql-editor"'],
    ['Draft.js', 'data-contents="true"'],
    ['CodeMirror', 'class="cm-content"'],
  ])('a non-Slate framework editor (%s) still tries execCommand first for single-line text', async (_name, marker) => {
    const el = editable('Hi', `contenteditable="true" ${marker}`);
    const order = [];
    const d = deps({ execCommand: recordRungs(el, order), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(order).toEqual(['exec', 'paste', 'beforeinput']);
  });

  it('a paste the editor handles (prevented, text inserted) counts as inserted', async () => {
    const el = editable('<p>Hi</p>');
    const beforeinput = vi.fn();
    el.addEventListener('beforeinput', beforeinput);
    el.addEventListener('paste', (e) => {
      e.preventDefault();
      insertAtCaret(e.clipboardData.getData('text/plain'));
    });
    const d = deps({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' one\ntwo', d)).toBe('inserted');
    expect(el.textContent).toBe('Hi one\ntwo');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(beforeinput).not.toHaveBeenCalled();
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a prevented paste that inserts nothing is unverified and stops the ladder', async () => {
    const el = editable('Hi');
    el.addEventListener('paste', (e) => e.preventDefault());
    const d = deps({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
    expect(await insertText(el, 'one\ntwo', d)).toBe('unverified');
    expect(el.textContent).toBe('Hi');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('one\ntwo');
  });

  it('beforeinput counts when the editor prevents it and inserts', async () => {
    const el = editable('Hi', 'contenteditable="true" class="ProseMirror"');
    el.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      insertAtCaret(e.data);
    });
    const d = deps();
    expect(await insertText(el, ' there', d)).toBe('inserted');
    expect(el.textContent).toBe('Hi there');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('a Lexical-like editor never gets a raw DOM insert and ends at the clipboard', async () => {
    const el = editable('<p>Hi</p>', 'contenteditable="true" data-lexical-editor="true"');
    const seen = revertForeignWrites(el);
    const d = deps({ createPasteEvent: fakePasteEvent });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(seen).toHaveLength(0);
    expect(el.innerHTML).toBe('<p>Hi</p>');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('a raw insert that the page reverts in a microtask is not reported as inserted', async () => {
    const el = editable('<p>Hi</p>');
    const seen = revertForeignWrites(el);
    const d = deps({ settle: undefined });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(seen.length).toBeGreaterThan(0);
    expect(el.innerHTML).toBe('<p>Hi</p>');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  /** A page that rewrites the editor `ms` after VoiceType's raw insert, as a re-rendering editor does. */
  function rewriteAfterRawInsert(el, html, ms) {
    el.addEventListener('input', () => setTimeout(() => { el.innerHTML = html; }, ms), { once: true });
  }

  it('a raw insert that the page reverts a task later ends at the clipboard', async () => {
    const el = editable('<p>Hi</p>');
    rewriteAfterRawInsert(el, '<p>Hi</p>', 10);
    const d = deps({ confirm: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 30))) });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(el.innerHTML).toBe('<p>Hi</p>');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('the default confirmation window outlasts a revert a task after the read-back', async () => {
    const el = editable('<p>Hi</p>');
    rewriteAfterRawInsert(el, '<p>Hi</p>', 20);
    const d = deps({ settle: undefined, confirm: undefined });
    expect(await insertText(el, ' there', d)).toBe('clipboard');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('a raw insert the page turns into something else is unverified and copied', async () => {
    const el = editable('<p>Hi</p>');
    rewriteAfterRawInsert(el, '<p>Hi th</p>', 10);
    const d = deps({ confirm: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 30))) });
    expect(await insertText(el, ' there', d)).toBe('unverified');
    expect(d.writeClipboard).toHaveBeenCalledWith(' there');
  });

  it('a raw insert that stays through the confirmation window is inserted; other rungs skip the window', async () => {
    const raw = editable('<p>Hi</p>');
    const d = deps();
    expect(await insertText(raw, ' there', d)).toBe('inserted');
    expect(d.confirm).toHaveBeenCalledTimes(1);
    expect(raw.innerHTML).toBe('<p>Hi there</p>');
    expect(d.writeClipboard).not.toHaveBeenCalled();

    const viaExec = editable('Hi');
    const e = deps({ execCommand: vi.fn(editableExec) });
    expect(await insertText(viaExec, ' there', e)).toBe('inserted');
    expect(e.confirm).not.toHaveBeenCalled();
  });

  it('the caret at the end lands inside the last text node, not at the editor root', async () => {
    const el = editable('<p>Hi</p>\n');
    const p = el.querySelector('p');
    let caret = null;
    const exec = vi.fn((text) => {
      const sel = document.getSelection();
      caret = [sel.anchorNode, sel.anchorOffset];
      return editableExec(text);
    });
    expect(await insertText(el, ' there', deps({ execCommand: exec }))).toBe('inserted');
    expect(caret).toEqual([p.firstChild, 2]);
    expect(p.textContent).toBe('Hi there');
  });

  it('the raw insert also lands inside the last text node', async () => {
    const el = editable('<p>Hi</p>');
    expect(await insertText(el, ' there', deps())).toBe('inserted');
    expect(el.innerHTML).toBe('<p>Hi there</p>');
  });

  it('restores a caret that was inside the contenteditable', async () => {
    const el = editable('Hello');
    setCaret(el.firstChild, 2);
    expect(await insertText(el, 'X', deps())).toBe('inserted');
    expect(el.textContent).toBe('HeXllo');
  });

  it('execCommand inserts at the restored caret', async () => {
    const el = editable('Hello');
    setCaret(el.firstChild, 2);
    const d = deps({ execCommand: vi.fn(editableExec) });
    expect(await insertText(el, 'X', d)).toBe('inserted');
    expect(d.execCommand).toHaveBeenCalledTimes(1);
    expect(el.textContent).toBe('HeXllo');
  });

  it("contenteditable '' and 'plaintext-only' are written", async () => {
    for (const attrs of ['contenteditable=""', 'contenteditable="plaintext-only"']) {
      const el = editable('Hi', attrs);
      expect(await insertText(el, ' there', deps()), attrs).toBe('inserted');
      expect(el.textContent).toBe('Hi there');
    }
  });

  it('a role=textbox that is not editable is never written', async () => {
    document.body.innerHTML = '<div id="tb" role="textbox">x</div>';
    const el = document.getElementById('tb');
    const d = deps();
    expect(await insertText(el, 'Y', d)).toBe('clipboard');
    expect(d.writeClipboard).toHaveBeenCalledWith('Y');
    expect(el.textContent).toBe('x');
  });

  it('builds the default paste as a cancelable, composed ClipboardEvent holding only text/plain', async () => {
    class FakeDataTransfer {
      constructor() { this.store = new Map(); }
      setData(type, value) { this.store.set(type, value); }
      getData(type) { return this.store.get(type) ?? ''; }
      get types() { return [...this.store.keys()]; }
    }
    class FakeClipboardEvent extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData ?? null;
      }
    }
    vi.stubGlobal('DataTransfer', FakeDataTransfer);
    vi.stubGlobal('ClipboardEvent', FakeClipboardEvent);
    const el = editable('Hi');
    let pasted = null;
    el.addEventListener('paste', (e) => {
      pasted = e;
      e.preventDefault();
      insertAtCaret(e.clipboardData.getData('text/plain'));
    });
    expect(await insertText(el, 'one\ntwo', deps({ createPasteEvent: undefined }))).toBe('inserted');
    expect(pasted).toBeInstanceOf(FakeClipboardEvent);
    expect([pasted.bubbles, pasted.cancelable, pasted.composed]).toEqual([true, true, true]);
    expect(pasted.clipboardData.types).toEqual(['text/plain']);
    expect(el.textContent).toBe('Hione\ntwo');
  });
});

describe('insertText guards', () => {
  it('docs.google.com goes straight to the clipboard', async () => {
    expect(CLIPBOARD_ONLY_HOSTS.has('docs.google.com')).toBe(true);
    const el = textarea('ab', 2);
    const dispatch = vi.fn();
    const d = deps({ execCommand: vi.fn(formExec), dispatch, hostname: 'docs.google.com' });
    expect(await insertText(el, 'X', d)).toBe('clipboard');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(el.value).toBe('ab');
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('a detached or missing target copies', async () => {
    const d = deps();
    expect(await insertText(document.createElement('textarea'), 'lost text', d)).toBe('clipboard');
    expect(d.writeClipboard).toHaveBeenCalledWith('lost text');
    expect(await insertText(null, 't', deps())).toBe('clipboard');
    expect(await insertText(null, 't', deps({ writeClipboard: vi.fn(async () => { throw new Error('denied'); }) }))).toBe('failed');
  });

  it('an execCommand that detaches the target copies without another rung', async () => {
    const el = textarea('ab', 2);
    const dispatch = vi.fn((target, event) => target.dispatchEvent(event));
    const exec = vi.fn(() => {
      el.remove();
      return true;
    });
    const d = deps({ execCommand: exec, dispatch });
    expect(await insertText(el, 'X', d)).toBe('clipboard');
    expect(dispatch).not.toHaveBeenCalled();
    expect(d.writeClipboard).toHaveBeenCalledWith('X');
  });

  it('empty text does nothing; whitespace-only text is copied, never typed', async () => {
    const el = textarea('keep');
    const d = deps({ execCommand: vi.fn(formExec) });
    expect(await insertText(el, '', d)).toBe('failed');
    expect(await insertText(el, ' \n\u00A0', d)).toBe('clipboard');
    expect(d.execCommand).not.toHaveBeenCalled();
    expect(el.value).toBe('keep');
  });

  it('removes its capture-phase input listener when done', async () => {
    const win = document.defaultView;
    const add = vi.spyOn(win, 'addEventListener');
    const remove = vi.spyOn(win, 'removeEventListener');
    await insertText(textarea('a', 1), 'b', deps());
    const added = add.mock.calls.find(([type]) => type === 'input');
    expect(added[2]).toBe(true);
    expect(remove).toHaveBeenCalledWith('input', added[1], true);
  });
});

describe('markInsertion', () => {
  it('reads the offsets after an insert in a textarea', async () => {
    const el = textarea('Hello  there', 6);
    await insertText(el, 'world', deps({ execCommand: formExec }));
    expect(markInsertion(el, 'world')).toEqual({ start: 6, end: 11, length: el.value.length });
  });

  it('reads them when the setter rung inserted', async () => {
    const el = textarea('ab', 1);
    await insertText(el, 'X', deps({ execCommand: () => false }));
    expect(markInsertion(el, 'X')).toEqual({ start: 1, end: 2, length: 3 });
  });

  it('is null for an input with no selection support', async () => {
    document.body.innerHTML = '<input id="mail" type="email">';
    const el = document.getElementById('mail');
    el.focus();
    await insertText(el, 'a@b.c', deps({ execCommand: () => false }));
    expect(el.value).toBe('a@b.c');
    expect(markInsertion(el, 'a@b.c')).toBeNull();
  });

  it('is null for a contenteditable', () => {
    const el = editable('world');
    expect(markInsertion(el, 'world')).toBeNull();
  });

  it('is null when the page changed the text as it went in', () => {
    const el = textarea('WORLD', 5);
    expect(markInsertion(el, 'world')).toBeNull();
  });

  it('is null when the caret is not at the end of the text', () => {
    const el = textarea('world', 2);
    expect(markInsertion(el, 'world')).toBeNull();
  });
});

describe('replaceInsertion', () => {
  /** The mark of 'refined' at offset 6, read when the field was as long as it is now. */
  const at = (el) => ({ start: 6, end: 13, length: el.value.length });

  it('puts raw in place of the exact text, keeping what is around it', async () => {
    const el = textarea('Hello refined there', 19);
    const d = deps({ execCommand: formExec });
    expect(await replaceInsertion(el, at(el), 'refined', 'raw words', d)).toBe('inserted');
    expect(el.value).toBe('Hello raw words there');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('selects the offsets before the ladder runs, so execCommand replaces them', async () => {
    const el = textarea('Hello refined', 2);
    const seen = [];
    const d = deps({ execCommand: (text) => { seen.push([el.selectionStart, el.selectionEnd]); return formExec(text); } });
    await replaceInsertion(el, at(el), 'refined', 'raw', d);
    expect(seen).toEqual([[6, 13]]);
  });

  it('works when raw holds the text, which no count can tell from a second insert', async () => {
    const el = textarea('refined', 7);
    const d = deps({ execCommand: formExec });
    expect(await replaceInsertion(el, { start: 0, end: 7, length: 7 }, 'refined', 'refined text', d)).toBe('inserted');
    expect(el.value).toBe('refined text');
  });

  it('is null when the text moved', async () => {
    const el = textarea('typed Hello refined', 0);
    const d = deps({ execCommand: formExec });
    expect(await replaceInsertion(el, at(el), 'refined', 'raw', d)).toBeNull();
    expect(el.value).toBe('typed Hello refined');
    expect(d.writeClipboard).not.toHaveBeenCalled();
  });

  it('is null when the field holds other text there', async () => {
    const el = textarea('Hello refinEd', 0);
    const d = deps({ execCommand: formExec });
    expect(await replaceInsertion(el, at(el), 'refined', 'raw', d)).toBeNull();
    expect(el.value).toBe('Hello refinEd');
  });

  it('never leaves the selection moved when it refuses', async () => {
    const el = textarea('other text here', 3);
    await replaceInsertion(el, at(el), 'refined', 'raw', deps({ execCommand: formExec }));
    expect([el.selectionStart, el.selectionEnd]).toEqual([3, 3]);
  });

  it('is null when the same text was typed before it, so the offsets still read true', async () => {
    const el = textarea('OK.OK.', 0);
    const d = deps({ execCommand: formExec });
    expect(await replaceInsertion(el, { start: 0, end: 3, length: 3 }, 'OK.', 'okay', d)).toBeNull();
    expect(el.value).toBe('OK.OK.');
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 0]);
  });

  it('is null when text was added after it', async () => {
    const el = textarea('refined more', 0);
    expect(await replaceInsertion(el, { start: 0, end: 7, length: 7 }, 'refined', 'raw', deps({ execCommand: formExec }))).toBeNull();
    expect(el.value).toBe('refined more');
  });

  describe('when the ladder leaves the field as it was', () => {
    it.each([
      ['clipboard'], ['failed'], ['unverified'],
    ])('collapses the caret to the end of the text on %s', async (outcome) => {
      const el = textarea('Hello refined there', 0);
      const insert = vi.fn(async () => outcome);
      expect(await replaceInsertion(el, at(el), 'refined', 'raw', { insertText: insert })).toBe(outcome);
      expect(insert).toHaveBeenCalledTimes(1);
      expect([el.selectionStart, el.selectionEnd]).toEqual([13, 13]);
    });

    it('does so with the real ladder, when a page refuses the text', async () => {
      const el = textarea('Hello refined there', 0);
      el.addEventListener('beforeinput', (event) => event.preventDefault());
      const d = deps({ execCommand: () => false });
      const outcome = await replaceInsertion(el, at(el), 'refined', 'raw', d);
      expect(outcome).not.toBe('inserted');
      expect(el.value).toBe('Hello refined there');
      expect([el.selectionStart, el.selectionEnd]).toEqual([13, 13]);
    });

    it('leaves the selection alone when the value did change', async () => {
      const el = textarea('Hello refined there', 0);
      const insert = vi.fn(async () => {
        el.value = 'Hello raw there';
        el.setSelectionRange(9, 9);
        return 'unverified';
      });
      await replaceInsertion(el, at(el), 'refined', 'raw', { insertText: insert });
      expect([el.selectionStart, el.selectionEnd]).toEqual([9, 9]);
    });

    it('leaves the selection alone on a verified outcome, whatever the value', async () => {
      const el = textarea('Hello refined there', 0);
      await replaceInsertion(el, at(el), 'refined', 'raw', { insertText: async () => 'inserted' });
      expect([el.selectionStart, el.selectionEnd]).toEqual([6, 13]);
    });

    it('leaves the caret after raw on an insert', async () => {
      const el = textarea('Hello refined there', 0);
      await replaceInsertion(el, at(el), 'refined', 'raw', deps({ execCommand: formExec }));
      expect(el.value).toBe('Hello raw there');
      expect([el.selectionStart, el.selectionEnd]).toEqual([9, 9]);
    });

    it('survives a field that lost its selection support meanwhile', async () => {
      const el = textarea('Hello refined there', 0);
      const insert = vi.fn(async () => 'clipboard');
      vi.spyOn(el, 'setSelectionRange').mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('InvalidStateError'); });
      expect(await replaceInsertion(el, at(el), 'refined', 'raw', { insertText: insert })).toBe('clipboard');
    });
  });

  it('is null for a field with no selection support', async () => {
    document.body.innerHTML = '<input id="mail" type="email" value="Hello refined">';
    const el = document.getElementById('mail');
    el.focus();
    expect(await replaceInsertion(el, at(el), 'refined', 'raw', deps({ execCommand: formExec }))).toBeNull();
    expect(el.value).toBe('Hello refined');
  });

  it('is null for a contenteditable, whatever it reads at the offsets', async () => {
    const el = editable('Hello refined');
    expect(await replaceInsertion(el, { start: 6, end: 13, length: 13 }, 'refined', 'raw', deps())).toBeNull();
    expect(el.textContent).toBe('Hello refined');
  });
});

describe('insertText with the default settle under fake timers', () => {
  it('resolves without advancing timers once the insert verifies', async () => {
    vi.useFakeTimers();
    const viaExec = textarea('Hi', 2);
    expect(await insertText(viaExec, ' there', deps({ execCommand: formExec, settle: undefined }))).toBe('inserted');
    const viaSetter = textarea('Hi', 2);
    expect(await insertText(viaSetter, ' there', deps({ settle: undefined }))).toBe('inserted');
    expect(viaSetter.value).toBe('Hi there');
  });

  it('gives up after about 100 ms of fake time when nothing changes', async () => {
    vi.useFakeTimers();
    const el = editable('Hi', 'contenteditable="true" data-lexical-editor="true"');
    const started = performance.now();
    let outcome = null;
    const pending = insertText(el, ' there', deps({ settle: undefined })).then((value) => { outcome = value; });
    for (let i = 0; i < 40 && outcome === null; i += 1) await vi.advanceTimersByTimeAsync(16);
    await pending;
    expect(outcome).toBe('clipboard');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(200);
  });
});

describe('copyText', () => {
  const denied = async () => { throw new Error('Document is not focused.'); };

  /** A clipboardData stand-in with DataTransfer's setData, getData and clearData. */
  function clipboardData() {
    const data = new Map();
    return {
      data,
      setData: (type, value) => data.set(type, value),
      getData: (type) => data.get(type) ?? '',
      clearData: (type) => (type === undefined ? data.clear() : data.delete(type)),
    };
  }

  /**
   * execCommand('copy') as Chrome runs it: without a user gesture it refuses and fires nothing;
   * otherwise a trusted, cancelable copy event goes to the focused element (or the body), and
   * the clipboard receives every type in the event's clipboardData when the event was
   * prevented, else the selection.
   */
  function chromeCopy(clipboard, { allowed = true } = {}) {
    return vi.fn((command) => {
      if (command !== 'copy' || !allowed) return false;
      const event = new Event('copy', { bubbles: true, cancelable: true, composed: true });
      event.clipboardData = clipboardData();
      trustedEvents.add(event);
      (document.activeElement ?? document.body).dispatchEvent(event);
      clipboard.data = event.defaultPrevented
        ? Object.fromEntries(event.clipboardData.data)
        : { 'text/plain': String(document.getSelection()) };
      clipboard.text = clipboard.data['text/plain'] ?? '';
      return true;
    });
  }

  /**
   * A page's capture listener that runs before VoiceType's: on the real copy event it
   * dispatches a copy event of its own with a clipboardData it can read, and records what it read.
   */
  function pageCopyDecoy({ stopReal }) {
    const seen = { read: null };
    const listener = (event) => {
      if (!isTrusted(event)) return;
      if (stopReal) {
        event.stopImmediatePropagation();
        event.preventDefault();
        event.clipboardData.setData('text/plain', 'page text');
      }
      const decoy = new Event('copy', { bubbles: true, cancelable: true, composed: true });
      decoy.clipboardData = clipboardData();
      document.body.dispatchEvent(decoy);
      seen.read = decoy.clipboardData.getData('text/plain');
    };
    window.addEventListener('copy', listener, true);
    seen.remove = () => window.removeEventListener('copy', listener, true);
    return seen;
  }

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { execCopy })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(execCopy).not.toHaveBeenCalled();
  });

  it('falls back to execCopy when navigator.clipboard is missing (plain http)', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { execCopy })).toBe(true);
    expect(execCopy).toHaveBeenCalledWith('hi');
    expect(await copyText('hi', { execCopy: () => false })).toBe(false);
  });

  it('a rejected clipboard write falls back to execCopy (a frame without clipboard-write)', async () => {
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { writeClipboard: denied, execCopy })).toBe(true);
    expect(execCopy).toHaveBeenCalledWith('hi');
  });

  it('a rejected clipboard write whose fallback also fails reports false', async () => {
    expect(await copyText('hi', { writeClipboard: denied, execCopy: () => false })).toBe(false);
    expect(await copyText('hi', { writeClipboard: denied, execCopy: () => { throw new Error('no copy'); } })).toBe(false);
  });

  it('a rejected navigator.clipboard.writeText falls back too', async () => {
    const writeText = vi.fn(async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); });
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const execCopy = vi.fn(() => true);
    expect(await copyText('hi', { execCopy })).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hi');
    expect(execCopy).toHaveBeenCalledWith('hi');
  });

  it('the copy fallback never moves focus', async () => {
    const el = editable('Hello world');
    el.focus();
    setCaret(el.firstChild, 0);
    document.getSelection().extend(el.firstChild, 5);
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const added = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) added.push(...record.addedNodes);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    expect(await copyText('copied text', { writeClipboard: denied, isTrusted })).toBe(true);
    for (const record of observer.takeRecords()) added.push(...record.addedNodes);
    observer.disconnect();

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(clipboard.text).toBe('copied text');
    expect(document.activeElement).toBe(el);
    const sel = document.getSelection();
    expect([sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset]).toEqual([el.firstChild, 0, el.firstChild, 5]);
    expect(focus).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it('the fallback copies through the copy event when the Clipboard API is missing', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    expect(await copyText('hi', { isTrusted })).toBe(true);
    expect(clipboard.text).toBe('hi');
  });

  it('by default the fallback counts only events whose isTrusted is true', async () => {
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    // jsdom marks every event a script dispatches as untrusted, the stand-in's included.
    expect(await copyText('hi', { writeClipboard: denied })).toBe(false);
    expect(clipboard.text).toBe('');
  });

  it('a copy event the page dispatches itself is ignored, and stopping the real one fails the copy', async () => {
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    const decoy = pageCopyDecoy({ stopReal: true });
    try {
      expect(await copyText('transcript', { writeClipboard: denied, isTrusted })).toBe(false);
    } finally {
      decoy.remove();
    }
    expect(decoy.read).toBe('');
    expect(clipboard.data).toEqual({ 'text/plain': 'page text' });
  });

  it('a copy event the page dispatches itself gets nothing while the real one copies', async () => {
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    const decoy = pageCopyDecoy({ stopReal: false });
    try {
      expect(await copyText('transcript', { writeClipboard: denied, isTrusted })).toBe(true);
    } finally {
      decoy.remove();
    }
    expect(decoy.read).toBe('');
    expect(clipboard.data).toEqual({ 'text/plain': 'transcript' });
  });

  it('clears what an earlier page copy listener set, so a rich paste gets only the text', async () => {
    const clipboard = {};
    document.execCommand = chromeCopy(clipboard);
    const attribution = (event) => {
      event.clipboardData.setData('text/html', '<b>page attribution</b>');
      event.clipboardData.setData('text/plain', 'page text');
    };
    window.addEventListener('copy', attribution, true);
    try {
      expect(await copyText('transcript', { writeClipboard: denied, isTrusted })).toBe(true);
    } finally {
      window.removeEventListener('copy', attribution, true);
    }
    expect(clipboard.data).toEqual({ 'text/plain': 'transcript' });
  });

  it('the fallback returns false when the copy listener never ran or execCommand refused', async () => {
    document.execCommand = vi.fn(() => true);
    expect(await copyText('hi', { writeClipboard: denied, isTrusted })).toBe(false);

    document.execCommand = chromeCopy({}, { allowed: false });
    expect(await copyText('hi', { writeClipboard: denied, isTrusted })).toBe(false);

    const clipboard = {};
    const copyThenRefuse = chromeCopy(clipboard);
    document.execCommand = vi.fn((command) => {
      copyThenRefuse(command);
      return false;
    });
    expect(await copyText('hi', { writeClipboard: denied, isTrusted })).toBe(false);
  });

  it('the copy event reaches no page listener that runs after VoiceType\'s, and the listener is gone afterwards', async () => {
    const page = vi.fn();
    document.addEventListener('copy', page);
    document.execCommand = chromeCopy({});
    expect(await copyText('hi', { writeClipboard: denied, isTrusted })).toBe(true);
    expect(page).not.toHaveBeenCalled();

    document.execCommand = vi.fn(() => { throw new Error('refused'); });
    expect(await copyText('hi', { writeClipboard: denied, isTrusted })).toBe(false);

    // The user's own copy afterwards is untouched.
    const later = new Event('copy', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(later);
    expect(page).toHaveBeenCalledTimes(1);
    expect(later.defaultPrevented).toBe(false);
    document.removeEventListener('copy', page);
  });

  describe('the time limit on the write', () => {
    /** With no user activation Chrome leaves writeText pending behind a permission prompt. */
    const pendingWrite = () => new Promise(() => {});

    it('a pending write gives way', async () => {
      vi.useFakeTimers();
      expect(WRITE_LIMIT_MS).toBe(1000);
      const execCopy = vi.fn(() => true);
      const settled = vi.fn();
      copyText('hi', { writeClipboard: pendingWrite, execCopy }).then(settled);
      await vi.advanceTimersByTimeAsync(WRITE_LIMIT_MS - 1);
      expect(execCopy).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(execCopy).toHaveBeenCalledWith('hi');
      expect(settled).toHaveBeenCalledWith(true);
    });

    it('a pending write with no exec path resolves false', async () => {
      vi.useFakeTimers();
      const settled = vi.fn();
      copyText('hi', { writeClipboard: pendingWrite, execCopy: () => false }).then(settled);
      await vi.advanceTimersByTimeAsync(WRITE_LIMIT_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(false);
    });

    it('a fast write clears its timer', async () => {
      vi.useFakeTimers();
      expect(await copyText('hi', { writeClipboard: async () => {}, execCopy: () => false })).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      expect(await copyText('hi', { writeClipboard: denied, execCopy: () => true })).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      [false, 'failed'],
      [true, 'clipboard'],
    ])('insertText on a clipboard-only host with a pending write: execCopy %s gives %s', async (works, outcome) => {
      vi.useFakeTimers();
      const [hostname] = CLIPBOARD_ONLY_HOSTS;
      const pending = insertText(textarea(), 'text', deps({ hostname, writeClipboard: pendingWrite, execCopy: () => works }));
      await vi.advanceTimersByTimeAsync(WRITE_LIMIT_MS);
      expect(await pending).toBe(outcome);
    });
  });

  it('insertText copies through the fallback when the page has no Clipboard API', async () => {
    const execCopy = vi.fn(() => true);
    expect(await insertText(null, 'text', deps({ writeClipboard: undefined, execCopy }))).toBe('clipboard');
    expect(execCopy).toHaveBeenCalledWith('text');
  });
});

/** Selects from one point to another, as a drag in the field would. */
function selectRange(startNode, startOffset, endNode = startNode, endOffset = startOffset) {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectedTextarea(value, start, end) {
  const el = textarea(value);
  el.setSelectionRange(start, end);
  return el;
}

function selectedEditable(html, start, end, attrs) {
  const el = editable(html, attrs);
  el.focus();
  selectRange(el.firstChild, start, el.firstChild, end);
  return el;
}

/**
 * A contenteditable selection from the start of its first text node to where a shape ends it. Each
 * end: what the selection holds of the field, its offsets, the end text node and how far into it.
 */
const FIRST_LI = (el) => el.querySelector('li').firstChild;
const FIRST_P = (el) => el.querySelector('p').firstChild;
const LAST_P = (el) => [...el.querySelectorAll('p')].at(-1);
const END_SHAPES = [
  ['a gap of a line break and two spaces in a list', '<ul>\n  <li>first line</li>\n  <li>second line</li>\n</ul>',
    FIRST_LI, (el) => [el.querySelectorAll('li')[1], 0], { text: 'first line', start: 3, end: 13 }],
  ['a gap of a line break and a tab', '<p>first line</p>\n\t<p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['a gap of a line break and two spaces', '<p>first line</p>\n  <p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['a gap of one space', '<p>first line</p> <p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['a gap of two line breaks', '<p>first line</p>\n\n<p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['a gap of a lone line break', '<p>first line</p>\n<p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['adjacent paragraphs', '<p>first line</p><p>second line</p>',
    FIRST_P, (el) => [LAST_P(el), 0], { text: 'first line', start: 0, end: 10 }],
  ['an end inside the gap', '<p>first line</p>\n  <p>second line</p>',
    FIRST_P, (el) => [el.childNodes[1], 2], { text: 'first line', start: 0, end: 10 }],
  ['an end at offset 0 of the next text', '<p>first line</p><p>second line</p>',
    FIRST_P, (el) => [LAST_P(el).firstChild, 0], { text: 'first line', start: 0, end: 10 }],
  ['an end in the leading whitespace of the next list item', '<ul><li>first line</li><li>\n    second\n  </li></ul>',
    FIRST_LI, (el) => [el.querySelectorAll('li')[1].firstChild, 3], { text: 'first line', start: 0, end: 10 }],
  ['an end in the leading whitespace of the next paragraph', '<p>first line</p><p>\n  second</p>',
    FIRST_P, (el) => [LAST_P(el).firstChild, 3], { text: 'first line', start: 0, end: 10 }],
  ['an end after the zero-width character leading the next paragraph', '<p>first line</p><p>\u200Bsecond</p>',
    FIRST_P, (el) => [LAST_P(el).firstChild, 1], { text: 'first line', start: 0, end: 10 }],
  ['a real trailing br', 'first line<br>second line',
    (el) => el.firstChild, (el) => [el, 2], { text: 'first line', start: 0, end: 10 }],
  ['a trailing image', 'first line<img alt="">',
    (el) => el.firstChild, (el) => [el, 2], { text: 'first line', start: 0, end: 10 }],
];

describe('the end of a contenteditable selection', () => {
  const selectShape = (html, from, to) => {
    const el = editable(html);
    el.focus();
    selectRange(from(el), 0, ...to(el));
    return el;
  };

  it.each(END_SHAPES)('stops at the last text before %s', (_, html, from, to, expected) => {
    expect(readSelection(selectShape(html, from, to))).toEqual(expected);
  });

  it.each(END_SHAPES)('a replacement ends there too before %s, and the rest of the field stays', async (_, html, from, to, { end }) => {
    const el = selectShape(html, from, to);
    const last = from(el);
    const after = el.textContent.slice(end);
    const ends = [];
    const exec = (text) => {
      const range = document.getSelection().getRangeAt(0);
      ends.push([range.endContainer, range.endOffset]);
      return editableExec(text);
    };
    const outcome = await insertText(el, 'edited', deps({ replacing: true, execCommand: exec }));
    expect(outcome).toBe('inserted');
    expect(ends).toEqual([[last, 10]]);
    expect(el.textContent.endsWith(`edited${after}`)).toBe(true);
  });

  it('a read leaves the selection where it was, a backward one included', () => {
    const el = selectShape('<p>first line</p>\n  <p>second line</p>', FIRST_P, (e) => [LAST_P(e), 0]);
    const sel = document.getSelection();
    sel.setBaseAndExtent(LAST_P(el), 0, FIRST_P(el), 0);
    readSelection(el);
    expect([sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset]).toEqual([LAST_P(el), 0, FIRST_P(el), 0]);
  });

  it('a read does not touch a selection already at its end', () => {
    const el = selectedEditable('hello world', 0, 5);
    const move = vi.spyOn(document.getSelection(), 'setBaseAndExtent');
    expect(readSelection(el).text).toBe('hello');
    expect(move).not.toHaveBeenCalled();
  });

  it('same selection after the end moved to that point', () => {
    const el = selectShape('<p>first line</p>\n  <p>second line</p>', FIRST_P, (e) => [LAST_P(e), 0]);
    const snapshot = readSelection(el);
    selectRange(FIRST_P(el), 0, FIRST_P(el), 10);
    expect(sameSelection(el, snapshot)).toBe(true);
  });

  it('spaces inside the last text node stay', () => {
    const el = selectShape('<p>first line  </p>\n<p>second line</p>', FIRST_P, (e) => [LAST_P(e), 0]);
    expect(readSelection(el)).toEqual({ text: 'first line  ', start: 0, end: 12 });
  });

  it('an end past the leading whitespace of a text node stays there', () => {
    const el = selectShape('<p>first line</p><p>\n  second</p>', FIRST_P, (e) => [LAST_P(e).firstChild, 5]);
    const end = LAST_P(el).firstChild;
    expect(readSelection(el)).toMatchObject({ start: 0, end: 15 });
    expect(document.getSelection().getRangeAt(0).endContainer).toBe(end);
  });

  it('a text node with spaces selected after its text keeps them, its start in the node', () => {
    const el = editable('<p>keep this  word</p>');
    el.focus();
    selectRange(FIRST_P(el), 5, FIRST_P(el), 11);
    expect(readSelection(el)).toEqual({ text: 'this  ', start: 5, end: 11 });
  });

  it('a line break in the last text node stays, in a preformatted field', () => {
    const el = editable('first line\nsecond line', 'contenteditable="true" style="white-space: pre-wrap"');
    el.focus();
    selectRange(el.firstChild, 0, el.firstChild, 11);
    expect(readSelection(el)).toEqual({ text: 'first line\n', start: 0, end: 11 });
  });

  it('a page node of zero-width characters is no text', () => {
    const el = selectShape('<p>first line</p><p>\u200B\uFEFF</p><p>second line</p>', FIRST_P, (e) => [LAST_P(e), 0]);
    expect(readSelection(el).text).toBe('first line');
  });

  it('a selection of nothing but whitespace nodes is none', () => {
    const el = editable('<p>\n</p><p>\t</p>');
    el.focus();
    selectRange(el.firstChild.firstChild, 0, el.lastChild.firstChild, 1);
    expect(readSelection(el)).toBeNull();
  });

  it('line breaks between its blocks stay in the text', () => {
    const el = editable('<p>one</p>\n<p>two</p>');
    el.focus();
    selectRange(FIRST_P(el), 0, LAST_P(el).firstChild, 3);
    vi.spyOn(Selection.prototype, 'toString').mockReturnValue('one\n\ntwo');
    expect(readSelection(el).text).toBe('one\n\ntwo');
  });
});

describe('readSelection', () => {
  it('reads a textarea', () => {
    expect(readSelection(selectedTextarea('hello world', 6, 11))).toEqual({ text: 'world', start: 6, end: 11 });
  });

  it('reads an input', () => {
    document.body.innerHTML = '<input id="in" type="text" value="hello world">';
    const el = document.getElementById('in');
    el.setSelectionRange(0, 5);
    expect(readSelection(el)).toEqual({ text: 'hello', start: 0, end: 5 });
  });

  it('an email input has no selection API, so no selection', () => {
    document.body.innerHTML = '<input id="in" type="email" value="a@example.com">';
    expect(readSelection(document.getElementById('in'))).toBeNull();
  });

  it('a collapsed caret is no selection', () => {
    expect(readSelection(textarea('hello', 2))).toBeNull();
    expect(readSelection(selectedEditable('hello', 2, 2))).toBeNull();
  });

  it('whitespace alone is no selection', () => {
    expect(readSelection(selectedTextarea('a \n\t b', 1, 5))).toBeNull();
    expect(readSelection(selectedTextarea('a ​﻿b', 1, 4))).toBeNull();
    expect(readSelection(selectedEditable('a   b', 1, 4))).toBeNull();
  });

  it('reads a contenteditable in text offsets', () => {
    expect(readSelection(selectedEditable('hello world', 6, 11))).toEqual({ text: 'world', start: 6, end: 11 });
  });

  it('counts the text offsets across nodes, as a splice does', () => {
    const el = editable('<p>one</p><p>two <b>three</b> four</p>');
    el.focus();
    selectRange(el.querySelector('b').firstChild, 1, el.lastChild.lastChild, 3);
    expect(readSelection(el)).toEqual({ text: 'hree fo', start: 8, end: 15 });
  });

  it('keeps the line breaks of a selection in a form field', () => {
    expect(readSelection(selectedTextarea('one\n\ntwo', 0, 5)).text).toBe('one\n\n');
  });

  it('reads a role=textbox that is no contenteditable', () => {
    document.body.innerHTML = '<div id="box" role="textbox">hello world</div>';
    const el = document.getElementById('box');
    selectRange(el.firstChild, 0, el.firstChild, 5);
    expect(readSelection(el)).toEqual({ text: 'hello', start: 0, end: 5 });
  });

  it('a selection outside the field is none of its own', () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">inside</div><p id="p">outside</p>';
    selectRange(document.getElementById('p').firstChild, 0, document.getElementById('p').firstChild, 7);
    expect(readSelection(document.getElementById('ce'))).toBeNull();
  });

  it('a selection reaching out of the field is none of its own', () => {
    document.body.innerHTML = '<div id="ce" contenteditable="true">inside</div><p id="p">outside</p>';
    const el = document.getElementById('ce');
    selectRange(el.firstChild, 2, document.getElementById('p').firstChild, 3);
    expect(readSelection(el)).toBeNull();
  });

  it('a field with no selection at all reads as none', () => {
    const el = editable('hello');
    expect(readSelection(el)).toBeNull();
  });

  it('Google Docs has no readable selection', () => {
    const el = selectedEditable('hello world', 0, 5);
    expect(readSelection(el, { hostname: [...CLIPBOARD_ONLY_HOSTS][0] })).toBeNull();
  });

  it('a page whose selection API throws reads as none', () => {
    const el = selectedEditable('hello world', 0, 5);
    vi.spyOn(document, 'getSelection').mockImplementation(() => { throw new Error('page'); });
    expect(readSelection(el)).toBeNull();
    vi.restoreAllMocks();
  });
});

describe('sameSelection', () => {
  it('true while nothing moved', () => {
    const el = selectedTextarea('hello world', 6, 11);
    expect(sameSelection(el, readSelection(el))).toBe(true);
    const ce = selectedEditable('hello world', 6, 11);
    expect(sameSelection(ce, readSelection(ce))).toBe(true);
  });

  it('false on moved offsets', () => {
    const el = selectedTextarea('hello hello', 0, 5);
    const snapshot = readSelection(el);
    el.setSelectionRange(6, 11);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false on a collapsed selection', () => {
    const el = selectedTextarea('hello world', 6, 11);
    const snapshot = readSelection(el);
    el.setSelectionRange(11, 11);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false on changed text at the same offsets, in a form field', () => {
    const el = selectedTextarea('hello world', 6, 11);
    const snapshot = readSelection(el);
    el.value = 'hello there';
    el.setSelectionRange(6, 11);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false on changed text at the same offsets, in a contenteditable', () => {
    const el = selectedEditable('hello world', 6, 11);
    const snapshot = readSelection(el);
    el.textContent = 'hello there';
    selectRange(el.firstChild, 6, el.firstChild, 11);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false on the same word elsewhere in a contenteditable', () => {
    const el = selectedEditable('word and word', 0, 4);
    const snapshot = readSelection(el);
    selectRange(el.firstChild, 9, el.firstChild, 13);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false when the text before the selection grew, the word unchanged', () => {
    const el = selectedEditable('word', 0, 4);
    const snapshot = readSelection(el);
    el.textContent = 'a word';
    selectRange(el.firstChild, 2, el.firstChild, 6);
    expect(sameSelection(el, snapshot)).toBe(false);
  });

  it('false on no snapshot', () => {
    expect(sameSelection(selectedTextarea('hello', 0, 5), null)).toBe(false);
  });
});

describe('insertText over a selection', () => {
  const replacing = (overrides) => deps({ replacing: true, ...overrides });
  /** No raw rung here, so a test can see every rung do nothing. */
  const FRAMEWORK = 'contenteditable="true" data-lexical-editor="true"';
  /** A rung that puts the text in front of the selection and leaves the selection in place. */
  const execKeepingSelection = (text) => {
    insertAtCaret(text);
    document.activeElement.dispatchEvent(trustedInput(text));
    return true;
  };

  it('replaces a selection in a form field', async () => {
    const el = selectedTextarea('hello world', 6, 11);
    expect(await insertText(el, 'there', replacing({ execCommand: formExec }))).toBe('inserted');
    expect(el.value).toBe('hello there');
  });

  it('keeps a contenteditable selection for the first rung when focus() moves it', async () => {
    const el = selectedEditable('hello world', 6, 11);
    el.focus = () => document.getSelection().collapse(el.firstChild, 0);
    expect(await insertText(el, 'there', replacing({ execCommand: editableExec }))).toBe('inserted');
    expect(el.textContent).toBe('hello there');
  });

  it('replaces a selection across paragraphs', async () => {
    const el = editable('<p>one two</p><p>three</p>');
    el.focus();
    selectRange(el.firstChild.firstChild, 4, el.lastChild.firstChild, 5);
    expect(await insertText(el, 'four', replacing({ execCommand: editableExec }))).toBe('inserted');
    expect(el.textContent).toBe('one four');
  });

  it('a replacement that is a substring of the selection is verified', async () => {
    const el = selectedTextarea('the quick fox', 4, 13);
    expect(await insertText(el, 'fox', replacing({ execCommand: formExec }))).toBe('inserted');
    expect(el.value).toBe('the fox');
    const ce = selectedEditable('the quick fox', 4, 13);
    expect(await insertText(ce, 'fox', replacing({ execCommand: editableExec }))).toBe('inserted');
    expect(ce.textContent).toBe('the fox');
  });

  it('a replacement repeating text already in the field is verified', async () => {
    const el = selectedTextarea('foo bar foo', 4, 7);
    expect(await insertText(el, 'foo', replacing({ execCommand: formExec }))).toBe('inserted');
    expect(el.value).toBe('foo foo foo');
    const ce = selectedEditable('foo bar foo', 4, 7);
    expect(await insertText(ce, 'foo', replacing({ execCommand: editableExec }))).toBe('inserted');
    expect(ce.textContent).toBe('foo foo foo');
  });

  it('a replacement equal to the selection counts when the rung ran', async () => {
    const el = selectedTextarea('hello world', 6, 11);
    expect(await insertText(el, 'world', replacing({ execCommand: formExec }))).toBe('inserted');
    expect(el.value).toBe('hello world');
  });

  it('a replacement that repeats text is not found where it already was', async () => {
    const el = selectedEditable('foo bar foo', 4, 7, FRAMEWORK);
    expect(await insertText(el, 'foo', replacing())).toBe('clipboard');
    expect(el.textContent).toBe('foo bar foo');
  });

  it('a substring that no rung placed is not read as placed', async () => {
    const el = selectedEditable('the quick fox', 4, 13, FRAMEWORK);
    expect(await insertText(el, 'fox', replacing())).toBe('clipboard');
    expect(el.textContent).toBe('the quick fox');
  });

  it('a change of whitespace alone that no rung made is not read as made', async () => {
    const el = selectedEditable('hello world', 0, 11, FRAMEWORK);
    expect(await insertText(el, 'hello\nworld', replacing())).toBe('clipboard');
    expect(el.textContent).toBe('hello world');
  });

  it('a change of whitespace alone that the setter made in a form field is verified', async () => {
    const el = selectedTextarea('hello world', 0, 11);
    expect(await insertText(el, 'hello\nworld', replacing())).toBe('inserted');
    expect(el.value).toBe('hello\nworld');
  });

  it('text set beside a selection left in place is no replacement', async () => {
    const el = selectedEditable('hello world', 6, 11);
    const t = replacing({ execCommand: execKeepingSelection });
    expect(await insertText(el, 'there', t)).toBe('unverified');
    expect(t.writeClipboard).toHaveBeenCalledWith('there');
  });

  it('a dictation over a selection still reads the same rung as an insert, as in 3.1', async () => {
    const el = selectedEditable('hello world', 6, 11);
    const t = deps({ execCommand: execKeepingSelection });
    expect(await insertText(el, 'there', t)).toBe('inserted');
    expect(t.writeClipboard).not.toHaveBeenCalled();
  });

  it('a page that rewrites what it takes is unverified, with the text copied', async () => {
    const el = selectedTextarea('hello world', 6, 11);
    el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
    const t = replacing({ execCommand: formExec });
    expect(await insertText(el, 'there', t)).toBe('unverified');
    expect(t.writeClipboard).toHaveBeenCalledWith('there');
    expect(el.value).toBe('HELLO THERE');
  });

  describe('a selection that moves between rungs', () => {
    /** A settle that gives the page its moment: on the first wait the selection goes elsewhere. */
    function movingOnce(move) {
      let moved = false;
      return async (check) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!moved) {
          moved = true;
          move();
        }
        return check();
      };
    }
    const MORE = 'keep this word and more'.indexOf('more');

    it('ends the ladder at the clipboard before exec, on the paste-first path', async () => {
      const el = selectedEditable('keep this word and more', 5, 9);
      const t = replacing({
        execCommand: vi.fn(editableExec),
        createPasteEvent: fakePasteEvent,
        settle: movingOnce(() => selectRange(el.firstChild, MORE, el.firstChild, MORE + 4)),
      });
      expect(await insertText(el, 'edited one\nedited two', t)).toBe('clipboard');
      expect(t.execCommand).not.toHaveBeenCalled();
      expect(el.textContent).toBe('keep this word and more');
      expect(t.writeClipboard).toHaveBeenCalledWith('edited one\nedited two');
    });

    it('ends the ladder before the raw rung', async () => {
      const el = selectedEditable('keep this word and more', 5, 9);
      const t = replacing({ settle: movingOnce(() => selectRange(el.firstChild, MORE, el.firstChild, MORE + 4)) });
      expect(await insertText(el, 'there', t)).toBe('clipboard');
      expect(el.textContent).toBe('keep this word and more');
      expect(t.writeClipboard).toHaveBeenCalledWith('there');
    });

    it('ends the ladder before the beforeinput rung', async () => {
      const el = selectedEditable('keep this word and more', 5, 9);
      const dispatch = vi.fn((target, event) => target.dispatchEvent(event));
      const t = replacing({
        dispatch,
        createPasteEvent: fakePasteEvent,
        settle: movingOnce(() => selectRange(el.firstChild, MORE, el.firstChild, MORE + 4)),
      });
      expect(await insertText(el, 'there', t)).toBe('clipboard');
      expect(dispatch.mock.calls.map(([, event]) => event.type)).toEqual(['paste']);
    });

    it('ends the ladder when the selection collapses', async () => {
      const el = selectedEditable('keep this word and more', 5, 9);
      const t = replacing({ settle: movingOnce(() => setCaret(el.firstChild, 2)) });
      expect(await insertText(el, 'there', t)).toBe('clipboard');
      expect(el.textContent).toBe('keep this word and more');
    });

    it('ends the ladder in a form field before the setter rung', async () => {
      const el = selectedTextarea('keep this word and more', 5, 9);
      const t = replacing({
        execCommand: vi.fn(() => true),
        settle: movingOnce(() => el.setSelectionRange(MORE, MORE + 4)),
      });
      expect(await insertText(el, 'there', t)).toBe('clipboard');
      expect(el.value).toBe('keep this word and more');
      expect(t.writeClipboard).toHaveBeenCalledWith('there');
    });

    it('text the page changed under the same offsets stops at that rung, unverified and copied', async () => {
      const el = selectedTextarea('keep this word', 5, 9);
      const t = replacing({
        execCommand: vi.fn(() => true),
        settle: movingOnce(() => {
          el.value = 'keep that word';
          el.setSelectionRange(5, 9);
        }),
      });
      expect(await insertText(el, 'there', t)).toBe('unverified');
      expect(el.value).toBe('keep that word');
      expect(t.writeClipboard).toHaveBeenCalledWith('there');
    });

    it('a selection that stays lets every rung run', async () => {
      const el = selectedEditable('keep this word', 5, 9);
      const t = replacing({ execCommand: vi.fn(editableExec), createPasteEvent: fakePasteEvent });
      expect(await insertText(el, 'edited one\nedited two', t)).toBe('inserted');
      expect(t.execCommand).toHaveBeenCalledTimes(1);
      expect(el.textContent).toBe('keep edited one\nedited two word');
    });

    it('a dictation run is untouched: the next rung writes at the live selection, as in 3.1', async () => {
      const el = selectedEditable('keep this word and more', 5, 9);
      const t = deps({
        execCommand: vi.fn(editableExec),
        createPasteEvent: fakePasteEvent,
        settle: movingOnce(() => selectRange(el.firstChild, MORE, el.firstChild, MORE + 4)),
      });
      expect(await insertText(el, 'edited one\nedited two', t)).toBe('inserted');
      expect(t.execCommand).toHaveBeenCalledTimes(1);
      expect(el.textContent).toBe('keep this word and edited one\nedited two');
    });
  });

  it('a raw rung replaces a selection in a plain contenteditable', async () => {
    const el = selectedEditable('hello world', 6, 11);
    expect(await insertText(el, 'there', replacing())).toBe('inserted');
    expect(el.textContent).toBe('hello there');
  });
});
