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
//   springStep(s, target, { k, c }, dt) -> { x, v }   (semi-implicit Euler)
//   springSettled(s, target, eps)  -> true when at rest on the target

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
