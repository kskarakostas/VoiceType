// Pure placement math for the pill and its menu. All boxes are in viewport coordinates
// (getBoundingClientRect), so the pill host can use position: fixed.

/**
 * @typedef {{ top: number, left: number, width: number, height: number }} Box
 * @typedef {{ width: number, height: number }} Size
 */

/** Minimum distance between the pill or menu and the viewport edge. */
export const EDGE = 4;
/** Distance from the bottom right corner when there is no field to anchor to. */
export const CORNER_MARGIN = 16;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Places the pill next to its field: left, else right, else above, else below, else inside
 * the field's visible top-right corner (full-page editors). Without a field it sits in the
 * bottom right corner; a field scrolled out of view hides it.
 * @param {{ anchor: Box|null, pill: Size, viewport: Size, gap: number }} input
 * @returns {{ top: number, left: number, placement: 'left'|'right'|'above'|'below'|'inside'|'corner'|'hidden' }}
 */
export function computePillPosition({ anchor, pill, viewport, gap }) {
  if (anchor === null) {
    return {
      top: viewport.height - pill.height - CORNER_MARGIN,
      left: viewport.width - pill.width - CORNER_MARGIN,
      placement: 'corner',
    };
  }
  const outside = anchor.top + anchor.height <= 0 || anchor.top >= viewport.height
    || anchor.left + anchor.width <= 0 || anchor.left >= viewport.width;
  if (outside) return { top: 0, left: 0, placement: 'hidden' };

  const middle = clamp(anchor.top + (anchor.height - pill.height) / 2, EDGE, viewport.height - pill.height - EDGE);
  const leftSide = anchor.left - gap - pill.width;
  if (leftSide >= EDGE) return { top: middle, left: leftSide, placement: 'left' };
  const rightSide = anchor.left + anchor.width + gap;
  if (rightSide + pill.width <= viewport.width - EDGE) return { top: middle, left: rightSide, placement: 'right' };

  const maxTop = viewport.height - pill.height - EDGE;
  const maxLeft = viewport.width - pill.width - EDGE;
  const left = clamp(anchor.left, EDGE, maxLeft);
  const above = anchor.top - gap - pill.height;
  if (above >= EDGE) return { top: above, left, placement: 'above' };
  const below = anchor.top + anchor.height + gap;
  if (below + pill.height <= viewport.height - EDGE) return { top: below, left, placement: 'below' };

  return {
    top: clamp(Math.max(anchor.top, 0) + gap, EDGE, maxTop),
    left: clamp(Math.min(anchor.left + anchor.width, viewport.width) - gap - pill.width, EDGE, maxLeft),
    placement: 'inside',
  };
}

/**
 * Opens the menu below the pill when it fits, else above (never past the top edge);
 * left-aligned with the pill.
 * @param {{ pill: Box, menu: Size, viewport: Size, gap: number }} input
 * @returns {{ top: number, left: number, placement: 'below'|'above' }}
 */
export function computeMenuPlacement({ pill, menu, viewport, gap }) {
  const left = clamp(pill.left, EDGE, viewport.width - menu.width - EDGE);
  const below = pill.top + pill.height + gap;
  if (below + menu.height <= viewport.height - EDGE) return { top: below, left, placement: 'below' };
  return { top: Math.max(EDGE, pill.top - gap - menu.height), left, placement: 'above' };
}
