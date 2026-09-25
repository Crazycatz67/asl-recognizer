// =============================================================================
// js/hero.js — landing / hero screen (visual layer v2, B2)
// =============================================================================
// WHAT: the first screen on a first visit (before the tour) and whenever the
//   logo is tapped:
//   - a full-screen GPU fluid (js/fluid.js) on --bg-deep, stirred by the
//     pointer / touch, and — once the camera is on — by the tracked
//     fingertips: index..pinky inject amber/honey dye, the THUMB injects blue
//     so you can tell which finger is which. At most 3 splats per frame (the
//     3 fastest tips); small dots mark where your fingertips are.
//   - a kinetic title, "Fingerspell with your hands": each letter first
//     appears as its own fingerspelled handshape (the dataset centroid drawn
//     by skeleton.js), then springs into the glyph (fxmath.springStep).
//   - an amber "Start" CTA (--amber-ink text, --amber-glow halo) with an SVG
//     goo hover, plus "Try it with your hand".
//
// BUDGET: the sim only runs while the hero is open (disposed on close). Full:
//   sim 128 / dye 512 at up to 60 fps; with the camera on (detection shares
//   the GPU) or on "lite": dye 256 at <= 30 fps; "off" / reduced motion: a
//   static amber-on-deep gradient and the finished title — no sim, no
//   springs. Paused while the tab is hidden. ?debug reports "fluid" ms.
//
// PUBLIC API:
//   const hero = createHero({ root, governor, shapeFor, shapesReady,
//                             startCamera, cameraLive, debug });
//   hero.open({ onStart })   // onStart runs after the user taps Start
//   hero.close()
//   hero.isOpen()
//   hero.feedHands(landmarksList, mirrored)  // from the detection loop
//   hero.bench(frames)       // ?debug: ms per sim+render frame (sync)

import { createFluid } from "./fluid.js";
import { springStep } from "./fxmath.js";
import { drawHandShape, vectorToPixels } from "./skeleton.js";

const TITLE = "Fingerspell with your hands";
const TIPS = [4, 8, 12, 16, 20];
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const DYE = {
  amber: hex("#fbbf24"),
  honey: hex("#e8a33a"),
  gold: hex("#ffc861"),
  ember: hex("#b45309"),
  calm: hex("#38bdf8"),
};
const BG_DEEP = hex("#0b0f19");
const dim = (c, k) => c.map((v) => v * k);

