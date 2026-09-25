// =============================================================================
// js/inkbloom.js — reward ink bloom from the fingertips (visual layer v2, B3)
// =============================================================================
// WHAT: when a letter lands, amber/gold ink blooms out of the fingertips that
//   made the sign, pushed along each finger's direction (tip - PIP joint), and
//   fades within 1.2 s. It reuses js/fluid.js's stable-fluids core as a small
//   TRANSPARENT instance inside the camera stage — BEHIND the overlay canvas,
//   so the skeleton and correction guide always draw on top of the ink.
//
// BUDGET: only on governor "full" (lite/off: main.js keeps fx.burst / the
//   still ring instead). Quarter resolution (sim 32, dye 128, 8 Jacobi
//   passes), stepped at <= 30 fps only while a bloom is playing, then the
//   textures are freed (fluid.sleep) — the ONE context is reused by the next
//   bloom. Paused while the tab is hidden. ?debug reports "inkbloom" ms.
//
// PUBLIC API:
//   const ib = createInkBloom({ stage, before, governor, debug });
//   ib.bloom(hand, tier)   // hand: 21 landmarks (video-normalised, the stage
//                          // is CSS-mirrored so no flip here); tier:
//                          // "letter" | "first" | "mastery"
//   ib.bench(frames)       // ?debug: ms per splat+step+render (sync)
//   ib.dispose()
//   bloomSplats(hand, tier) -> [{x, y, dx, dy, color, radius}]  (pure)

import { createFluid } from "./fluid.js";

const TIPS = [4, 8, 12, 16, 20];
const PIPS = [3, 6, 10, 14, 18];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const AMBER = hex("#fbbf24"), HONEY = hex("#e8a33a"), GOLD = hex("#ffc861");
export const BLOOM_MS = 1200;
const COUNT = { letter: 3, first: 5, mastery: 5 };

/**
 * The splats for one bloom. Letter: the 3 longest fingers' tips; first /
 * mastery: all 5 (mastery adds a second gold ring of splats). Velocity runs
 * along the finger (tip - PIP), so the ink leaves the way the finger points.
 * Pure: no DOM, no GPU.
 */
export function bloomSplats(hand, tier = "letter") {
  if (!Array.isArray(hand) || hand.length < 21) return [];
  const n = COUNT[tier] ?? 3;
  const fingers = TIPS.map((t, i) => {
    const tip = hand[t], pip = hand[PIPS[i]];
    const dx = tip.x - pip.x, dy = tip.y - pip.y;
    const len = Math.hypot(dx, dy) || 1e-6;
    return { i, tip, ux: dx / len, uy: dy / len, len };
  }).filter((f) => Number.isFinite(f.tip.x) && Number.isFinite(f.tip.y));
  const pick = fingers.slice().sort((a, b) => b.len - a.len).slice(0, n);
  const out = pick.map((f, k) => ({
    x: f.tip.x, y: f.tip.y,
    dx: f.ux * 900, dy: f.uy * 900,
    color: (k % 2 ? HONEY : AMBER).map((v) => v * (tier === "letter" ? 0.32 : 0.4)),
    radius: 0.0022,
  }));
  if (tier === "mastery") {
    for (const f of pick) out.push({ x: f.tip.x, y: f.tip.y, dx: -f.uy * 500, dy: f.ux * 500, color: GOLD.map((v) => v * 0.3), radius: 0.003 });
  }
  return out;
}

export function createInkBloom({ stage, before = null, governor = null, debug = false } = {}) {
  let cv = null, fluid = null, failed = false;
  let raf = 0, until = 0, lastStep = 0, fadeTimer = 0;

  function ensure() {
    if (fluid || failed) return !!fluid;
    cv = document.createElement("canvas");
    cv.className = "fx-inkbloom";
    cv.setAttribute("aria-hidden", "true");
    stage.insertBefore(cv, before && before.parentNode === stage ? before : null);
    fluid = createFluid(cv, { simRes: 32, dyeRes: 128, transparent: true, iters: 8, dpr: 0.25 });
    if (!fluid) { cv.remove(); cv = null; failed = true; return false; }
    cv.addEventListener("webglcontextlost", () => { fluid = null; cv?.remove(); cv = null; failed = true; });
    return true;
  }

  function frame(now) {
    raf = 0;
    if (!fluid || document.visibilityState === "hidden") return end();
    if (now >= until) return end();
    raf = requestAnimationFrame(frame);
    if (now - lastStep < 32) return; // <= ~30 fps
    const dt = Math.min(1 / 30, (now - lastStep) / 1000 || 1 / 30);
    lastStep = now;
    const t0 = performance.now();
    fluid.step(dt);
    fluid.render();
    governor?.cost("inkbloom", performance.now() - t0);
  }
  function end() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (!cv) return;
    cv.classList.remove("on");
    clearTimeout(fadeTimer);
    // let the CSS fade finish, then free the textures (keep the context)
    fadeTimer = setTimeout(() => { if (!raf && fluid && !fluid.asleep) { fluid.clearDye(); fluid.sleep(); } governor?.clearCost("inkbloom"); }, 260);
  }

  const api = {
    bloom(hand, tier = "letter") {
      if ((governor?.level ?? "full") !== "full") return false;
      const splats = bloomSplats(hand, tier);
      if (!splats.length || !ensure()) return false;
      clearTimeout(fadeTimer);
      if (fluid.asleep) fluid.wake();
      fluid.resize();
      for (const s of splats) fluid.splat(s.x, s.y, s.dx, s.dy, s.color, s.radius);
      cv.classList.add("on");
      const now = performance.now();
      until = now + BLOOM_MS - 250; // leave the last ~250 ms to the CSS fade
      lastStep = now - 33;
      if (!raf) raf = requestAnimationFrame(frame);
      return true;
    },
    bench(frames = 60) {
      if (!ensure()) return null;
      if (fluid.asleep) fluid.wake();
      fluid.resize();
      const gl = fluid.gl, px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        fluid.splat(0.5, 0.5, 300, -300, AMBER.map((v) => v * 0.3), 0.0022);
        fluid.step(1 / 30);
        fluid.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const r = { msPerFrame: (performance.now() - t0) / frames, ...fluid.resolution, canvas: [cv.width, cv.height] };
      fluid.clearDye();
      fluid.sleep();
      return r;
    },
    dispose() {
      end();
      clearTimeout(fadeTimer);
      fluid?.dispose();
      fluid = null;
      cv?.remove();
      cv = null;
    },
  };
  if (debug) Object.defineProperty(api, "_canvas", { get: () => cv });
  return api;
}
