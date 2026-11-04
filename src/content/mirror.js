// The indicator frame 0 shows for a recording in a subframe out of sight: a frame cannot draw
// outside itself. A second Pill, so frame 0's own pill keeps working beside it. onChange tells
// frame 0 when the indicator comes and goes, as two hosts cannot see each other.
import { PROCESSING_TIMEOUT_MS } from './controller.js';

/**
 * @param {{
 *   makePill: () => import('./pill.js').Pill,
 *   onChange: (up: boolean) => void,
 *   setTimeout: (fn: () => void, ms: number) => any,
 *   clearTimeout: (id: any) => void,
 * }} deps
 */
export function createMirror({ makePill, onChange, setTimeout, clearTimeout }) {
  /** @type {import('./pill.js').Pill|null} */
  let pill = null;
  let timer = null;

  function destroy() {
    clearTimeout(timer);
    timer = null;
    if (!pill) return;
    pill.destroy();
    pill = null;
    onChange(false);
  }

  /** The worker sends levels while recording: silence this long means it stopped or restarted. */
  function arm() {
    clearTimeout(timer);
    timer = setTimeout(destroy, PROCESSING_TIMEOUT_MS);
  }

  return {
    /** @param {import('../shared/messages.js').RecordingMirror} message */
    update({ state, elapsedMs }) {
      if (state === 'idle') {
        destroy();
        return;
      }
      if (!pill) {
        pill = makePill();
        pill.setStyle('minimal');
        pill.show(null);
        onChange(true);
      }
      pill.setState(state, { elapsedMs });
      arm();
    },

    /** @param {number} level */
    level(level) {
      if (!pill) return;
      pill.setLevel(level);
      arm();
    },

    raise() {
      pill?.raise();
    },

    destroy,
  };
}