export function createHero({
  root,
  governor = null,
  shapeFor = () => null,
  shapesReady = Promise.resolve(),
  startCamera = null,
  cameraLive = () => false,
  debug = false,
}) {
  const titleEl = root.querySelector(".hero-title");
  const stage = root.querySelector(".hero-stage");
  const startBtn = root.querySelector(".hero-cta");
  const handBtn = root.querySelector(".hero-hand");
  const statusEl = root.querySelector(".hero-handstatus");
  const tipLayer = root.querySelector(".hero-tips");

  let open = false;
  let fluid = null;
  let canvas = null;
  let raf = 0;
  let last = 0;
  let lastStep = 0;
  let nextAuto = 0;
  let onStart = null;
  let returnFocus = null;
  let letters = [];
  let titleT0 = 0;
  let titleDone = true;
  let pointer = null; // last pointer position (0..1) for velocity
  let prevTips = null;
  let lastHandAt = 0;
  let camMode = false;

  // ---- title markup (built once; screen readers get the aria-label) -------
  titleEl.setAttribute("aria-label", TITLE);
  titleEl.textContent = "";
  let idx = 0;
  for (const word of TITLE.split(" ")) {
    const w = document.createElement("span");
    w.className = "hk-w";
    w.setAttribute("aria-hidden", "true");
    for (const ch of word) {
      const l = document.createElement("span");
      l.className = "hk-l";
      const shape = document.createElement("canvas");
      shape.className = "hk-shape";
      const g = document.createElement("span");
      g.className = "hk-g";
      g.textContent = ch;
      l.append(shape, g);
      w.append(l);
      letters.push({ ch: ch.toUpperCase(), el: l, shape, g, i: idx++, s: { x: 0, v: 0 }, gs: { x: 0, v: 0 }, drawn: false });
    }
    titleEl.append(w, document.createTextNode(" "));
  }

  function drawShapes() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const L of letters) {
      const vec = shapeFor(L.ch);
      if (!vec) { L.drawn = false; continue; }
      const box = L.el.getBoundingClientRect();
      // about one glyph wide (a bit more), so neighbouring hands barely overlap
      const size = Math.max(24, Math.round(Math.min(box.height * 0.95, box.width * 1.3)));
      L.shape.width = L.shape.height = size * dpr;
      L.shape.style.width = L.shape.style.height = `${size}px`;
      const ctx = L.shape.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      try {
        drawHandShape(ctx, vectorToPixels(vec, size, size, { pad: 0.1 }), { fill: "#fbbf24", outline: "#b45309", nails: false });
        L.drawn = true;
      } catch {
        L.drawn = false;
      }
    }
  }

  const level = () => governor?.level ?? "full";
  const animated = () => level() !== "off";

  // ---- title animation ----------------------------------------------------
  function paintTitle(now, dt) {
    if (titleDone) return;
    let settled = true;
    for (const L of letters) {
      const t = now - titleT0 - L.i * 55;
      // shape: pops in (0-380 ms), then springs away while the glyph springs in
      const shapeTarget = L.drawn && t > 0 && t < 420 ? 1 : 0;
      const glyphTarget = t > (L.drawn ? 340 : 0) ? 1 : 0;
      L.s = springStep(L.s, shapeTarget, { k: 260, c: 20 }, dt);
      L.gs = springStep(L.gs, glyphTarget, { k: 190, c: 13 }, dt);
      const s = Math.max(0, L.s.x), g = L.gs.x;
      L.shape.style.opacity = String(Math.min(1, s));
      L.shape.style.transform = `translate(-50%, -50%) scale(${(0.4 + 0.6 * s).toFixed(3)})`;
      L.g.style.opacity = String(Math.max(0, Math.min(1, g * 1.4)));
      L.g.style.transform = `translateY(${((1 - g) * 0.45).toFixed(3)}em) scale(${(0.5 + 0.5 * g).toFixed(3)}) rotate(${((1 - g) * -14).toFixed(2)}deg)`;
      if (glyphTarget !== 1 || Math.abs(g - 1) > 0.002 || Math.abs(L.gs.v) > 0.01 || s > 0.002) settled = false;
    }
    if (settled) finishTitle();
  }
  function finishTitle() {
    titleDone = true;
    for (const L of letters) {
      L.shape.style.opacity = "0";
      L.g.style.opacity = "";
      L.g.style.transform = "";
    }
  }

  // ---- fluid --------------------------------------------------------------
  function wantRes() {
    return camMode || level() === "lite" ? [128, 256] : [128, 512];
  }
  function startFluid() {
    if (fluid || !animated()) return;
    canvas = document.createElement("canvas");
    canvas.className = "hero-fluid";
    canvas.setAttribute("aria-hidden", "true");
    stage.prepend(canvas);
    const [s, d] = wantRes();
    fluid = createFluid(canvas, { simRes: s, dyeRes: d, background: BG_DEEP });
    if (!fluid) { canvas.remove(); canvas = null; root.classList.add("hero-static"); return; }
    root.classList.remove("hero-static");
    // opening swirl: a few amber splats from the bottom edge
    for (let i = 0; i < 5; i++) {
      const x = 0.15 + 0.7 * (i / 4);
      fluid.splat(x, 0.95, (Math.random() - 0.5) * 300, -900 - Math.random() * 500, dim(i % 2 ? DYE.honey : DYE.amber, 0.42), 0.004);
    }
  }
  function stopFluid() {
    fluid?.dispose();
    fluid = null;
    canvas?.remove();
    canvas = null;
    governor?.clearCost("fluid");
  }

  function frame(now) {
    raf = 0;
    if (!open || document.visibilityState === "hidden") return;
    const cap = camMode || level() === "lite" ? 33 : 15; // ~30 / ~60 fps
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    paintTitle(now, dt);
    if (!fluid || now - lastStep < cap) return;
    const sdt = Math.min(1 / 30, (now - lastStep) / 1000);
    lastStep = now;
    if (camMode && now - lastHandAt > 1500) camMode = false; // hand gone: back to pointer mode
    if (!pointer && !camMode && now > nextAuto) {
      // ambient life when nobody's stirring: one soft amber curl
      nextAuto = now + 1400 + Math.random() * 1200;
      const x = 0.1 + Math.random() * 0.8, y = 0.55 + Math.random() * 0.4;
      fluid.splat(x, y, (Math.random() - 0.5) * 500, -300 - Math.random() * 400, dim(Math.random() < 0.8 ? DYE.honey : DYE.calm, 0.35), 0.003);
    }
    const t0 = performance.now();
    const [s, d] = wantRes();
    fluid.setResolution(s, d);
    fluid.step(sdt);
    fluid.render();
    governor?.cost("fluid", performance.now() - t0);
  }

  // ---- input: pointer / touch ---------------------------------------------
  function onPointerMove(e) {
    if (!fluid) return;
    const r = root.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (pointer) {
      const dx = x - pointer.x, dy = y - pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.0005) {
        const c = pointer.flip ? DYE.gold : DYE.amber;
        fluid.splat(x, y, dx * 6000, dy * 6000, dim(c, 0.28), 0.0025);
        pointer.flip = !pointer.flip;
      }
    }
    pointer = { x, y, flip: pointer?.flip ?? false };
  }
  const onPointerLeave = () => { pointer = null; };
  root.addEventListener("pointermove", onPointerMove);
  root.addEventListener("pointerleave", onPointerLeave);
  root.addEventListener("pointerdown", (e) => { pointer = null; onPointerMove(e); });

  // ---- buttons --------------------------------------------------------------
  startBtn.addEventListener("click", () => {
    const cb = onStart;
    close();
    cb?.();
  });
  handBtn?.addEventListener("click", async () => {
    if (!startCamera) return;
    statusEl.textContent = "Starting the camera…";
    try {
      await startCamera();
      statusEl.textContent = cameraLive()
        ? "Camera on. Wave your fingers: amber trails for your fingers, blue for your thumb."
        : "Couldn't start the camera. You can still stir with your mouse or finger.";
    } catch {
      statusEl.textContent = "Couldn't start the camera. You can still stir with your mouse or finger.";
    }
  });
  const onKey = (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); startBtn.click(); }
  };
  document.addEventListener("keydown", onKey, true);
  const onVis = () => { if (open && document.visibilityState === "visible" && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  document.addEventListener("visibilitychange", onVis);
  const onResize = () => { fluid?.resize(); };
  window.addEventListener("resize", onResize);
  governor?.subscribe((l) => {
    if (!open) return;
    if (l === "off") { stopFluid(); root.classList.add("hero-static"); finishTitle(); }
    else if (!fluid) startFluid();
  });

  // ---- hand tracking ------------------------------------------------------
  const tipDots = [];
  for (let i = 0; i < 5; i++) {
    const d = document.createElement("span");
    d.className = "hero-tip" + (i === 0 ? " thumb" : "");
    tipLayer?.append(d);
    tipDots.push(d);
  }
  function feedHands(list, mirrored) {
    if (!open) return;
    const hand = list?.[0];
    const now = performance.now();
    if (!hand) {
      prevTips = null;
      for (const d of tipDots) d.style.opacity = "0";
      if (cameraLive() && statusEl && now - lastHandAt > 1500) statusEl.textContent = "Camera on. Hold a hand up to the camera to stir the ink.";
      return;
    }
    lastHandAt = now;
    camMode = true;
    const w = root.clientWidth, h = root.clientHeight;
    const tips = TIPS.map((i) => ({ x: mirrored ? 1 - hand[i].x : hand[i].x, y: hand[i].y }));
    tips.forEach((p, i) => {
      tipDots[i].style.opacity = "1";
      tipDots[i].style.transform = `translate(${(p.x * w).toFixed(1)}px, ${(p.y * h).toFixed(1)}px)`;
    });
    if (fluid && prevTips) {
      const moves = tips
        .map((p, i) => ({ i, p, dx: p.x - prevTips[i].x, dy: p.y - prevTips[i].y }))
        .map((m) => ({ ...m, sp: Math.hypot(m.dx, m.dy) }))
        .filter((m) => m.sp > 0.002)
        .sort((a, b) => b.sp - a.sp)
        .slice(0, 3); // <= 3 splats per detection frame
      for (const m of moves) {
        const c = m.i === 0 ? DYE.calm : m.i % 2 ? DYE.amber : DYE.honey;
        const force = 4500;
        fluid.splat(m.p.x, m.p.y, m.dx * force, m.dy * force, dim(c, Math.min(0.5, 0.18 + m.sp * 6)), 0.0015 + Math.min(0.004, m.sp * 0.05));
      }
    }
    prevTips = tips;
  }

  // ---- open / close -------------------------------------------------------
  function openHero({ onStart: cb = null } = {}) {
    if (open) return;
    open = true;
    onStart = cb;
    returnFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add("hero-open");
    statusEl.textContent = cameraLive() ? "Camera on. Hold a hand up to the camera to stir the ink." : "";
    if (handBtn) handBtn.hidden = !startCamera || cameraLive();
    if (animated()) {
      startFluid();
      titleDone = false;
      for (const L of letters) { L.s = { x: 0, v: 0 }; L.gs = { x: 0, v: 0 }; L.g.style.opacity = "0"; L.shape.style.opacity = "0"; }
      // wait (briefly) for the dataset so letters can start as handshapes
      Promise.race([shapesReady, new Promise((r) => setTimeout(r, 1200))]).then(() => {
        if (!open) return;
        drawShapes();
        titleT0 = performance.now();
      });
      titleT0 = Infinity;
    } else {
      root.classList.add("hero-static");
      finishTitle();
    }
    last = performance.now();
    if (!raf) raf = requestAnimationFrame(frame);
    requestAnimationFrame(() => startBtn.focus());
  }
  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    raf = 0;
    stopFluid();
    finishTitle();
    pointer = prevTips = null;
    camMode = false;
    for (const d of tipDots) d.style.opacity = "0";
    root.hidden = true;
    document.documentElement.classList.remove("hero-open");
    if (returnFocus && document.contains(returnFocus) && returnFocus !== document.body) returnFocus.focus?.();
  }

  return {
    open: openHero,
    close,
    isOpen: () => open,
    feedHands,
    bench(frames = 60) {
      if (!fluid) return null;
      const gl = fluid.gl;
      const px = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        fluid.splat(0.3 + 0.4 * Math.random(), 0.5, 200, -200, dim(DYE.amber, 0.3), 0.0025);
        fluid.step(1 / 60);
        fluid.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      return { msPerFrame: (performance.now() - t0) / frames, ...fluid.resolution, canvas: [canvas.width, canvas.height] };
    },
    // test hooks (?debug): drive the title/fluid without rAF (hidden tabs)
    ...(debug ? { _tick(ms = 16) { const now = last + ms; paintTitle(now, ms / 1000); last = now; if (fluid) { fluid.step(ms / 1000); fluid.render(); } } } : {}),
  };
}
