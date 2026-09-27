// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { watchAnchor } from '../../../src/content/anchor.js';

const captureOf = (options) => (typeof options === 'object' ? Boolean(options?.capture) : Boolean(options));

/** A window stand-in with listener, animation frame and ResizeObserver bookkeeping. */
function fakeWin({ resizeObserver = true } = {}) {
  const listeners = [];
  const frames = new Map();
  const observers = [];
  let nextFrame = 1;
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      this.disconnected = false;
      observers.push(this);
    }
    observe(el) { this.targets.push(el); }
    disconnect() { this.disconnected = true; }
  }
  const win = {
    addEventListener: vi.fn((type, fn, options) => listeners.push({ type, fn, options })),
    // Like the DOM: a listener is identified by type, callback and capture flag.
    removeEventListener: vi.fn((type, fn, options) => {
      const index = listeners.findIndex((l) => l.type === type && l.fn === fn && captureOf(l.options) === captureOf(options));
      if (index !== -1) listeners.splice(index, 1);
    }),
    requestAnimationFrame: vi.fn((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    }),
    cancelAnimationFrame: vi.fn((id) => frames.delete(id)),
  };
  if (resizeObserver) win.ResizeObserver = FakeResizeObserver;
  return {
    win,
    listeners,
    observers,
    frames,
    fire(type) {
      for (const l of listeners.filter((entry) => entry.type === type)) l.fn({ type });
    },
    flushFrames() {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(16);
    },
  };
}

const el = { id: 'field' };

describe('watchAnchor', () => {
  it('listens for scroll (capture, passive) and resize on the window and observes the element', () => {
    const fake = fakeWin();
    watchAnchor(el, () => {}, { win: fake.win });
    expect(fake.listeners.map(({ type, options }) => [type, options])).toEqual([
      ['scroll', { capture: true, passive: true }],
      ['resize', undefined],
    ]);
    expect(fake.observers).toHaveLength(1);
    expect(fake.observers[0].targets).toEqual([el]);
  });

  it('spec 6.3: a scroll inside a nested container reaches the capture listener and repositions', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    watchAnchor(el, onChange, { win: fake.win });
    // Scroll events do not bubble; only a capture listener on the window sees a light-DOM container scroll.
    expect(fake.listeners.find((l) => l.type === 'scroll').options.capture).toBe(true);
    fake.fire('scroll');
    expect(onChange).not.toHaveBeenCalled();
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('coalesces scroll, resize and resize-observer signals into one callback per frame', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    watchAnchor(el, onChange, { win: fake.win });
    fake.fire('scroll');
    fake.fire('scroll');
    fake.fire('resize');
    fake.observers[0].callback([]);
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    fake.fire('resize');
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it('works without ResizeObserver', () => {
    const fake = fakeWin({ resizeObserver: false });
    const onChange = vi.fn();
    const stop = watchAnchor(el, onChange, { win: fake.win });
    fake.fire('resize');
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
  });

  it('the returned function removes every listener, disconnects the observer and cancels a pending frame', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const stop = watchAnchor(el, onChange, { win: fake.win });
    fake.fire('scroll');
    const pending = [...fake.frames.keys()][0];
    stop();
    expect(fake.listeners).toEqual([]);
    expect(fake.observers[0].disconnected).toBe(true);
    expect(fake.win.cancelAnimationFrame).toHaveBeenCalledWith(pending);
    expect(fake.frames.size).toBe(0);
    fake.observers[0].callback([]);
    fake.flushFrames();
    expect(onChange).not.toHaveBeenCalled();
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
  });

  it('stopping twice is harmless', () => {
    const fake = fakeWin();
    const stop = watchAnchor(el, () => {}, { win: fake.win });
    stop();
    expect(() => stop()).not.toThrow();
    expect(fake.win.cancelAnimationFrame).not.toHaveBeenCalled();
  });
});

/** An open shadow root on a new host in `parent`, holding a scrolling container. */
function shadowScroller(parent = document.body) {
  const host = document.createElement('div');
  parent.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const scroller = document.createElement('div');
  root.append(scroller);
  return { host, root, scroller };
}

// Scroll events are not composed: one inside a shadow tree stops at its shadow root and
// never reaches the window, so these dispatch real events through jsdom's shadow DOM.
const scroll = (target) => target.dispatchEvent(new Event('scroll'));

describe('watchAnchor inside shadow roots', () => {
  afterEach(() => document.body.replaceChildren());

  it('spec 6.3: follows a scroll inside the open shadow root holding the field, one callback per frame', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const { scroller } = shadowScroller();
    const field = document.createElement('textarea');
    scroller.append(field);
    watchAnchor(field, onChange, { win: fake.win });
    scroll(scroller);
    scroll(scroller);
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
    fake.fire('scroll');
    expect(fake.win.requestAnimationFrame).toHaveBeenCalledTimes(1);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
    scroll(scroller);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('registers on the shadow root whose scroller a light-DOM field is slotted into', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const { host, root, scroller } = shadowScroller();
    const slot = document.createElement('slot');
    scroller.append(slot);
    const field = document.createElement('input');
    host.append(field);
    expect(field.assignedSlot).toBe(slot);
    const add = vi.spyOn(root, 'addEventListener');
    watchAnchor(field, onChange, { win: fake.win });
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('scroll', expect.any(Function), { capture: true, passive: true });
    scroll(scroller);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('continues from each host, and stop removes every shadow-root listener with the same options', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const outer = shadowScroller();
    const inner = shadowScroller(outer.scroller);
    const field = document.createElement('textarea');
    inner.scroller.append(field);
    const roots = [inner.root, outer.root];
    const adds = roots.map((root) => vi.spyOn(root, 'addEventListener'));
    const removes = roots.map((root) => vi.spyOn(root, 'removeEventListener'));
    const stop = watchAnchor(field, onChange, { win: fake.win });
    scroll(inner.scroller);
    fake.flushFrames();
    scroll(outer.scroller);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    roots.forEach((root, i) => {
      expect(adds[i]).toHaveBeenCalledTimes(1);
      const [type, listener, options] = adds[i].mock.calls[0];
      expect(removes[i]).toHaveBeenCalledTimes(1);
      expect(removes[i]).toHaveBeenCalledWith(type, listener, options);
      expect(removes[i].mock.calls[0][2]).toBe(options);
    });
  });

  it('walks past a link ancestor, whose host is a URL string, to the shadow root above it', () => {
    const fake = fakeWin();
    const onChange = vi.fn();
    const { scroller } = shadowScroller();
    const link = document.createElement('a');
    link.href = 'https://example.com/';
    scroller.append(link);
    const field = document.createElement('span');
    field.contentEditable = 'true';
    link.append(field);
    watchAnchor(field, onChange, { win: fake.win });
    scroll(scroller);
    fake.flushFrames();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
