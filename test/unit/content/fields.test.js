// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  isValidInput, isPasswordField, isEditableElement, isFrameworkEditor, deepActiveElement, TEXT_INPUT_TYPES,
} from '../../../src/content/fields.js';
import { isPasteFirstEditor, PASTE_FIRST_EDITOR_SELECTOR } from '../../../src/content/fields.js';

function make(html) {
  document.body.innerHTML = html;
  return document.body.firstElementChild;
}

describe('isValidInput', () => {
  it('accepts textareas and text-like inputs', () => {
    expect(isValidInput(make('<textarea></textarea>'))).toBe(true);
    for (const type of TEXT_INPUT_TYPES) expect(isValidInput(make(`<input type="${type}">`)), type).toBe(true);
    expect(isValidInput(make('<input>'))).toBe(true);
  });
  it('rejects password, number, checkbox, disabled and readonly fields', () => {
    expect(isValidInput(make('<input type="password">'))).toBe(false);
    expect(isValidInput(make('<input type="number">'))).toBe(false);
    expect(isValidInput(make('<input type="checkbox">'))).toBe(false);
    expect(isValidInput(make('<input type="text" disabled>'))).toBe(false);
    expect(isValidInput(make('<textarea readonly></textarea>'))).toBe(false);
  });
  it('reads el.type, so unknown types count as text and the attribute case does not matter', () => {
    expect(isValidInput(make('<input type="bogus">'))).toBe(true);
    expect(isValidInput(make('<input type="PASSWORD">'))).toBe(false);
    expect(isValidInput(make('<input type="Email">'))).toBe(true);
  });
  it('rejects inputs whose autocomplete ends in -password (revealed password fields)', () => {
    expect(isValidInput(make('<input type="text" autocomplete="current-password">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="new-password">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="section-login current-password webauthn">'))).toBe(false);
    expect(isValidInput(make('<input type="text" autocomplete="username">'))).toBe(true);
    expect(isValidInput(make('<input type="text" autocomplete="off">'))).toBe(true);
  });
  it('accepts contenteditable and role=textbox, rejects plain elements and null', () => {
    expect(isValidInput(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isValidInput(make('<div role="textbox"></div>'))).toBe(true);
    expect(isValidInput(make('<div></div>'))).toBe(false);
    expect(isValidInput(null)).toBe(false);
    expect(isValidInput(document.createTextNode('x'))).toBe(false);
  });
});

describe('isPasswordField', () => {
  it('is true for password inputs, whatever the attribute case', () => {
    expect(isPasswordField(make('<input type="password">'))).toBe(true);
    expect(isPasswordField(make('<input type="PASSWORD">'))).toBe(true);
  });
  it('is true for inputs with an autocomplete token ending in -password (revealed password fields)', () => {
    expect(isPasswordField(make('<input type="text" autocomplete="current-password">'))).toBe(true);
    expect(isPasswordField(make('<input type="text" autocomplete="new-password">'))).toBe(true);
    expect(isPasswordField(make('<input type="text" autocomplete="section-login current-password webauthn">'))).toBe(true);
    expect(isPasswordField(make('<input autocomplete="NEW-PASSWORD">'))).toBe(true);
  });
  it('is false for other inputs, textareas, editables, text nodes and null', () => {
    expect(isPasswordField(make('<input type="text">'))).toBe(false);
    expect(isPasswordField(make('<input type="text" autocomplete="username">'))).toBe(false);
    expect(isPasswordField(make('<input type="text" autocomplete="off">'))).toBe(false);
    expect(isPasswordField(make('<textarea autocomplete="current-password"></textarea>'))).toBe(false);
    expect(isPasswordField(make('<div contenteditable="true"></div>'))).toBe(false);
    expect(isPasswordField(document.createTextNode('x'))).toBe(false);
    expect(isPasswordField(null)).toBe(false);
  });
  it('isValidInput rejects every password field', () => {
    const cases = [
      '<input type="password">',
      '<input type="text" autocomplete="current-password">',
      '<input type="email" autocomplete="new-password">',
    ];
    for (const html of cases) {
      const el = make(html);
      expect(isPasswordField(el), html).toBe(true);
      expect(isValidInput(el), html).toBe(false);
    }
  });
});

describe('isEditableElement', () => {
  it("accepts contenteditable '' and 'plaintext-only', rejects 'false'", () => {
    expect(isEditableElement(make('<div contenteditable=""></div>'))).toBe(true);
    expect(isEditableElement(make('<div contenteditable="plaintext-only"></div>'))).toBe(true);
    expect(isEditableElement(make('<div contenteditable="false"></div>'))).toBe(false);
    expect(isValidInput(make('<div contenteditable=""></div>'))).toBe(true);
    expect(isValidInput(make('<div contenteditable="plaintext-only"></div>'))).toBe(true);
  });
});

describe('isFrameworkEditor', () => {
  it('recognises each editor marker on the element itself', () => {
    const roots = [
      '<div contenteditable="true" data-lexical-editor="true"></div>',
      '<div contenteditable="true" class="ProseMirror"></div>',
      '<div contenteditable="true" data-slate-editor="true"></div>',
      '<div contenteditable="true" class="ql-editor"></div>',
      '<div contenteditable="true" data-contents="true"></div>',
      '<div contenteditable="true" class="cm-content"></div>',
    ];
    for (const html of roots) expect(isFrameworkEditor(make(html)), html).toBe(true);
  });
  it('recognises a marker on an ancestor', () => {
    const root = make('<div class="ProseMirror" contenteditable="true"><p><span id="inner">x</span></p></div>');
    expect(isFrameworkEditor(root.querySelector('#inner'))).toBe(true);
  });
  it('recognises the Draft.js contenteditable, whose data-contents sits on a child', () => {
    make('<div class="DraftEditor-root"><div class="DraftEditor-editorContainer">'
      + '<div id="ce" class="public-DraftEditor-content" contenteditable="true"><div data-contents="true"></div></div>'
      + '</div></div>');
    expect(isFrameworkEditor(document.getElementById('ce'))).toBe(true);
  });
  it('is false for plain editables, form fields, text nodes and null', () => {
    expect(isFrameworkEditor(make('<div contenteditable="true"><p>Hi</p></div>'))).toBe(false);
    expect(isFrameworkEditor(make('<textarea></textarea>'))).toBe(false);
    expect(isFrameworkEditor(document.createTextNode('x'))).toBe(false);
    expect(isFrameworkEditor(null)).toBe(false);
  });
});

describe('isPasteFirstEditor', () => {
  it('selects Slate editors', () => {
    expect(PASTE_FIRST_EDITOR_SELECTOR).toBe('[data-slate-editor]');
  });
  it('is true for a Slate root and for an element inside it', () => {
    const root = make('<div contenteditable="true" data-slate-editor="true">'
      + '<p data-slate-node="element"><span id="leaf" data-slate-string="true">Hi</span></p></div>');
    expect(isPasteFirstEditor(root)).toBe(true);
    expect(isPasteFirstEditor(root.querySelector('#leaf'))).toBe(true);
    expect(isFrameworkEditor(root)).toBe(true);
  });
  it('is false for other framework editors, plain editables, form fields, text nodes and null', () => {
    const others = [
      '<div contenteditable="true" data-lexical-editor="true"></div>',
      '<div contenteditable="true" class="ProseMirror"></div>',
      '<div contenteditable="true" class="ql-editor"></div>',
      '<div contenteditable="true" data-contents="true"></div>',
      '<div contenteditable="true" class="cm-content"></div>',
      '<div contenteditable="true"><p>Hi</p></div>',
      '<textarea></textarea>',
    ];
    for (const html of others) expect(isPasteFirstEditor(make(html)), html).toBe(false);
    expect(isPasteFirstEditor(document.createTextNode('x'))).toBe(false);
    expect(isPasteFirstEditor(null)).toBe(false);
  });
});

describe('deepActiveElement', () => {
  it('descends into open shadow roots', () => {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<input id="inner" type="text">';
    root.getElementById('inner').focus();
    expect(deepActiveElement()).toBe(root.getElementById('inner'));
  });
  it('returns the light DOM active element otherwise', () => {
    document.body.innerHTML = '<textarea id="ta"></textarea>';
    document.getElementById('ta').focus();
    expect(deepActiveElement()).toBe(document.getElementById('ta'));
  });
});
