// The interval that keeps a pill with something to show on top.

/** How often a pill with something to show goes back on top: a page gives no event when it opens a dialog. */
export const RAISE_MS = 250;

/**
 * @param {{ raise: () => void }} options
 * @returns {{ readonly running: boolean, start(): void, stop(): void }} start also raises once; stop only ends the interval
 */
export function createRaiser({ raise }) {
  let timer = null;
  return {
    get running() {
      return timer !== null;
    },
    start() {
      // Timer first: showPopover() runs page listeners, and one that comes back here must find it set.
      timer = setInterval(raise, RAISE_MS);
      raise();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
