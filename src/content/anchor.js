// Keeps the pill attached to its field: any scroll (including inside nested containers),
// window resize or field resize schedules one callback on the next animation frame.

/**
 * @param {Element} el the field the pill is anchored to
 * @param {() => void} onChange called at most once per animation frame
 * @param {{ win?: Window }} [options]
 * @returns {() => void} stops watching and cancels a pending frame
 */
export function watchAnchor(el, onChange, { win = window } = {}) {
  let frame = null;
  let stopped = false;
  const schedule = () => {
    if (stopped || frame !== null) return;
    frame = win.requestAnimationFrame(() => {
      frame = null;
      if (!stopped) onChange();
    });
  };
  // Scroll events do not bubble; a capture listener on the window sees every container scroll.
  const scrollOptions = { capture: true, passive: true };
  win.addEventListener('scroll', schedule, scrollOptions);
  win.addEventListener('resize', schedule);
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  observer?.observe(el);

  return () => {
    if (stopped) return;
    stopped = true;
    win.removeEventListener('scroll', schedule, scrollOptions);
    win.removeEventListener('resize', schedule);
    observer?.disconnect();
    if (frame !== null) {
      win.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
