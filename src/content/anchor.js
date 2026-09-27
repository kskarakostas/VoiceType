// Keeps the pill attached to its field: any scroll (including inside nested containers and
// shadow roots), window resize or field resize schedules one callback on the next animation frame.

const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * Every shadow root between the field and its document, following slot assignment so a
 * light-DOM field slotted into a component's shadow tree finds that tree's root.
 * @param {Node} el
 * @returns {ShadowRoot[]}
 */
function shadowRootsAbove(el) {
  const roots = [];
  let node = el;
  while (node && node.nodeType !== DOCUMENT_NODE) {
    node = node.assignedSlot ?? node.parentNode;
    // Only a ShadowRoot is a fragment with a host (a link's `host` is its URL's host string).
    if (node?.nodeType === DOCUMENT_FRAGMENT_NODE && node.host) {
      roots.push(node);
      node = node.host;
    }
  }
  return roots;
}

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
  // Scroll events neither bubble nor cross shadow boundaries: a capture listener on the window
  // sees every light-DOM container scroll, one on each shadow root above the field the rest.
  const scrollOptions = { capture: true, passive: true };
  const shadowRoots = shadowRootsAbove(el);
  win.addEventListener('scroll', schedule, scrollOptions);
  for (const root of shadowRoots) root.addEventListener('scroll', schedule, scrollOptions);
  win.addEventListener('resize', schedule);
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  observer?.observe(el);

  return () => {
    if (stopped) return;
    stopped = true;
    win.removeEventListener('scroll', schedule, scrollOptions);
    for (const root of shadowRoots) root.removeEventListener('scroll', schedule, scrollOptions);
    win.removeEventListener('resize', schedule);
    observer?.disconnect();
    if (frame !== null) {
      win.cancelAnimationFrame(frame);
      frame = null;
    }
  };
}
