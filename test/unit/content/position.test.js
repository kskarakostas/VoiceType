import { describe, it, expect } from 'vitest';
import { computePillPosition, computeMenuPlacement, EDGE, CORNER_MARGIN } from '../../../src/content/position.js';

const viewport = { width: 1000, height: 800 };
const pill = { width: 100, height: 40 };
const gap = 8;

function box(left, top, width, height) {
  return { left, top, width, height };
}

describe('constants', () => {
  it('keeps 4 px from the viewport edge and 16 px in the corner', () => {
    expect(EDGE).toBe(4);
    expect(CORNER_MARGIN).toBe(16);
  });
});

describe('computePillPosition', () => {
  it('without an anchor sits in the bottom right corner', () => {
    expect(computePillPosition({ anchor: null, pill, viewport, gap })).toEqual({
      top: 800 - 40 - CORNER_MARGIN, left: 1000 - 100 - CORNER_MARGIN, placement: 'corner',
    });
  });

  it('hides when the anchor is entirely outside the viewport on any side', () => {
    const outside = [
      box(300, -60, 200, 50), // above
      box(300, 800, 200, 50), // below
      box(-250, 300, 200, 50), // left
      box(1000, 300, 200, 50), // right
      box(0, 0, 0, 0), // display: none reports an empty box at the origin
    ];
    for (const anchor of outside) {
      expect(computePillPosition({ anchor, pill, viewport, gap }).placement, JSON.stringify(anchor)).toBe('hidden');
    }
  });

  it('prefers the left side, vertically centred on the anchor', () => {
    expect(computePillPosition({ anchor: box(300, 200, 400, 100), pill, viewport, gap })).toEqual({
      top: 200 + (100 - 40) / 2, left: 300 - 8 - 100, placement: 'left',
    });
  });

  it('uses the left side when it lands exactly on EDGE', () => {
    const anchor = box(EDGE + 100 + gap, 200, 300, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toMatchObject({ left: EDGE, placement: 'left' });
  });

  it('falls to the right side when the left does not fit', () => {
    const anchor = box(50, 200, 400, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toEqual({ top: 200, left: 50 + 400 + 8, placement: 'right' });
  });

  it('uses the right side when it ends exactly EDGE from the viewport edge', () => {
    const anchor = box(0, 200, 1000 - EDGE - 100 - gap, 40);
    expect(computePillPosition({ anchor, pill, viewport, gap })).toMatchObject({ left: 1000 - EDGE - 100, placement: 'right' });
  });

  it('clamps the side placements vertically into the viewport', () => {
    const nearTop = computePillPosition({ anchor: box(300, -10, 200, 20), pill, viewport, gap });
    expect(nearTop).toMatchObject({ top: EDGE, placement: 'left' });
    const nearBottom = computePillPosition({ anchor: box(300, 790, 200, 30), pill, viewport, gap });
    expect(nearBottom).toMatchObject({ top: 800 - 40 - EDGE, placement: 'left' });
  });

  it('goes above a full-width anchor, with left clamped from anchor.left', () => {
    expect(computePillPosition({ anchor: box(0, 300, 1000, 100), pill, viewport, gap })).toEqual({
      top: 300 - 8 - 40, left: EDGE, placement: 'above',
    });
    const wideRight = computePillPosition({ anchor: box(950, 300, 50, 100), pill: { width: 990, height: 40 }, viewport, gap });
    expect(wideRight).toMatchObject({ left: 1000 - 990 - EDGE, placement: 'above' });
  });

  it('goes below a full-width anchor at the top of the viewport', () => {
    expect(computePillPosition({ anchor: box(0, 20, 1000, 100), pill, viewport, gap })).toEqual({
      top: 20 + 100 + 8, left: EDGE, placement: 'below',
    });
  });

  it('uses below only when the pill fits under the anchor', () => {
    const fits = computePillPosition({ anchor: box(0, 20, 1000, 728), pill, viewport, gap });
    expect(fits).toEqual({ top: 20 + 728 + 8, left: EDGE, placement: 'below' });
    expect(fits.top + pill.height).toBe(800 - EDGE);
    const tooTall = computePillPosition({ anchor: box(0, 20, 1000, 729), pill, viewport, gap });
    expect(tooTall.placement).toBe('inside');
  });

  it('a full-viewport anchor gets inside, fully on screen', () => {
    const position = computePillPosition({ anchor: box(0, 0, 1000, 800), pill, viewport, gap });
    expect(position).toEqual({ top: 0 + 8, left: 1000 - 8 - 100, placement: 'inside' });
    expect(position.top).toBeGreaterThanOrEqual(EDGE);
    expect(position.top + pill.height).toBeLessThanOrEqual(800 - EDGE);
    expect(position.left).toBeGreaterThanOrEqual(EDGE);
    expect(position.left + pill.width).toBeLessThanOrEqual(1000 - EDGE);
  });

  it('an anchor larger than the viewport gets inside within the viewport', () => {
    const position = computePillPosition({ anchor: box(-50, -300, 1200, 2000), pill, viewport, gap });
    expect(position).toEqual({ top: 8, left: 1000 - 8 - 100, placement: 'inside' });
  });

  it('inside sits at the visible top-right corner of the anchor', () => {
    expect(computePillPosition({ anchor: box(60, 30, 900, 900), pill, viewport, gap })).toEqual({
      top: 30 + 8, left: 60 + 900 - 8 - 100, placement: 'inside',
    });
  });

  it('inside is clamped into the viewport with EDGE', () => {
    const narrow = { width: 104, height: 800 };
    expect(computePillPosition({ anchor: box(0, 0, 104, 800), pill, viewport: narrow, gap })).toEqual({
      top: 8, left: EDGE, placement: 'inside',
    });
    expect(computePillPosition({ anchor: box(0, 0, 1000, 800), pill, viewport, gap: 0 })).toEqual({
      top: EDGE, left: 1000 - 100 - EDGE, placement: 'inside',
    });
  });

  it('spec 6.3: follows a field inside a scrolling container', () => {
    const before = computePillPosition({ anchor: box(400, 500, 300, 40), pill, viewport, gap });
    const scrolled = computePillPosition({ anchor: box(400, 380, 300, 40), pill, viewport, gap });
    expect(scrolled.placement).toBe(before.placement);
    expect(scrolled.left).toBe(before.left);
    expect(scrolled.top).toBe(before.top - 120);
    const scrolledOut = computePillPosition({ anchor: box(400, -45, 300, 40), pill, viewport, gap });
    expect(scrolledOut.placement).toBe('hidden');
  });

  it('spec 6.3: a left-flush field gets the pill on its right', () => {
    expect(computePillPosition({ anchor: box(0, 300, 500, 40), pill, viewport, gap })).toEqual({
      top: 300, left: 500 + 8, placement: 'right',
    });
  });
});

describe('computeMenuPlacement', () => {
  const menu = { width: 240, height: 300 };

  it('opens below the pill when it fits, aligned to the pill, capped to the room below', () => {
    expect(computeMenuPlacement({ pill: box(200, 100, 100, 40), menu, viewport, gap })).toEqual({
      top: 100 + 40 + 8, left: 200, placement: 'below', maxHeight: 800 - EDGE - (100 + 40 + 8),
    });
  });

  it('opens below when it ends exactly EDGE from the bottom', () => {
    const top = 800 - EDGE - 300 - 8 - 40;
    expect(computeMenuPlacement({ pill: box(200, top, 100, 40), menu, viewport, gap }).placement).toBe('below');
    expect(computeMenuPlacement({ pill: box(200, top + 1, 100, 40), menu, viewport, gap }).placement).toBe('above');
  });

  it('spec 6.3: a bottom-edge field opens the menu above', () => {
    expect(computeMenuPlacement({ pill: box(200, 740, 100, 40), menu, viewport, gap })).toEqual({
      top: 740 - 8 - 300, left: 200, placement: 'above', maxHeight: 740 - 8 - EDGE,
    });
  });

  it('caps the menu above when neither side fits and above has more room', () => {
    const short = { width: 1000, height: 400 };
    // Room below: 400 - 4 - 248 = 148; room above: 200 - 8 - 4 = 188.
    expect(computeMenuPlacement({ pill: box(200, 200, 100, 40), menu, viewport: short, gap })).toEqual({
      top: EDGE, left: 200, placement: 'above', maxHeight: 188,
    });
  });

  it('caps the menu below when neither side fits and below has more room', () => {
    const short = { width: 1000, height: 400 };
    // Room below: 400 - 4 - 208 = 188; room above: 160 - 8 - 4 = 148.
    expect(computeMenuPlacement({ pill: box(200, 160, 100, 40), menu, viewport: short, gap })).toEqual({
      top: 208, left: 200, placement: 'below', maxHeight: 188,
    });
  });

  it('never reports a negative height', () => {
    const tiny = { width: 1000, height: 50 };
    expect(computeMenuPlacement({ pill: box(200, 5, 100, 40), menu, viewport: tiny, gap }).maxHeight).toBe(0);
  });

  it('never overlaps the pill and stays inside the viewport', () => {
    for (const height of [100, 300, 500, 780]) {
      for (let top = EDGE; top <= 800 - 40 - EDGE; top += 7) {
        const pos = computeMenuPlacement({ pill: box(200, top, 100, 40), menu: { width: 240, height }, viewport, gap });
        const shown = Math.min(height, pos.maxHeight);
        const label = `menu ${height}, pill at ${top}`;
        expect(pos.top, label).toBeGreaterThanOrEqual(EDGE);
        expect(pos.top + shown, label).toBeLessThanOrEqual(800 - EDGE);
        if (pos.placement === 'below') expect(pos.top, label).toBeGreaterThanOrEqual(top + 40 + gap);
        else expect(pos.top + shown, label).toBeLessThanOrEqual(top - gap);
      }
    }
  });

  it('clamps left into the viewport', () => {
    expect(computeMenuPlacement({ pill: box(900, 100, 100, 40), menu, viewport, gap }).left).toBe(1000 - 240 - EDGE);
    expect(computeMenuPlacement({ pill: box(-20, 100, 100, 40), menu, viewport, gap }).left).toBe(EDGE);
  });
});
