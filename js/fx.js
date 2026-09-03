// Lightweight celebration effects on a full-viewport overlay canvas: a particle
// burst and a soft screen glow. Self-manages a rAF that only runs while
// something is animating. Respects prefers-reduced-motion.

export function createFx() {
  const reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
