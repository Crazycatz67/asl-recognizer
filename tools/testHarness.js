// Drives the REAL, live app (js/main.js's actual running state machine) with
// synthetic hand data instead of a real webcam — so sound cues, the live
// guide overlay, mode transitions, and J/Z motion detection can be exercised
// and observed end to end without physically using a camera.
//
// This is NOT a reimplementation of the recognition pipeline (that's what
// tools/selftest.html is for, testing isolated modules) — it drives the real
// index.html page through its real UI, real tracker, real reference scorer,
// real overlay, real sound object. Load index.html with "?dev" in the URL
// first (see js/main.js's `DEV` flag), which exposes `window.__aslDev`.
//
// Usage (from the browser console, or a javascript_tool call against the
// real dev-server page):
//
//   const { createTestHarness } = await import("./tools/testHarness.js");
//   const h = createTestHarness();
//   h.useSyntheticCamera();          // BEFORE clicking "Turn on camera"
//   // ... click the real Start button ...
//   await h.ready();
//   h.spySound();
//   await h.feedLetter("D", { holdMs: 700 });
//   console.log(h.soundLog, window.__aslDev.reference.score(...));
//   h.restore();
//
// IMPORTANT: keep the browser tab FOREGROUNDED for any timing-sensitive test
// (feedSequence, motion letters, hold-progress). Chrome throttles
// requestAnimationFrame heavily in backgrounded tabs, which silently breaks
// the real-elapsed-time assumptions js/motion.js and js/transition.js make —
// that's a browser-automation gotcha, not a bug in the app or this harness.
//
// What this CANNOT test (see the plan doc / Bug Reports/checklist.md for the
// full list): real MediaPipe detection quality on an actual human hand, real
// camera performance characteristics, anything in a backgrounded tab, or
// (if ever fed data/fs_sequences.json frames) anything beyond qualitative
// timing/UI/sound behavior — that dataset is MediaPipe Holistic, a different
// domain than the live HandLandmarker pipeline (see the project's standing
// domain-gap caveat).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Inverse of js/normalize.js's normalizeLandmarks() forward transform:
// wrist-center -> aspect-correct x -> scale by max wrist-distance to unit
// radius. Given a normalized vector (e.g. reference.centroid(label), or any
// real training sample), reconstruct raw 0..1 image-space landmarks. Only
// vec[0..62] (the 21 base x/y/z triples) are used — handFeatures() is a pure
// function of those points, so it comes back correct for free once the app
// re-normalizes this raw frame.
//
// IMPORTANT, verified live rather than assumed: normalizeLandmarks() ALWAYS
// rescales its output so the farthest point sits at exactly radius 1 — so
// there is NO raw reconstruction that reproduces a vector bit-for-bit unless
// that vector already has max-per-point-hypot === 1. A single real training
// sample satisfies this exactly (it's what normalizeLandmarks() produced in
// the first place), but reference.centroid(label) is a MEAN of many such
// vectors and generally does NOT (measured ~0.90 for a real letter) — the
// first version of this function assumed otherwise and was caught wrong by
// this file's own round-trip claim, verified live: it reproduced the
// centroid off by ~0.1 per component, not float epsilon. Fix: rescale the
// input to true unit radius before reconstructing. This is the mathematically
// correct target anyway — it's "the live vector this exact shape would
// produce," which is what a synthetic detect() frame should be feeding.
// A real single sample (already unit-radius) is unaffected by this rescale.
//
// aspect is fixed at 1 (the synthetic camera is square, see
// useSyntheticCamera) so it cancels out of this formula entirely rather than
// needing to be tracked/matched — one less thing to get subtly wrong.
const WRIST = { x: 0.5, y: 0.5, z: 0 };
const RADIUS = 0.35; // keeps every reconstructed point comfortably mid-frame

