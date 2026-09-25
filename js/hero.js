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
// A11Y: a real modal while open — every other child of <body> is `inert`
//   (no Tab, no screen-reader reach into the app underneath), Tab cycles
//   inside the hero, Escape = Start, focus returns where it was on close.
//
// BUDGET: the sim only runs while the hero is open (its textures are freed on
//   close; the ONE WebGL context is kept and reused on the next open). Full:
//   sim 128 / dye 512 at up to 60 fps; "lite": dye 256 at <= 30 fps; with the
//   camera on (detection shares the GPU): sim 96 / dye 256, 12 Jacobi passes,
//   <= 24 fps; "off" / reduced motion: a
//   static amber-on-deep gradient and the finished title — no sim, no
//   springs. Paused while the tab is hidden. ?debug reports "fluid" ms.
//
// PUBLIC API:
//   const hero = createHero({ root, governor, shapeFor, shapesReady,
//                             startCamera, cameraLive, debug });
//   hero.open({ onStart })   // onStart runs after the user taps Start
//   hero.close()
//   hero.isOpen()
//   hero.feedHands(landmarksList, mirrored, video, handedness)  // from the
//                            // detection loop (up to 2 hands: orange + blue ink);
//                            // tips are mapped through the video's
//                            // object-fit: cover so dots sit where the hand is
//   hero.dispose()           // drop listeners + the GL context (tests)
//   hero.bench(frames)       // ?debug: ms per sim+render frame (sync)

import { createFluid } from "./fluid.js";
import { springStep, coverMap } from "./fxmath.js";
import { drawHandShape, vectorToPixels } from "./skeleton.js";

