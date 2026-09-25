// =============================================================================
// js/bg.js — living ambient background that reacts to the match (Browser UI)
// =============================================================================
// WHAT: Big soft blobs drift behind everything; their colour eases warm
//   (far) -> amber (close) -> green (matched). With no target or no hand it
//   shows a calm cool-blue "breathing" ambience instead.
//
//   It's also SPATIAL: each blob is anchored to a screen region (top, thumb
//   side, pinky side, centre). If your fingers are wrong the top of the page
//   stays amber/red and drifts more; if the thumb is off, that side reacts —
//   so the background is a soft "where's the problem" map, not just a global
//   colour.
//
// WHERE IT SITS: presentation only. In Practice, main.js feeds it
//   reference.score() and reference.regionErrors() every frame; every other
//   mode calls setMatch(null) to return it to idle.
//
// PUBLIC API:
//   const bg = createBackground({ governor }?);   // prepends a fixed canvas
//     governor (js/fxquality.js, optional): "off" freezes the field after one
//     frame (reduced motion / manual Effects Off / hidden tab), "lite" caps it
//     at ~5 fps. Used as aurora.js's fallback (no WebGL2 / lost context).
//   bg.setMatch(score, bucket, regions);
//     score   : 0..1 overall shape match
//     bucket  : "off" | "close" | "correct" | null   (null/absent score -> idle)
//     regions : { top, left, right } each 0..1 error (higher = more wrong) — optional
//   bg.stop()                        // cancel the loop and remove the canvas
//
// PERFORMANCE: renders into a small 480-px-wide backing canvas that CSS
//   stretches to full screen — it's all blur anyway, so this keeps the
//   always-on rAF loop cheap.

/**
 * Create the ambient background canvas and start its animation loop.
 * @returns {{setMatch: (score: (number|null), bucket?: (string|null),
 *   regions?: {top?: number, left?: number, right?: number}) => void, stop: () => void}}
 */
