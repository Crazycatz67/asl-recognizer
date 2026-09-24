// =============================================================================
// js/fx.js — celebration particles + screen glow (Browser UI)
// =============================================================================
// WHAT: Lightweight celebration effects on a full-viewport overlay canvas: a
//   particle burst (e.g. confetti from the fingertip when a letter is
//   nailed) and a soft coloured glow around the screen edge (success, delete,
//   copy/paste feedback). Self-manages a requestAnimationFrame loop that only
//   runs while something is animating, so it costs nothing when idle.
//
// WHERE IT SITS: pure presentation — main.js calls it from reward() and the
//   Spell-mode gesture handlers. Not part of recognition.
//
// PUBLIC API:
//   const fx = createFx();      // appends a fixed, click-through <canvas>
//   fx.burst(x, y)              // ~40 particles from page coords (CSS px)
//   fx.flash(color?)            // ~440 ms edge glow (any CSS colour)
//
// ACCESSIBILITY: respects prefers-reduced-motion live — burst() is skipped
//   and flash() is shortened to 160 ms while it's on.
//
// GOTCHA: particle physics is stepped per animation frame (not per ms), so a
//   burst plays faster on a 120 Hz display than on a 60 Hz one.

/**
 * Create the overlay canvas and return the effect triggers.
 * @returns {{burst: (x: number, y: number) => void, flash: (color?: string) => void}}
 */
export function createFx() {
  // Read once AND stay live — a user who turns on reduced-motion mid-session
  // (e.g. feeling motion-sick) needs the next burst()/flash() to respect it
  // immediately, not just on the next page load.
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
    pointerEvents: "none",
    zIndex: "60",
  });
  document.body.appendChild(cv);
  const ctx = cv.getContext("2d");

  let parts = [];
  let flashUntil = 0;
  let flashColor = "#22c55e";
  let raf = 0;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = window.innerWidth * dpr;
    cv.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  const FLASH_MS = 440;

  // ---- animation loop: draw glow, then step + draw particles ----
  function tick() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const now = performance.now();

    if (now < flashUntil) {
      const a = (flashUntil - now) / FLASH_MS;
      const g = ctx.createRadialGradient(
        W / 2, H / 2, Math.min(W, H) * 0.28,
        W / 2, H / 2, Math.max(W, H) * 0.75
      );
      g.addColorStop(0, "transparent");
      g.addColorStop(1, flashColor);
      ctx.globalAlpha = 0.55 * a;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    if (parts.length) {
      const next = [];
      for (const p of parts) {
        p.life--;
        if (p.life <= 0) continue;
        p.vy += 0.14;
        p.vx *= 0.985;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.spin;
        ctx.globalAlpha = Math.max(0, p.life / p.max);
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
        ctx.restore();
        next.push(p);
      }
      parts = next;
      ctx.globalAlpha = 1;
    }

    if (parts.length || now < flashUntil) raf = requestAnimationFrame(tick);
    else raf = 0;
  }
  const wake = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };

  return {
    // page-space (x, y) — origin of the burst
    burst(x, y) {
      if (reduce) return;
      const colors = ["#22c55e", "#4ade80", "#a7f3d0", "#f8fafc", "#fde047"];
      const N = 40;
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2 + Math.random() * 0.5;
        const sp = 3.5 + Math.random() * 7;
        const life = 32 + Math.random() * 26;
        parts.push({
          x, y,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 2.5,
          r: 2.5 + Math.random() * 3.5,
          rot: Math.random() * 7,
          spin: (Math.random() - 0.5) * 0.4,
          color: colors[i % colors.length],
          life,
          max: life,
        });
      }
      wake();
    },

    flash(color = "#22c55e") {
      flashColor = color;
      flashUntil = performance.now() + (reduce ? 160 : FLASH_MS);
      wake();
    },
  };
}