function rawFromVector(vec, { mirror = false } = {}) {
  const sx = mirror ? -1 : 1;
  let m = 1e-9;
  for (let i = 0; i < 21; i++) {
    m = Math.max(m, Math.hypot(vec[i * 3], vec[i * 3 + 1], vec[i * 3 + 2]));
  }
  const pts = new Array(21);
  for (let i = 0; i < 21; i++) {
    pts[i] = {
      x: WRIST.x + (vec[i * 3] / m) * RADIUS / sx,
      y: WRIST.y + (vec[i * 3 + 1] / m) * RADIUS,
      z: WRIST.z + (vec[i * 3 + 2] / m) * RADIUS,
    };
  }
  return pts;
}

// small per-joint x/y perturbation, magnitude in the SAME normalized-vector
// units reference.js's tolerance()/matchTolerance() use — so `jitter:
// ref.matchTolerance('D')*1.3` means exactly what it says.
function jitterVec(vec, amt) {
  if (!amt) return vec.slice();
  const out = vec.slice();
  for (let i = 0; i < 21; i++) {
    out[i * 3] += (Math.random() * 2 - 1) * amt;
    out[i * 3 + 1] += (Math.random() * 2 - 1) * amt;
  }
  return out;
}

function lerpRaw(a, b, t) {
  const out = new Array(21);
  for (let i = 0; i < 21; i++) {
    out[i] = {
      x: a[i].x + (b[i].x - a[i].x) * t,
      y: a[i].y + (b[i].y - a[i].y) * t,
      z: a[i].z + (b[i].z - a[i].z) * t,
    };
  }
  return out;
}

