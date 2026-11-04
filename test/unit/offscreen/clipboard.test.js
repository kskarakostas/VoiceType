// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard } from '../../../src/offscreen/clipboard.js';

function copyEvent() {
  const event = new Event('copy', { bubbles: true, cancelable: true });
  event.clipboardData = { setData: vi.fn() };
  return event;
}

/** jsdom has no execCommand. This one acts as Chrome does: it fires `copy`, then reports true. */
function stubExecCommand(impl) {
  const events = [];
  document.execCommand = vi.fn(impl ?? (() => {
    const event = copyEvent();
    events.push(event);
    document.dispatchEvent(event);
    return true;
  }));
  return { execCommand: document.execCommand, events };
}

afterEach(() => { delete document.execCommand; });

describe('copyToClipboard', () => {
  it.each([
    ['multi-line Greek', 'Καλημέρα\nline two'],
    ['edge spaces', '  spaces  '],
    ['200,000 characters', 'x'.repeat(200_000)],
  ])('supplies %s exactly', (_label, text) => {
    const { execCommand, events } = stubExecCommand();
    expect(copyToClipboard(text, document)).toBe(true);
    expect(execCommand.mock.calls).toEqual([['copy']]);
    expect(events[0].clipboardData.setData.mock.calls).toEqual([['text/plain', text]]);
  });

  it('prevents the default copy and keeps the event from any other listener', () => {
    const { events } = stubExecCommand();
    const other = vi.fn();
    document.addEventListener('copy', other);
    expect(copyToClipboard('text', document)).toBe(true);
    document.removeEventListener('copy', other);
    expect(events[0].defaultPrevented).toBe(true);
    expect(other).not.toHaveBeenCalled();
  });

  it('removes its listener after a copy', () => {
    stubExecCommand();
    copyToClipboard('text', document);
    const second = copyEvent();
    document.dispatchEvent(second);
    expect(second.clipboardData.setData).not.toHaveBeenCalled();
    expect(second.defaultPrevented).toBe(false);
  });

  it('adds no element and leaves the selection alone', () => {
    stubExecCommand();
    const nodes = document.querySelectorAll('*').length;
    const selection = vi.spyOn(document, 'getSelection');
    copyToClipboard('text', document);
    expect(document.querySelectorAll('*').length).toBe(nodes);
    expect(selection).not.toHaveBeenCalled();
    selection.mockRestore();
  });

  it('is false when the command refuses, even after the listener ran; the listener is gone', () => {
    const { execCommand } = stubExecCommand(() => {
      document.dispatchEvent(copyEvent());
      return false;
    });
    expect(copyToClipboard('text', document)).toBe(false);
    expect(execCommand).toHaveBeenCalledTimes(1);
    const second = copyEvent();
    document.dispatchEvent(second);
    expect(second.clipboardData.setData).not.toHaveBeenCalled();
  });

  it('is false when the command throws; the listener is gone', () => {
    stubExecCommand(() => { throw new Error('not allowed'); });
    expect(copyToClipboard('text', document)).toBe(false);
    const second = copyEvent();
    document.dispatchEvent(second);
    expect(second.clipboardData.setData).not.toHaveBeenCalled();
  });

  it('is false when the command reports true with no copy event: that wrote nothing', () => {
    stubExecCommand(() => true);
    expect(copyToClipboard('text', document)).toBe(false);
  });

  it.each([[''], [undefined], [null], [7], [{ text: 'x' }], [['x']]])('refuses %j with no command', (text) => {
    const { execCommand } = stubExecCommand();
    expect(copyToClipboard(text, document)).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
