// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  isValidInput, isEditableElement, isFrameworkEditor, deepActiveElement, TEXT_INPUT_TYPES,
} from '../../../src/content/fields.js';

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
