// Watches whether the indicator is really in sight, for a pill with an onSight handler.

/** How often the browser may report on sight; visibility tracking refuses less than 100 ms. */
export const SIGHT_DELAY_MS = 100;

/**
 * @param {{ doc: Document, onSight: (seen: boolean) => void }} options onSight gets changes only
 * @returns {{ sync(target: HTMLElement|null): void, disconnect(): void }} sync: watch this target, or nothing
 */
export function createSightWatcher({ doc, onSight }) {
  /** @type {IntersectionObserver|null} */
  let observer = null;
  /** @type {HTMLElement|null} */
  let watched = null;
  let seen = true;

  /** @param {IntersectionObserverEntry[]} entries */
  const onEntries = (entries) => {
    const entry = entries.at(-1);
    // isVisible: a transparent, hidden or covered frame is in the viewport, and still out of sight.
    const now = entry.isIntersecting && entry.isVisible !== false;
    if (now === seen) return;
    seen = now;
    onSight(now);
  };

  return {
    sync(target) {
      if (target === watched) return;
      watched = target;
      observer?.disconnect();
      observer = null;
      if (!target) {
        seen = true;
        return;
      }
      const win = doc.defaultView;
      observer = new win.IntersectionObserver(onEntries, {
        trackVisibility: true,
        delay: SIGHT_DELAY_MS,
      });
      observer.observe(target);
    },
    disconnect() {
      observer?.disconnect();
    },
  };
}