const TITLE = "Fingerspell with your hands";
const TIPS = [4, 8, 12, 16, 20];
// Owner 2026-09-25: only the word "hands" is fingerspelled, ONE letter at a
// time and in place: its handshape appears where the letter goes, holds,
// then turns into the letter, then the next. The other words just pop in.
const SIGNED_WORD = "hands";
const TITLE_STAGGER_MS = 40; // the plain words' letters pop in this far apart
const SIGN_SHOW_MS = 900; // each sign holds this long, then becomes its letter
const SIGN_GAP_MS = 250; // the letter settles before the next sign appears
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const DYE = {
  amber: hex("#fbbf24"),
  honey: hex("#e8a33a"),
  gold: hex("#ffc861"),
  ember: hex("#b45309"),
  calm: hex("#38bdf8"),
};
// Owner 2026-09-25: the hero was "really laggy and overbearing, especially
// with the hand — more toned down and fluid rather than vibrant". So: slow,
// smooth, low-contrast ink (little curl, motion and ink fade out steadily),
// faint dye, gentle forces, and a much lighter GPU budget. One place to tune.
const FEEL = {
  curl: 4, // was 22: fewer tight eddies -> smooth, flowing ink
  velDiss: 1.1, // was 0.25: motion settles instead of churning
  dyeDiss: 1.3, // was 0.9: ink fades rather than piling up into bright blobs
  dpr: 0.5, // draw at half resolution (soft anyway; ~4x fewer pixels)
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
  let inerted = [];

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
  // per ink hand (0 = orange, 1 = blue): EMA-smoothed tips + last frame's
  let handTips = [null, null];
  let lastHandAt = 0;
  let camMode = false;

  // ---- title markup (built once; screen readers get the aria-label) -------
  titleEl.setAttribute("aria-label", TITLE);
  titleEl.textContent = "";
  let idx = 0;
  const words = TITLE.split(" ");
  const plainCount = words.filter((wd) => wd.toLowerCase() !== SIGNED_WORD).join("").length;
  let signIdx = 0;
  for (const word of words) {
    const signed = word.toLowerCase() === SIGNED_WORD;
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
      if (signed) {
        // hover / tap a letter of "hands" later to see its sign again
        const peek = (on) => l.classList.toggle("hk-peek", on && titleDone && !!letters.find((x) => x.el === l)?.drawn);
        l.addEventListener("pointerenter", () => peek(true));
        l.addEventListener("pointerleave", () => peek(false));
        l.addEventListener("click", () => { peek(true); setTimeout(() => peek(false), 1400); });
      }
      // start time: plain letters pop in quickly; the signed word's letters
      // follow one after another once the plain words are in
      const start = signed
        ? plainCount * TITLE_STAGGER_MS + 200 + signIdx++ * (SIGN_SHOW_MS + SIGN_GAP_MS)
        : idx * TITLE_STAGGER_MS;
      letters.push({ ch: ch.toUpperCase(), el: l, shape, g, i: idx++, signed, start, s: { x: 0, v: 0 }, gs: { x: 0, v: 0 }, drawn: false });
    }
    titleEl.append(w, document.createTextNode(" "));
  }

  function drawShapes() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const L of letters) {
      if (!L.signed) { L.drawn = false; continue; }
      const vec = shapeFor(L.ch);
      if (!vec) { L.drawn = false; continue; }
      const box = L.el.getBoundingClientRect();
      // big enough to read the handshape; shown in place of its letter
      const size = Math.max(40, Math.round(box.height * 1.5));
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
      // "hands": sign -> letter, one at a time (see SIGNED_WORD)
      const t = now - titleT0 - L.start;
      const shapeTarget = L.drawn && t > 0 && t < SIGN_SHOW_MS ? 1 : 0;
      const glyphTarget = t > (L.drawn ? SIGN_SHOW_MS - 80 : 0) ? 1 : 0;
      L.s = springStep(L.s, shapeTarget, { k: 140, c: 17 }, dt);
      L.gs = springStep(L.gs, glyphTarget, { k: 110, c: 13 }, dt);
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
  // with the camera on, detection shares the GPU: coarser sim, fewer Jacobi
  // passes and <= 24 fps (review: keep detection >= 28/s in the hero)
  function wantRes() {
    return camMode ? [48, 160] : level() === "lite" ? [64, 192] : [80, 256];
  }
  let fluidFailed = false;
  function startFluid() {
    if (!animated() || fluidFailed) return;
    if (fluid && !fluid.asleep) return;
    if (fluid) {
      // reuse the one context: only the textures were freed on close
      canvas.hidden = false;
      fluid.wake();
    } else {
      canvas = document.createElement("canvas");
      canvas.className = "hero-fluid";
      canvas.setAttribute("aria-hidden", "true");
      stage.prepend(canvas);
      const [s, d] = wantRes();
      fluid = createFluid(canvas, { simRes: s, dyeRes: d, background: BG_DEEP, ...FEEL });
      if (!fluid) { canvas.remove(); canvas = null; fluidFailed = true; root.classList.add("hero-static"); return; }
      canvas.addEventListener("webglcontextlost", () => { fluid = null; canvas?.remove(); canvas = null; fluidFailed = true; root.classList.add("hero-static"); });
    }
    root.classList.remove("hero-static");
    // opening swirl: a few amber splats from the bottom edge
    for (let i = 0; i < 3; i++) {
      const x = 0.25 + 0.25 * i;
      fluid.splat(x, 0.95, (Math.random() - 0.5) * 120, -320 - Math.random() * 160, dim(i % 2 ? DYE.honey : DYE.ember, 0.16), 0.008);
    }
  }
  // free the textures, keep the context for the next open (no churn of
  // lost contexts when the logo is tapped repeatedly)
  function stopFluid() {
    if (fluid && !fluid.asleep) fluid.sleep();
    if (canvas) canvas.hidden = true;
    governor?.clearCost("fluid");
  }

  function frame(now) {
    raf = 0;
    if (!open || document.visibilityState === "hidden") return;
    const cap = camMode ? 50 : level() === "lite" ? 40 : 33; // ~20 / ~25 / ~30 fps (slow ink doesn't need more)
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    paintTitle(now, dt);
    if (!fluid || fluid.asleep || now - lastStep < cap) return;
    const sdt = Math.min(1 / 30, (now - lastStep) / 1000);
    lastStep = now;
    if (camMode && now - lastHandAt > 1500) camMode = false; // hand gone: back to pointer mode
    if (!pointer && !camMode && now > nextAuto) {
      // ambient life when nobody's stirring: one soft amber curl
      nextAuto = now + 2600 + Math.random() * 1800;
      const x = 0.1 + Math.random() * 0.8, y = 0.6 + Math.random() * 0.35;
      fluid.splat(x, y, (Math.random() - 0.5) * 160, -120 - Math.random() * 120, dim(Math.random() < 0.8 ? DYE.honey : DYE.calm, 0.1), 0.008);
    }
    const t0 = performance.now();
    const [s, d] = wantRes();
    fluid.setResolution(s, d);
    fluid.setIterations(camMode ? 8 : 12);
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
        fluid.splat(x, y, dx * 2200, dy * 2200, dim(c, 0.1), 0.005);
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
        ? "Camera on. Hold up both hands: one paints orange, the other blue."
        : "Couldn't start the camera. You can still stir with your mouse or finger.";
    } catch {
      statusEl.textContent = "Couldn't start the camera. You can still stir with your mouse or finger.";
    }
  });
  const onKey = (e) => {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); startBtn.click(); return; }
    if (e.key === "Tab") {
      // focus trap: cycle through the hero's own visible buttons
      const f = [...root.querySelectorAll("button:not([disabled])")].filter((b) => !b.hidden && b.getClientRects().length);
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i === -1 || i === f.length - 1 ? 0 : i + 1);
      e.preventDefault();
      f[next].focus();
    }
  };
  document.addEventListener("keydown", onKey, true);
  const onVis = () => { if (open && document.visibilityState === "visible" && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  document.addEventListener("visibilitychange", onVis);
  const onResize = () => { fluid?.resize(); };
  window.addEventListener("resize", onResize);
  const unsubGov = governor?.subscribe((l) => {
    if (!open) return;
    if (l === "off") { stopFluid(); root.classList.add("hero-static"); finishTitle(); }
    else if (!fluid || fluid.asleep) startFluid();
  });

  // ---- hand tracking ------------------------------------------------------
  // Two-hand ink (owner 2026-09-25): one hand paints orange, the other
  // blue — use both to mix them. Tip dots are a shape twin too: round =
  // orange hand, square = blue hand. (No camera preview: the dots show
  // where your hands are.)
  const INK = [
    { main: hex("#fb923c"), alt: DYE.honey },
    { main: DYE.calm, alt: hex("#60a5fa") },
  ];
  const tipDots = [[], []];
  for (const k of [0, 1]) {
    for (let i = 0; i < 5; i++) {
      const d = document.createElement("span");
      d.className = `hero-tip ink-${k ? "blue" : "orange"}`;
      tipLayer?.append(d);
      tipDots[k].push(d);
    }
  }
  const hideDots = (k) => { for (const d of tipDots[k]) d.style.opacity = "0"; };
  // which ink each detected hand paints: by MediaPipe's handedness when the
  // two labels differ (stable even if hands cross), else by screen side
  function inkSlots(list, handedness, mirrored) {
    const labels = (handedness || []).map((h) => h?.[0]?.categoryName || null);
    if (list.length === 1) return [labels[0] === "Left" ? 1 : 0];
    if (labels[0] && labels[1] && labels[0] !== labels[1]) return labels.map((l) => (l === "Left" ? 1 : 0));
    const sx = (hd) => (mirrored ? 1 - hd[0].x : hd[0].x);
    return sx(list[0]) <= sx(list[1]) ? [0, 1] : [1, 0];
  }
  function feedHands(list, mirrored, video = null, handedness = null) {
    if (!open) return;
    const now = performance.now();
    const hands = (list || []).slice(0, 2);
    if (!hands.length) {
      handTips = [null, null];
      hideDots(0); hideDots(1);
      if (cameraLive() && statusEl && now - lastHandAt > 1500) statusEl.textContent = "Camera on. Hold up both hands: one paints orange, the other blue.";
      return;
    }
    lastHandAt = now;
    camMode = true;
    if (statusEl) statusEl.textContent = hands.length === 1
      ? "Now bring in your other hand to add the other colour."
      : "Mix them: move both hands through the ink.";
    const w = root.clientWidth || 1, h = root.clientHeight || 1;
    const vw = video?.videoWidth || 0, vh = video?.videoHeight || 0;
    const slots = inkSlots(hands, handedness, mirrored);
    const seen = [false, false];
    hands.forEach((hand, n) => {
      const k = slots[n];
      if (seen[k]) return; // two hands mapped to one ink: keep the first
      seen[k] = true;
      // map through object-fit: cover so the dots sit where the hand is
      const raw = TIPS.map((i) => {
        const q = coverMap(mirrored ? 1 - hand[i].x : hand[i].x, hand[i].y, vw, vh, w, h);
        return { x: q.x / w, y: q.y / h };
      });
      // smooth the tips so tracking jitter doesn't stir the ink every frame
      const prev = handTips[k];
      const tips = prev ? raw.map((p, i) => ({ x: prev[i].x + (p.x - prev[i].x) * 0.35, y: prev[i].y + (p.y - prev[i].y) * 0.35 })) : raw;
      tips.forEach((p, i) => {
        tipDots[k][i].style.opacity = "1";
        tipDots[k][i].style.transform = `translate(${(p.x * w).toFixed(1)}px, ${(p.y * h).toFixed(1)}px)`;
      });
      if (fluid && prev) {
        const moves = tips
          .map((p, i) => ({ i, p, dx: p.x - prev[i].x, dy: p.y - prev[i].y }))
          .map((m) => ({ ...m, sp: Math.hypot(m.dx, m.dy) }))
          .filter((m) => m.sp > 0.004)
          .sort((a, b) => b.sp - a.sp)
          .slice(0, 2); // <= 2 gentle splats per hand per detection frame
        for (const m of moves) {
          const c = m.i % 2 ? INK[k].main : INK[k].alt;
          fluid.splat(m.p.x, m.p.y, m.dx * 1600, m.dy * 1600, dim(c, Math.min(0.16, 0.07 + m.sp * 2)), 0.004 + Math.min(0.003, m.sp * 0.04));
        }
      }
      handTips[k] = tips;
    });
    for (const k of [0, 1]) if (!seen[k]) { handTips[k] = null; hideDots(k); }
  }

  // ---- open / close -------------------------------------------------------
  function openHero({ onStart: cb = null } = {}) {
    if (open) return;
    open = true;
    onStart = cb;
    returnFocus = document.activeElement;
    root.hidden = false;
    document.documentElement.classList.add("hero-open");
    // modal: the app underneath is unreachable (Tab / screen readers)
    const host = [...document.body.children].find((c) => c === root || c.contains(root));
    inerted = [...document.body.children].filter((c) => c !== host && !c.inert);
    for (const c of inerted) c.inert = true;
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
    pointer = null;
    handTips = [null, null];
    camMode = false;
    hideDots(0); hideDots(1);
    for (const c of inerted) c.inert = false;
    inerted = [];
    root.hidden = true;
    document.documentElement.classList.remove("hero-open");
    if (returnFocus && document.contains(returnFocus) && returnFocus !== document.body) returnFocus.focus?.();
  }

  return {
    open: openHero,
    close,
    isOpen: () => open,
    feedHands,
    dispose() {
      close();
      unsubGov?.();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
      fluid?.dispose();
      fluid = null;
      canvas?.remove();
      canvas = null;
    },
    bench(frames = 60) {
      if (!fluid || fluid.asleep) return null;
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
