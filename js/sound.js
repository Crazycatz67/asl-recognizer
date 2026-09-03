// Tiny synthesized sound — no audio files. Web Audio needs a user gesture to
// start, so call resume() from the first click (the "Turn on camera" button).
// Mute state persists in localStorage.

export function createSound() {
  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem("asl-muted") === "1";
  } catch {}

  const ensure = () => {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        ctx = null;
      }
    }
    if (ctx && ctx.state === "suspended") ctx.resume();
    return ctx;
  };

  // one note with a soft attack + exponential decay
  const tone = (freq, at, dur, { type = "triangle", gain = 0.12 } = {}) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.03);
  };

  // persistent "charging" voice while a completed sign is being held — a low
  // tone that rises in pitch and volume as progress 0 -> 1, then resolves into
  // success(). charge(p<=0) or chargeStop() ends it.
  let chg = null;
  const chargeStop = (fade = 0.12) => {
    if (!chg || !ctx) return;
    const c = chg;
    chg = null;
    const n = ctx.currentTime;
    try {
      c.g.gain.cancelScheduledValues(n);
      c.g.gain.setValueAtTime(Math.max(0.0001, c.g.gain.value), n);
      c.g.gain.linearRampToValueAtTime(0.0001, n + fade);
      c.o.stop(n + fade + 0.03);
      c.o2.stop(n + fade + 0.03);
    } catch {}
  };

  return {
    resume() {
      ensure();
    },
    get muted() {
      return muted;
    },
    setMuted(m) {
      muted = !!m;
      if (muted) chargeStop(0.05);
      try {
        localStorage.setItem("asl-muted", muted ? "1" : "0");
      } catch {}
    },

    // p: 0..1 hold progress. call repeatedly while holding; <=0 stops.
    charge(p) {
      if (muted || !ensure()) {
        chargeStop(0.03);
        return;
      }
      if (p <= 0) {
        chargeStop();
        return;
      }
      const n = ctx.currentTime;
      if (!chg) {
        const g = ctx.createGain();
        g.gain.value = 0.0001;
        const o = ctx.createOscillator();
        o.type = "triangle";
        const o2 = ctx.createOscillator();
        o2.type = "sine";
        o.connect(g);
        o2.connect(g);
        g.connect(ctx.destination);
        o.start();
        o2.start();
        chg = { o, o2, g };
      }
      const f = 240 + p * 540; // ~240 -> ~780 Hz
      chg.o.frequency.linearRampToValueAtTime(f, n + 0.09);
      chg.o2.frequency.linearRampToValueAtTime(f * 2.01, n + 0.09); // shimmer
      chg.g.gain.linearRampToValueAtTime(0.03 + p * 0.06, n + 0.09);
    },

    // triumphant little rising arpeggio + a sparkle tail
    success() {
      chargeStop(0.04);
      if (muted || !ensure()) return;
      const n = ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(f, n + i * 0.08, 0.3, { gain: 0.14 })
      );
      tone(1567.98, n + 0.32, 0.55, { type: "sine", gain: 0.05 });
    },

    // soft tick — a finger just locked onto the target
    lock() {
      if (muted || !ensure()) return;
      tone(1320, ctx.currentTime, 0.05, { type: "sine", gain: 0.035 });
    },

    // sharper tick — the challenge timer is running low
    tick() {
      if (muted || !ensure()) return;
      tone(880, ctx.currentTime, 0.06, { type: "square", gain: 0.03 });
    },

    // a run ended
    fail() {
      if (muted || !ensure()) return;
      const n = ctx.currentTime;
      tone(300, n, 0.18, { type: "sawtooth", gain: 0.09 });
      tone(220, n + 0.12, 0.3, { type: "sawtooth", gain: 0.08 });
    },

    // picking a letter to learn
    select() {
      if (muted || !ensure()) return;
      const n = ctx.currentTime;
      tone(392, n, 0.05, { type: "sine", gain: 0.05 });
      tone(587.33, n + 0.045, 0.07, { type: "sine", gain: 0.05 });
    },
  };
}