// `explicitHook` lets advanced/test use pass a fake hook object directly;
// normal use omits it and always resolves live against window.__aslDev —
// this matters because createTestHarness() is typically called BEFORE
// clicking Start (so window.__aslDev doesn't exist yet). A one-time default
// parameter snapshot would freeze that "not yet set" state forever; every
// accessor below re-reads window.__aslDev live instead.
export function createTestHarness(explicitHook = null) {
  let origGUM = null;
  let origSoundFns = null;

  const need = () => {
    const h = explicitHook || window.__aslDev;
    if (!h) throw new Error("window.__aslDev not found — load index.html with ?dev and call this AFTER Start");
    return h;
  };

  return {
    get hook() {
      return explicitHook || window.__aslDev;
    },

    // Resolves once hook.tracker exists (i.e. after a real or synthetic
    // camera session has started and start() has run past createHandTracker()).
    async ready(timeoutMs = 8000) {
      const t0 = performance.now();
      while (!(explicitHook || window.__aslDev)?.tracker) {
        if (performance.now() - t0 > timeoutMs) throw new Error("timed out waiting for window.__aslDev.tracker");
        await sleep(50);
      }
      return need();
    },

    // Patches navigator.mediaDevices.getUserMedia to return a captureStream()
    // from an inert square canvas, BEFORE the real "Turn on camera" button is
    // clicked. js/camera.js's startCamera() then runs completely unmodified —
    // video.srcObject/readyState/videoWidth are all honestly satisfied by the
    // real browser video pipeline; the canvas content itself is irrelevant
    // since tracker.detect gets overridden separately.
    useSyntheticCamera({ size = 720 } = {}) {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#222";
      ctx.fillRect(0, 0, size, size);
      const stream = canvas.captureStream(5); // low fps is fine, content is inert
      origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async () => stream;
    },

    // Core primitive: vec is a normalized vector (63+ values, extras ignored)
    // like reference.centroid(label) or a real dataset sample. Swaps
    // tracker.detect to a synthetic function for holdMs of REAL elapsed
    // time — never fakes performance.now() — so js/motion.js and
    // js/transition.js see authentic real-time-paced input with no
    // special-casing needed.
    async feedVector(vec, { holdMs = 400, hand = "right", jitter = 0 } = {}) {
      const h = need();
      const mirror = hand === "left";
      const label = mirror ? "Left" : "Right";
      h.tracker.detect = () => {
        const frame = rawFromVector(jitterVec(vec, jitter), { mirror });
        return { landmarks: [frame], handedness: [[{ categoryName: label, score: 0.99 }]] };
      };
      await sleep(holdMs);
    },

    feedLetter(label, opts = {}) {
      const h = need();
      const vec = opts.vec ?? h.reference?.centroid(label);
      if (!vec) throw new Error(`no centroid for "${label}" — is the dataset loaded?`);
      return this.feedVector(vec, opts);
    },

    // items: [{ label } | { vec }, ...], each with optional holdMs/transitionMs.
    // Interpolates RAW landmark points between consecutive targets (what a
    // real moving hand does) over transitionMs, then holds. Reuses the
    // "replay recorded frames" idea from tools/replay-lab.html /
    // tools/sweep-transition.mjs, but paced by real setTimeouts against real
    // elapsed time instead of a synthesized fixed-step clock — this is what
    // makes it able to drive live Spell-mode fluid typing / J,Z motion,
    // not just an isolated pipeline.
    async feedSequence(items, { holdMs = 500, transitionMs = 250, steps = 8, hand = "right" } = {}) {
      const h = need();
      const mirror = hand === "left";
      const label = mirror ? "Left" : "Right";
      const rawOf = (item) => {
        const vec = item.vec ?? h.reference?.centroid(item.label);
        if (!vec) throw new Error(`no centroid for "${item.label}"`);
        return rawFromVector(vec, { mirror });
      };
      let prev = null;
      for (const item of items) {
        const target = rawOf(item);
        if (prev) {
          for (let s = 1; s <= steps; s++) {
            const frame = lerpRaw(prev, target, s / steps);
            h.tracker.detect = () => ({
              landmarks: [frame],
              handedness: [[{ categoryName: label, score: 0.99 }]],
            });
            await sleep(transitionMs / steps);
          }
        }
        h.tracker.detect = () => ({
          landmarks: [target],
          handedness: [[{ categoryName: label, score: 0.99 }]],
        });
        await sleep(item.holdMs ?? holdMs);
        prev = target;
      }
    },

    // Simulates a dropped/no hand in frame.
    async noHand({ ms = 300 } = {}) {
      const h = need();
      h.tracker.detect = () => ({ landmarks: [], handedness: [] });
      await sleep(ms);
    },

    // Wraps hook.sound's cue methods to log calls while still playing real
    // audio (fire-and-forget with zero return value otherwise — this is the
    // only way to observe which cue fired).
    spySound() {
      const h = need();
      this.soundLog = [];
      if (!origSoundFns) {
        origSoundFns = {};
        for (const name of ["success", "fail", "tick", "charge", "select", "lock"]) {
          if (typeof h.sound[name] !== "function") continue;
          origSoundFns[name] = h.sound[name].bind(h.sound);
          h.sound[name] = (...args) => {
            this.soundLog.push({ name, args, t: performance.now() });
            return origSoundFns[name](...args);
          };
        }
      }
    },

    expectSound(name, { sinceT = 0, withinMs = Infinity } = {}) {
      return (this.soundLog || []).some(
        (e) => e.name === name && e.t >= sinceT && e.t - sinceT <= withinMs
      );
    },

    // Un-patches everything this harness touched.
    restore() {
      if (origGUM) {
        navigator.mediaDevices.getUserMedia = origGUM;
        origGUM = null;
      }
      const h = window.__aslDev;
      if (h && origSoundFns) {
        for (const [name, fn] of Object.entries(origSoundFns)) h.sound[name] = fn;
        origSoundFns = null;
      }
      // tracker.detect has no single "original" to restore to (it's normally
      // the real MediaPipe-backed closure from createHandTracker() — that
      // object still exists on hook.tracker, we only ever replaced the
      // .detect method). Re-creating a real tracker is out of scope here;
      // simplest safe reset is to stop the camera session from the UI
      // (the real "Turn off camera" control) after calling restore().
    },
  };
}

// exported for the harness's own self-test (see tools/ci-check.mjs / the
// verification steps in the plan doc) and for advanced direct use.
export { rawFromVector, jitterVec, lerpRaw };
