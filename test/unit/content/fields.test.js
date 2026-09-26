// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { isValidInput, deepActiveElement, TEXT_INPUT_TYPES } from '../../../src/content/fields.js';

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
  it('accepts contenteditable and role=textbox, rejects plain elements and null', () => {
    expect(isValidInput(make('<div contenteditable="true"></div>'))).toBe(true);
    expect(isValidInput(make('<div role="textbox"></div>'))).toBe(true);
    expect(isValidInput(make('<div></div>'))).toBe(false);
    expect(isValidInput(null)).toBe(false);
    expect(isValidInput(document.createTextNode('x'))).toBe(false);
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
