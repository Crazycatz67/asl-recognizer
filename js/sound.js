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

  return {
    resume() {
      ensure();
    },
    get muted() {
      return muted;
    },
    setMuted(m) {
      muted = !!m;
      try {
        localStorage.setItem("asl-muted", muted ? "1" : "0");
      } catch {}
    },

    // triumphant little rising arpeggio + a sparkle tail
    success() {
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

    // picking a letter to learn
    select() {
      if (muted || !ensure()) return;
      const n = ctx.currentTime;
      tone(392, n, 0.05, { type: "sine", gain: 0.05 });
      tone(587.33, n + 0.045, 0.07, { type: "sine", gain: 0.05 });
    },
  };
}
