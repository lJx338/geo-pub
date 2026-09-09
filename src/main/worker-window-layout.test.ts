import { describe, expect, it } from 'vitest';
import {
  automationViewportForView,
  constrainWorkerWindowToWorkArea,
  fitWorkerWindowToWorkArea,
} from './worker-window-layout.js';

describe('worker window layout', () => {
  it('fits the initial Worker window into a small display work area', () => {
    expect(fitWorkerWindowToWorkArea({ x: 0, y: 0, width: 1280, height: 720 })).toEqual({
      x: 0, y: 0, width: 1280, height: 720,
    });
  });

  it('centers the preferred Worker window when the display is larger', () => {
    expect(fitWorkerWindowToWorkArea({ x: 100, y: 40, width: 1920, height: 1200 })).toEqual({
      x: 340, y: 140, width: 1440, height: 1000,
    });
  });

  it('moves and shrinks an existing Worker window after a display change', () => {
    expect(constrainWorkerWindowToWorkArea(
      { x: 800, y: 500, width: 1440, height: 1000 },
      { x: 0, y: 0, width: 1280, height: 720 },
    )).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it('uses the real child-view size as the automation viewport', () => {
    expect(automationViewportForView({ width: 1279.8, height: 671.2 })).toEqual({ width: 1279, height: 671 });
  });
});
