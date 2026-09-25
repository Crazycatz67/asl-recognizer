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
//   fx.burst(x, y, opts?)       // particles from page coords (CSS px);
//                               //   opts {count=40, colors, stars}
//   fx.flash(color?)            // ~440 ms edge glow (any CSS colour)
//   fx.ring(x, y, opts?)        // expanding ring(s) — "locked in" on the hand;
//                               //   opts {color, rings=1, radius=70}
//   fx.rain(opts?)              // confetti falling across the whole screen
//                               //   (A->Z finale); opts {count=140, colors}
//   fx.moment(text, opts?)      // a big short-lived label ("First A!") at a
//                               //   page point; opts {x, y, tone: first|mastery|finale}
//
// ACCESSIBILITY: respects prefers-reduced-motion live — burst()/rain() are
//   skipped, flash() is shortened to 160 ms, ring() draws a still ring that
//   fades in place, and moment() fades without scaling (CSS). Everything is
//   pointer-events:none and aria-hidden — the toast carries the words for
//   screen readers.
//
// GOTCHA: particle physics is stepped per animation frame (not per ms), so a
//   burst plays faster on a 120 Hz display than on a 60 Hz one.

/**
 * Create the overlay canvas and return the effect triggers.
 * @returns {{burst: Function, flash: Function, ring: Function, rain: Function, moment: Function}}
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
  let rings = [];
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
        if (p.star) star(p.r * 1.6);
        else ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
        ctx.restore();
        next.push(p);
      }
      parts = next;
      ctx.globalAlpha = 1;
    }

    if (rings.length) {
      rings = rings.filter((g) => now < g.t0 + g.ms);
      for (const g of rings) {
        if (now < g.t0) continue;
        const k = (now - g.t0) / g.ms; // 0 -> 1
        const ease = 1 - Math.pow(1 - k, 3);
        const rad = g.still ? g.r : g.r * (0.25 + 0.75 * ease);
        ctx.globalAlpha = Math.max(0, 1 - k) * 0.9;
        ctx.strokeStyle = g.color;
        ctx.lineWidth = g.still ? 3 : Math.max(1, 5 * (1 - k));
        ctx.beginPath();
        ctx.arc(g.x, g.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    if (parts.length || rings.length || now < flashUntil) raf = requestAnimationFrame(tick);
    else raf = 0;
  }
  const wake = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  // 5-point star path around the current origin (first-time / mastery sparkle)
  function star(R) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? R * 0.45 : R;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  }
  const GREENS = ["#22c55e", "#4ade80", "#a7f3d0", "#f8fafc", "#fde047"];
  let momentEl = null;
  let momentTimer = 0;

  return {
    // page-space (x, y) — origin of the burst
    burst(x, y, { count = 40, colors = GREENS, stars = false } = {}) {
      if (reduce) return;
      const N = Math.max(1, Math.min(90, Math.round(count)));
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
          star: stars && i % 3 === 0,
          life,
          max: life,
        });
      }
      wake();
    },

    // "locked in" ring(s) expanding from a point on the hand; staggered when
    // there are several. Reduced motion: a still ring that just fades.
    ring(x, y, { color = "#4ade80", rings: n = 1, radius = 70 } = {}) {
      const now = performance.now();
      const k = Math.max(1, Math.min(4, Math.round(n)));
      for (let i = 0; i < k; i++) {
        rings.push({
          x, y, color,
          r: radius * (1 + i * 0.35),
          t0: now + (reduce ? 0 : i * 110),
          ms: reduce ? 380 : 520,
          still: reduce,
        });
      }
      wake();
    },

    // confetti falling across the whole screen — the A->Z finale
    rain({ count = 140, colors = ["#22c55e", "#38bdf8", "#fde047", "#f472b6", "#f8fafc"] } = {}) {
      if (reduce) return;
      const W = window.innerWidth;
      const N = Math.max(1, Math.min(220, Math.round(count)));
      for (let i = 0; i < N; i++) {
        const life = 90 + Math.random() * 70;
        parts.push({
          x: Math.random() * W,
          y: -20 - Math.random() * 160,
          vx: (Math.random() - 0.5) * 2.2,
          vy: 1 + Math.random() * 2.5,
          r: 3 + Math.random() * 3.5,
          rot: Math.random() * 7,
          spin: (Math.random() - 0.5) * 0.3,
          color: colors[i % colors.length],
          star: i % 5 === 0,
          life,
          max: life,
        });
      }
      wake();
    },

    // a short big label at a page point ("First A!", "A mastered"). One at a
    // time: a new moment replaces the old. Purely decorative — aria-hidden,
    // pointer-events:none; the caller's toast says it for screen readers.
    moment(text, { x = window.innerWidth / 2, y = window.innerHeight / 2, tone = "first", ms = 1300 } = {}) {
      if (!momentEl) {
        momentEl = document.createElement("div");
        momentEl.className = "fx-moment";
        momentEl.setAttribute("aria-hidden", "true");
        momentEl.style.pointerEvents = "none"; // inline too: never block a tap, even without style.css
        document.body.appendChild(momentEl);
      }
      momentEl.textContent = String(text);
      momentEl.dataset.tone = tone;
      momentEl.style.left = `${Math.round(x)}px`;
      momentEl.style.top = `${Math.round(y)}px`;
      momentEl.classList.remove("show");
      void momentEl.offsetWidth; // restart the animation
      momentEl.classList.add("show");
      clearTimeout(momentTimer);
      momentTimer = setTimeout(() => momentEl && momentEl.classList.remove("show"), ms);
    },

    flash(color = "#22c55e") {
      flashColor = color;
      flashUntil = performance.now() + (reduce ? 160 : FLASH_MS);
      wake();
    },
  };
}
