// Living ambient background. Big soft blobs drift behind everything; their
// colour eases warm (far) -> amber (close) -> green (matched).
//
// It's also SPATIAL: each blob is anchored to a screen region (top, thumb side,
// pinky side, centre). If your fingers are wrong the top of the page stays
// amber/red and drifts more; if the thumb is off, that side reacts — so the
// background is a soft "where's the problem" map, not just a global colour.
//
//   const bg = createBackground();
//   bg.setMatch(score, bucket, regions);
//     score   : 0..1 overall shape match
//     bucket  : "off" | "close" | "correct" | null
//     regions : { top, left, right } each 0..1 error (higher = more wrong) — optional

export function createBackground() {
  const reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
  let raf = 0;
  let last = performance.now();

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    const k = 1 - Math.pow(0.0015, dt); // ease factor

    ctx.clearRect(0, 0, BW, BH);
    ctx.globalCompositeOperation = "lighter";

    for (const b of blobs) {
      // region error pulls this blob's greenness back down
      const regErr = b.region === "overall" ? 0 : want.regions[b.region] || 0;
      const localGreen = Math.max(0, want.greenness - regErr * 0.9);
      const wantHue = hueFor(localGreen);
      b.hue += (wantHue - b.hue) * k * 2.4;

      // a wrong region stays energetic (lit + moving); calm when fine
      const wantEnergy = Math.min(1, want.energy * (0.55 + 0.9 * (regErr + 0.15)));
      b.energy += (wantEnergy - b.energy) * k * 2;

      const move = reduce ? 0.02 : 0.06 + 0.12 * (b.region === "overall" ? want.energy : regErr);
      const x = (b.x + Math.sin(t * b.spd + b.ph) * move) * BW;
      const y = (b.y + Math.cos(t * b.spd * 0.9 + b.ph) * move * 1.1) * BH;
      const rad = b.r * Math.max(BW, BH) * (0.92 + 0.08 * Math.sin(t * 0.25 + b.ph));

      const sat = 28 + 58 * b.energy;
      const lig = 11 + 17 * b.energy;
      const alpha = 0.09 + 0.5 * b.energy;
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
      if (score == null || bucket == null) {
        want = { greenness: 0, energy: 0, regions: { top: 0, left: 0, right: 0 } };
        return;
      }
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
      cv.remove();
    },
  };
}
