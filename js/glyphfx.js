// =============================================================================
// js/glyphfx.js — particles assemble into the letter (visual layer v2, B3)
// =============================================================================
// WHAT: for the big reward tiers (first time a letter lands, mastery), a
//   pooled cloud of amber/gold particles leaves the fingertips and springs
//   into the letter's glyph BESIDE the hand (never over it), holds for a
//   beat, then fades — the hero title's "handshape -> glyph" idea as the
//   app's reward language. Ordinary reps keep the juice rings.
//
// BUDGET (js/fxquality.js): canvas 2D, pooled <= 200 particles ("full"),
//   <= 90 on "lite"; "off" / reduced motion: the glyph simply appears and
//   fades in place (no travel). The rAF loop only runs while a glyph is
//   showing. Pointer-events none, aria-hidden (the toast carries the words).
//
// PUBLIC API:
//   const g = createGlyphFx({ governor });
//   g.assemble(letter, { from: [{x,y}...page px], box: {left,top,right,bottom},
//                        tier: "first"|"mastery" })
//   g.bench(frames)                       // ?debug: ms per step+draw
//   samplePoints(img, max, step?) -> [{x,y}] in 0..1   (pure: ImageData-like)
//   placeBeside(box, size, view) -> {x, y}              (pure)
//   MAX_PARTICLES

import { springStep } from "./fxmath.js";

export const MAX_PARTICLES = 200;
const COLORS = {
  first: ["#fbbf24", "#fcd34d", "#f8fafc", "#38bdf8"],
  mastery: ["#ffc861", "#fbbf24", "#fef3c7", "#f8fafc"],
};

/**
 * Evenly thinned points where a rendered glyph is opaque. img is
 * ImageData-like ({data, width, height}); returns <= max points in 0..1.
 * Pure (no DOM), so ci-check can feed it a synthetic bitmap.
 */
export function samplePoints(img, max = MAX_PARTICLES, step = 2) {
  const { data, width: w, height: h } = img;
  const pts = [];
  for (let y = 0; y < h; y += step)
    for (let x = 0; x < w; x += step)
      if (data[(y * w + x) * 4 + 3] > 128) pts.push({ x: x / w, y: y / h });
  if (pts.length <= max) return pts;
  const out = [];
  const stride = pts.length / max;
  for (let i = 0; i < max; i++) out.push(pts[Math.floor(i * stride)]);
  return out;
}

/**
 * Where to put a size x size glyph next to the hand's box (page px): on the
 * side with more room, vertically centred on the hand, clamped into view.
 * Returns the glyph's top-left. Pure.
 */
export function placeBeside(box, size, view) {
  const gap = size * 0.25;
  const roomL = box.left - view.left, roomR = view.right - box.right;
  let x = roomR >= roomL ? box.right + gap : box.left - gap - size;
  let y = (box.top + box.bottom) / 2 - size / 2;
  x = Math.max(view.left + 4, Math.min(view.right - size - 4, x));
  y = Math.max(view.top + 4, Math.min(view.bottom - size - 4, y));
  return { x, y };
}

