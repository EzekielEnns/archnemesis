import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  fitBounds,
  screenToWorld,
  visibleWorld,
  worldToScreen,
  zoomAt,
} from "./camera";

describe("camera", () => {
  const cam = { x: 30, y: -20, scale: 2 };

  it("round-trips screen and world points", () => {
    const p = { x: 123, y: 45 };
    const back = worldToScreen(cam, screenToWorld(cam, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const at = { x: 400, y: 300 };
    const before = screenToWorld(cam, at);
    const after = screenToWorld(zoomAt(cam, at, 1.7), at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps the zoom", () => {
    expect(zoomAt(cam, { x: 0, y: 0 }, 1000).scale).toBe(MAX_SCALE);
    expect(zoomAt(cam, { x: 0, y: 0 }, 0.00001).scale).toBe(MIN_SCALE);
  });

  it("fits bounds into the view, never zooming past 100%", () => {
    const fit = fitBounds({ x: 1000, y: 1000, w: 4000, h: 1000 }, 1000, 600, 50);
    expect(fit.scale).toBeCloseTo(900 / 4000);
    const seen = visibleWorld(fit, 1000, 600);
    expect(seen.x).toBeLessThanOrEqual(1000);
    expect(seen.x + seen.w).toBeGreaterThanOrEqual(5000);
    expect(fitBounds({ x: 0, y: 0, w: 10, h: 10 }, 1000, 600).scale).toBe(1);
  });
});
