import { describe, it, expect, vi } from 'vitest';
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
    // Scroll events do not bubble; only a capture listener on the window sees a container scroll.
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
