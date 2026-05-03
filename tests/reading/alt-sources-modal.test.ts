// Implements REQ-READ-002 — alt-sources picker positioning regression test.
//
// `positionAnchored` is a pure function that decides where the desktop
// modal sits relative to its trigger. The bug we're guarding against:
// before the 2026-05-03 fix the dialog rendered at viewport (0,0) on
// every open because the `<dialog>` UA centring was being suppressed
// by the surrounding cascade and there was no JS fallback. The pure
// function lets us pin the geometry without a DOM.

import { describe, it, expect } from 'vitest';
import { positionAnchored } from '~/scripts/alt-sources-modal';

const VIEWPORT = { width: 1280, height: 800 };
const DIALOG = { width: 400, height: 300 };
const GAP = 8;
const EDGE = 12;

describe('positionAnchored — REQ-READ-002', () => {
  it('anchors directly below the trigger when there is room', () => {
    const trigger = { top: 100, left: 200, bottom: 130, right: 280, width: 80 };
    const pos = positionAnchored(trigger, VIEWPORT, DIALOG);
    expect(pos).not.toBeNull();
    expect(pos!.left).toBe(200);
    expect(pos!.top).toBe(130 + GAP);
  });

  it('slides left to fit when the trigger is near the right viewport edge', () => {
    const trigger = { top: 100, left: 1000, bottom: 130, right: 1080, width: 80 };
    const pos = positionAnchored(trigger, VIEWPORT, DIALOG);
    expect(pos).not.toBeNull();
    // Right edge would land at 1000 + 400 = 1400 (overflows 1280).
    // Slide so the right edge is `EDGE` from the viewport right.
    expect(pos!.left).toBe(VIEWPORT.width - DIALOG.width - EDGE);
  });

  it('clamps to the left edge margin when the trigger is far left', () => {
    const trigger = { top: 100, left: 0, bottom: 130, right: 80, width: 80 };
    const pos = positionAnchored(trigger, VIEWPORT, DIALOG);
    expect(pos).not.toBeNull();
    expect(pos!.left).toBe(EDGE);
  });

  it('flips above the trigger when there is not enough room below', () => {
    const trigger = { top: 600, left: 200, bottom: 630, right: 280, width: 80 };
    const pos = positionAnchored(trigger, VIEWPORT, DIALOG);
    expect(pos).not.toBeNull();
    // Below would be 630 + 8 + 300 = 938 (overflows 800).
    // Flip: top - dialog height - gap = 600 - 300 - 8 = 292.
    expect(pos!.top).toBe(600 - DIALOG.height - GAP);
  });

  it('returns null (caller falls back to centred) when dialog is too tall for viewport', () => {
    const trigger = { top: 100, left: 200, bottom: 130, right: 280, width: 80 };
    const tallDialog = { width: 400, height: 900 };
    expect(positionAnchored(trigger, VIEWPORT, tallDialog)).toBeNull();
  });

  it('returns null when the dialog cannot fit either above or below the trigger', () => {
    // Trigger sits in the middle of a viewport too short for either branch.
    const tightViewport = { width: 1280, height: 400 };
    const dialog = { width: 400, height: 320 };
    const trigger = { top: 200, left: 200, bottom: 230, right: 280, width: 80 };
    expect(positionAnchored(trigger, tightViewport, dialog)).toBeNull();
  });
});
