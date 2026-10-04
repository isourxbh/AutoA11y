import test from "node:test";
import assert from "node:assert/strict";
import {
  nearestPassingColor,
  parseColor,
  rgbToHsl,
  contrastRatio,
  relativeLuminance,
} from "./contrast.js";

const hueOf = (hex) => rgbToHsl(parseColor(hex)).h;

// Circular hue distance in degrees (0..180).
function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function check(fg, bg, opts, target, expectLighter = null) {
  const r = nearestPassingColor(fg, bg, opts);
  const ratio = contrastRatio(parseColor(r.color), parseColor(bg));
  assert.ok(
    ratio >= target,
    `${r.color} on ${bg} → ratio ${ratio.toFixed(3)}, expected >= ${target}`
  );
  const drift = hueDistance(hueOf(r.color), hueOf(fg));
  assert.ok(drift <= 5, `hue drifted ${drift.toFixed(2)}° from ${fg} to ${r.color}`);
  if (expectLighter !== null) {
    const origLum = relativeLuminance(parseColor(fg));
    const newLum = relativeLuminance(parseColor(r.color));
    if (expectLighter) {
      assert.ok(newLum > origLum, `expected ${fg} → ${r.color} to get lighter`);
    } else {
      assert.ok(newLum < origLum, `expected ${fg} → ${r.color} to get darker`);
    }
  }
  return r;
}

test("nearestPassingColor: #d1d5db on #ffffff (small text → 4.5:1)", () => {
  const r = check("#d1d5db", "#ffffff", { fontSizePx: 16, fontWeight: 400 }, 4.5, false);
  assert.ok(r.lightnessShift < 0, "gray on white must darken");
});

test("nearestPassingColor: #a0aec0 on #e2e8f0 (small text → 4.5:1)", () => {
  const r = check("#a0aec0", "#e2e8f0", { fontSizePx: 16, fontWeight: 400 }, 4.5, false);
  assert.ok(r.lightnessShift < 0, "blue-gray on light must darken");
});

test("nearestPassingColor: #2d4a73 on #1a365d gets lighter (large text → 3:1)", () => {
  const r = check(
    "#2d4a73",
    "#1a365d",
    { fontSizePx: 24, fontWeight: "bold" },
    3.0,
    true
  );
  assert.ok(r.lightnessShift > 0, "light-on-dark text must lighten");
});
