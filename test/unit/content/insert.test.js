// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  insertText, copyText, readValue, normalizeForCompare, CLIPBOARD_ONLY_HOSTS,
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

  it('insertText copies through the fallback when the page has no Clipboard API', async () => {
    const execCopy = vi.fn(() => true);
    expect(await insertText(null, 'text', deps({ writeClipboard: undefined, execCopy }))).toBe('clipboard');
    expect(execCopy).toHaveBeenCalledWith('text');
  });
});