export function createGlyphFx({ governor = null } = {}) {
  const cv = document.createElement("canvas");
  cv.className = "fx-glyph";
  cv.setAttribute("aria-hidden", "true");
  Object.assign(cv.style, { position: "fixed", inset: "0", width: "100%", height: "100%", pointerEvents: "none", zIndex: "61" });
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d");
  const off = document.createElement("canvas");
  const octx = off.getContext("2d", { willReadFrequently: true });
  const pool = Array.from({ length: MAX_PARTICLES }, () => ({ x: { x: 0, v: 0 }, y: { x: 0, v: 0 }, tx: 0, ty: 0, c: "#fff", delay: 0, r: 2 }));
  let live = 0;
  let show = null; // { t0, letter, gx, gy, size, colors, still }
  let raf = 0, last = 0;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(window.innerWidth * dpr);
    cv.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const FONT = (px) => `900 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  function glyphPoints(letter, max) {
    const S = 96;
    off.width = off.height = S;
    octx.clearRect(0, 0, S, S);
    octx.fillStyle = "#000";
    octx.textAlign = "center";
    octx.textBaseline = "middle";
    octx.font = FONT(S * 0.9);
    octx.fillText(letter, S / 2, S * 0.54);
    return samplePoints(octx.getImageData(0, 0, S, S), max, 2);
  }

  const HOLD_MS = 1500, TOTAL_MS = 2100;
  function step(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 1 / 60);
    last = now;
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    if (!show) return false;
    const t = now - show.t0;
    if (t > TOTAL_MS) { show = null; live = 0; return false; }
    const fade = t > HOLD_MS ? 1 - (t - HOLD_MS) / (TOTAL_MS - HOLD_MS) : 1;
    if (show.still) {
      // static equivalent: the glyph appears and fades, no travel
      ctx.globalAlpha = Math.min(1, t / 150) * fade;
      ctx.fillStyle = show.colors[0];
      ctx.font = FONT(show.size * 0.9);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(show.letter, show.gx + show.size / 2, show.gy + show.size * 0.54);
      ctx.globalAlpha = 1;
      return true;
    }
    for (let i = 0; i < live; i++) {
      const p = pool[i];
      if (t < p.delay) continue;
      p.x = springStep(p.x, p.tx, { k: 120, c: 14 }, dt);
      p.y = springStep(p.y, p.ty, { k: 120, c: 14 }, dt);
      ctx.globalAlpha = Math.min(1, (t - p.delay) / 120) * fade;
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x.x - p.r, p.y.x - p.r, p.r * 2, p.r * 2);
    }
    ctx.globalAlpha = 1;
    return true;
  }
  function frame(now) {
    raf = 0;
    if (document.visibilityState === "hidden") { show = null; live = 0; ctx.clearRect(0, 0, cv.width, cv.height); return; }
    if (step(now)) raf = requestAnimationFrame(frame);
  }

  return {
    assemble(letter, { from = [], box = null, tier = "first" } = {}) {
      const L = governor?.level ?? "full";
      if (!letter || !box) return false;
      const view = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const size = Math.max(90, Math.min(180, (box.bottom - box.top) * 0.8));
      const { x: gx, y: gy } = placeBeside(box, size, view);
      const colors = COLORS[tier] || COLORS.first;
      show = { t0: performance.now(), letter, gx, gy, size, colors, still: L === "off" };
      if (L !== "off") {
        const pts = glyphPoints(letter, L === "lite" ? 90 : MAX_PARTICLES);
        live = pts.length;
        const src = from.length ? from : [{ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }];
        pts.forEach((q, i) => {
          const p = pool[i], s = src[i % src.length];
          p.x = { x: s.x + (Math.random() - 0.5) * 16, v: (Math.random() - 0.5) * 300 };
          p.y = { x: s.y + (Math.random() - 0.5) * 16, v: -120 - Math.random() * 240 };
          p.tx = gx + q.x * size;
          p.ty = gy + q.y * size;
          p.c = colors[i % colors.length];
          p.delay = (i % src.length) * 25 + Math.random() * 90;
          p.r = size / 96 * 1.25;
        });
      }
      last = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
      return true;
    },
    bench(frames = 120) {
      this.assemble("W", { from: [{ x: 300, y: 300 }], box: { left: 200, top: 200, right: 400, bottom: 460 }, tier: "mastery" });
      cancelAnimationFrame(raf); raf = 0;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) step(show ? show.t0 + 8 * i : 0);
      const ms = (performance.now() - t0) / frames;
      show = null; live = 0; ctx.clearRect(0, 0, cv.width, cv.height);
      return { msPerFrame: ms, particles: MAX_PARTICLES };
    },
  };
}