export function createBackground({ governor = null } = {}) {
  // Read once AND stay live — see fx.js's identical comment: a mid-session
  // OS-level toggle should take effect on the very next frame, not wait for
  // a reload.
  const motionQuery = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduce = motionQuery ? motionQuery.matches : false;
  motionQuery?.addEventListener?.("change", (e) => { reduce = e.matches; });

  const cv = document.createElement("canvas");
  cv.setAttribute("aria-hidden", "true");
  Object.assign(cv.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    zIndex: "-1",
    pointerEvents: "none",
  });
  document.body.prepend(cv);
  const ctx = cv.getContext("2d");

  // backing-store size in canvas px: fixed width, height follows the window's aspect
  const BW = 480;
  let BH = 300;
  const resize = () => {
    BH = Math.round((BW * window.innerHeight) / window.innerWidth) || 300;
    cv.width = BW;
    cv.height = BH;
  };
  resize();
  window.addEventListener("resize", resize);

  // hue by "greenness": 0 -> warm red-orange, ~0.5 -> amber, 1 -> green
  const hueFor = (g) => (g <= 0.5 ? 16 + 48 * g : 40 + 100 * (g - 0.5));

  // blobs anchored to screen regions
  const blobs = [
    { region: "top", x: 0.28, y: 0.16 },
    { region: "top", x: 0.72, y: 0.16 },
    { region: "left", x: 0.12, y: 0.52 },
    { region: "right", x: 0.9, y: 0.52 },
    { region: "overall", x: 0.5, y: 0.9 },
  ].map((b, i) => ({
    ...b,
    r: 0.5 + Math.random() * 0.28,
    ph: Math.random() * 7,
    spd: 0.045 + Math.random() * 0.05,
    hue: 220,
    energy: 0,
  }));

  let want = { greenness: 0, energy: 0, regions: { top: 0, left: 0, right: 0 } };
  let idle = true; // no target / no hand yet — show a calm living ambience
  let raf = 0;
  let last = performance.now();
  let level = governor?.level ?? "full";
  let frozenDrawn = false;
  let lastKey = "idle";
  const unsub = governor?.subscribe((l) => {
    level = l;
    frozenDrawn = false;
    if (!raf) { last = 0; raf = requestAnimationFrame(frame); }
  });

  // ---- animation loop (runs continuously until stop()) ----
  function frame(now) {
    // slow ambient drift doesn't need the display's full 60-120 Hz — every
    // repaint is 5 radial gradients composited full-screen, so cap it at ~30
    // (dt below still eases by real elapsed time, so motion speed is unchanged)
    if (level === "off" && frozenDrawn) { raf = 0; return; } // static: resumed by the governor
    if (now - last < (level === "lite" ? 200 : 30)) {
      raf = requestAnimationFrame(frame);
      return;
    }
    if (level === "off") frozenDrawn = true;
    const dt = level === "off" ? 1 : Math.min(0.05, (now - last) / 1000); // off: jump straight to the target colours
    last = now;
    const t = now / 1000;
    const k = 1 - Math.pow(0.0015, dt); // ease factor

    // whole-field slow "breath" — most visible at idle, subtle when active
    const breath = 0.5 + 0.5 * Math.sin(t * 0.55);

    ctx.clearRect(0, 0, BW, BH);
    ctx.globalCompositeOperation = "lighter";

    for (const b of blobs) {
      let wantHue, wantEnergy, move;

      if (idle) {
        // calm cool ambience: cyan/blue blobs, gently pulsing and drifting,
        // each a little out of phase so the field feels alive, not looping
        wantHue = 198 + 20 * Math.sin(t * 0.16 + b.ph);
        wantEnergy = 0.22 + 0.12 * (0.5 + 0.5 * Math.sin(t * 0.5 + b.ph));
        move = reduce ? 0.015 : 0.05;
        b.hue += (wantHue - b.hue) * k * 1.4;
      } else {
        // region error pulls this blob's greenness back down
        const regErr = b.region === "overall" ? 0 : want.regions[b.region] || 0;
        const localGreen = Math.max(0, want.greenness - regErr * 0.9);
        wantHue = hueFor(localGreen);
        // a wrong region stays energetic (lit + moving); calm when fine
        wantEnergy = Math.min(1, want.energy * (0.55 + 0.9 * (regErr + 0.15)));
        move = reduce ? 0.02 : 0.06 + 0.12 * (b.region === "overall" ? want.energy : regErr);
        b.hue += (wantHue - b.hue) * k * 2.4;
      }

      b.energy += (wantEnergy - b.energy) * k * 2;

      const x = (b.x + Math.sin(t * b.spd + b.ph) * move) * BW;
      const y = (b.y + Math.cos(t * b.spd * 0.9 + b.ph) * move * 1.1) * BH;
      const pulse = idle ? 0.88 + 0.12 * breath : 0.92 + 0.08 * Math.sin(t * 0.25 + b.ph);
      const rad = b.r * Math.max(BW, BH) * pulse;

      const sat = 32 + 52 * b.energy;
      const lig = 13 + 16 * b.energy;
      const alpha = (idle ? 0.14 : 0.09) + 0.5 * b.energy;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `hsla(${b.hue}, ${sat}%, ${lig + 7}%, ${alpha})`);
      g.addColorStop(1, `hsla(${b.hue}, ${sat}%, ${lig}%, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalCompositeOperation = "source-over";
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    setMatch(score, bucket, regions) {
      // frozen (off): redraw one still frame only when the state really changes
      const key = score == null || bucket == null ? "idle" : bucket;
      if (level === "off" && frozenDrawn && !raf && key !== lastKey) { frozenDrawn = false; raf = requestAnimationFrame(frame); }
      lastKey = key;
      if (score == null || bucket == null) {
        idle = true;
        want = { greenness: 0, energy: 0, regions: { top: 0, left: 0, right: 0 } };
        return;
      }
      idle = false;
      want = {
        greenness: bucket === "correct" ? 1 : Math.max(0.08, Math.min(0.85, score)),
        energy: bucket === "off" ? 0.5 : bucket === "close" ? 0.8 : 1,
        regions: {
          top: regions?.top ?? 0,
          left: regions?.left ?? 0,
          right: regions?.right ?? 0,
        },
      };
    },
    stop() {
      cancelAnimationFrame(raf);
      unsub?.();
      cv.remove();
    },
  };
}
