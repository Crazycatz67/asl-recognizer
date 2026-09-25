// =============================================================================
// js/fxmath.js — tiny pure helpers for the visual layer (no DOM, no GPU)
// =============================================================================
// WHAT: colour maths for the amber palette (WCAG relative luminance +
//   contrast ratio, hex parsing) and a damped-spring integrator used by the
//   hero's kinetic title. Pure so tools/ci-check.mjs and tools/selftest.js can
//   assert them without a browser.
//
// PUBLIC API:
//   hexToRgb("#fbbf24")            -> [251, 191, 36]   (also "#fb2", "fbbf24")
//   relLuminance([r,g,b])          -> 0..1 (WCAG 2.x)
//   contrastRatio("#fbbf24", "#0f172a") -> 1..21
//   springStep(s, target, { k, c }, dt) -> { x, v }   (semi-implicit Euler, sub-stepped)
//   springSettled(s, target, eps)  -> true when at rest on the target
//   coverMap(x, y, srcW, srcH, dstW, dstH) -> {x, y} px: a normalised video
//                                  point through CSS object-fit: cover

/** @param {string} hex */
export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`bad hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** WCAG 2.x relative luminance of an sRGB colour (0..255 channels). */
export function relLuminance(rgb) {
  const lin = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG contrast ratio between two colours (hex strings or rgb arrays). */
export function contrastRatio(a, b) {
  const la = relLuminance(Array.isArray(a) ? a : hexToRgb(a));
  const lb = relLuminance(Array.isArray(b) ? b : hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * One step of a damped spring toward `target` (semi-implicit Euler,
 * sub-stepped to <= 1/120 s so a long frame can't blow it up).
 * k = stiffness, c = damping; c < 2*sqrt(k) overshoots (bouncy), c >=
 * 2*sqrt(k) settles without overshoot. Returns a NEW {x, v}.
 */
export function springStep(s, target, { k = 170, c = 18 } = {}, dt = 1 / 60) {
  let x = Number.isFinite(s?.x) ? s.x : target;
  let v = Number.isFinite(s?.v) ? s.v : 0;
  let left = Math.max(0, Math.min(Number(dt) || 0, 0.25));
  while (left > 1e-9) {
    const h = Math.min(left, 1 / 120);
    v += (-k * (x - target) - c * v) * h;
    x += v * h;
    left -= h;
  }
  return { x, v };
}

/** True once a spring is at rest on its target (within eps). */
export function springSettled(s, target, eps = 1e-3) {
  return Math.abs(s.x - target) < eps && Math.abs(s.v) < eps;
}

/**
 * Where a normalised video point (0..1) lands on a box that shows the video
 * with CSS `object-fit: cover` (scaled to fill, centred, overflow cropped).
 * Used to put hero fingertip dots where the hand would appear full-screen
 * instead of stretching the video's aspect over the screen's.
 */
export function coverMap(x, y, srcW, srcH, dstW, dstH) {
  if (!(srcW > 0 && srcH > 0)) return { x: x * dstW, y: y * dstH };
  const k = Math.max(dstW / srcW, dstH / srcH);
  return { x: x * srcW * k - (srcW * k - dstW) / 2, y: y * srcH * k - (srcH * k - dstH) / 2 };
}
