// WCAG color-contrast math for suggesting contrast fixes.
//
// We keep hue and saturation and only step lightness away from the background
// until the color passes its target ratio. HSL is used instead of OKLCH
// because it preserves hue and saturation *exactly* (zero hue drift), which is
// what "keep the brand colors" needs; OKLCH chroma/hue are not a 1:1 match for
// HSL hue and would introduce avoidable rounding drift.

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Parse a CSS color into { r, g, b } (0-255). Supports hex (#rgb, #rrggbb,
// #rrggbbaa) and rgb()/rgba() (comma, space, or slash separators, incl. %).
export function parseColor(str) {
  const s = String(str).trim().toLowerCase();
  if (!s) throw new Error("Empty color");

  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((c) => c + c)
        .join("");
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) {
      throw new Error(`Invalid hex color: ${str}`);
    }
    return { r, g, b };
  }

  const fn = s.match(/^rgba?\(\s*([^)]+)\)$/);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) throw new Error(`Invalid rgb color: ${str}`);
    const to255 = (v) =>
      v.endsWith("%") ? (parseFloat(v) / 100) * 255 : parseFloat(v);
    const [r, g, b] = parts.map((p) => clamp(to255(p), 0, 255));
    if ([r, g, b].some((n) => Number.isNaN(n))) {
      throw new Error(`Invalid rgb color: ${str}`);
    }
    return { r, g, b };
  }

  throw new Error(`Unsupported color format: ${str}`);
}

function channelLuminance(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

// WCAG 2.x relative luminance of an { r, g, b } color.
export function relativeLuminance({ r, g, b }) {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

// WCAG contrast ratio between two { r, g, b } colors (order-independent).
export function contrastRatio(a, b) {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslToRgb({ h, s, l }) {
  const hh = (((h % 360) + 360) % 360) / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, hh) * 255),
    b: Math.round(hue2rgb(p, q, hh - 1 / 3) * 255),
  };
}

function toHex({ r, g, b }) {
  const hx = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

// Normalize a font weight ("bold" -> 700, "400" -> 400, number passthrough).
function normalizeWeight(weight) {
  if (weight == null) return 400;
  if (typeof weight === "number") return weight;
  const s = String(weight).trim().toLowerCase();
  if (s === "bold" || s === "bolder") return 700;
  if (s === "normal" || s === "lighter") return 400;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 400 : n;
}

// Resolve a font size to pixels. Accepts numbers, "24px", "18.0pt (24px)",
// "1.75rem", etc. (1pt = 4/3px, 1rem assumed 16px).
function parseFontSizePx(fontSize) {
  if (typeof fontSize === "number") return fontSize;
  const s = String(fontSize).trim().toLowerCase();
  const px = s.match(/(\d+(?:\.\d+)?)\s*px/);
  if (px) return parseFloat(px[1]);
  const pt = s.match(/(\d+(?:\.\d+)?)\s*pt/);
  if (pt) return parseFloat(pt[1]) * (4 / 3);
  const rem = s.match(/(\d+(?:\.\d+)?)\s*rem/);
  if (rem) return parseFloat(rem[1]) * 16;
  const bare = parseFloat(s);
  return Number.isNaN(bare) ? 0 : bare;
}

// WCAG 2.1 large-text threshold: >= 24px, or >= 18.66px at >= 700 weight.
function targetRatio({ fontSizePx, fontWeight }) {
  const px = parseFontSizePx(fontSizePx);
  const weight = normalizeWeight(fontWeight);
  return px >= 24 || (px >= 18.66 && weight >= 700) ? 3.0 : 4.5;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Find the nearest color (in lightness) that passes WCAG contrast against the
 * background, keeping hue and saturation unchanged.
 *
 * @param {string|{r,g,b}} fg foreground/text color
 * @param {string|{r,g,b}} bg background color
 * @param {{fontSizePx?: number|string, fontWeight?: number|string}} opts
 * @returns {{color: string, ratioBefore: number, ratioAfter: number, lightnessShift: number}}
 */
export function nearestPassingColor(fg, bg, { fontSizePx = 16, fontWeight = 400 } = {}) {
  const fgRgb = typeof fg === "string" ? parseColor(fg) : fg;
  const bgRgb = typeof bg === "string" ? parseColor(bg) : bg;
  const target = targetRatio({ fontSizePx, fontWeight });

  const fgLum = relativeLuminance(fgRgb);
  const bgLum = relativeLuminance(bgRgb);
  const ratioBefore = contrastRatio(fgRgb, bgRgb);

  if (ratioBefore >= target) {
    return {
      color: toHex(fgRgb),
      ratioBefore: round2(ratioBefore),
      ratioAfter: round2(ratioBefore),
      lightnessShift: 0,
    };
  }

  const hsl = rgbToHsl(fgRgb);
  // Move lightness AWAY from the background's luminance (lighten a
  // light-on-dark text, darken a dark-on-light text).
  const direction = fgLum >= bgLum ? 1 : -1;

  const STEP = 0.005; // 0.5% of the lightness axis per step
  const MAX_STEPS = 400;

  let chosen = null;
  for (let i = 1; i <= MAX_STEPS; i++) {
    const l = clamp(hsl.l + direction * STEP * i, 0, 1);
    const rgb = hslToRgb({ h: hsl.h, s: hsl.s, l });
    const hex = toHex(rgb);
    // Check the rounded hex so the returned color is guaranteed to pass even
    // after RGB channels round to whole bytes.
    if (contrastRatio(parseColor(hex), bgRgb) >= target) {
      chosen = { hex, l };
      break;
    }
  }

  if (!chosen) {
    const l = direction > 0 ? 1 : 0;
    const rgb = hslToRgb({ h: hsl.h, s: hsl.s, l });
    chosen = { hex: toHex(rgb), l };
  }

  return {
    color: chosen.hex,
    ratioBefore: round2(ratioBefore),
    ratioAfter: round2(contrastRatio(parseColor(chosen.hex), bgRgb)),
    lightnessShift: round2(chosen.l - hsl.l),
  };
}

