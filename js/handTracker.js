// =============================================================================
// js/handTracker.js — MediaPipe HandLandmarker wrapper (Browser I/O)
// =============================================================================
// WHAT: Wraps MediaPipe HandLandmarker (Tasks Vision API) for per-frame video
//   use: loads the WASM runtime + hand model, prefers the GPU delegate with
//   a CPU fallback, and guarantees the strictly increasing timestamps VIDEO
//   mode demands. This is the only module that talks to the ML model that
//   finds hands; everything downstream works on its 21 landmarks per hand.
//
// PIPELINE: webcam (camera.js) → [handTracker.js] → onefilter → normalize →
//   kNN → … main.js loop() calls detect() once per throttled frame.
//
// PUBLIC API:
//   createHandTracker() → Promise<{ delegate, detect(video, timestampMs), setNumHands(n), close() }>
//     delegate → "GPU" | "CPU" (which one actually loaded)
//     detect() → the raw HandLandmarkerResult. The fields we care about:
//       result.landmarks       -> [ [ {x,y,z}, ... 21 ], ... ]  normalised 0..1
//       result.worldLandmarks  -> same shape, metric units, wrist-centred
//       result.handedness      -> [ [ {categoryName: "Left"|"Right", score} ] ]
//     setNumHands(n) → track at most n hands (main.js: 2 in Spell, else 1)
//     close()  → free the model
//
// UNITS: landmark x/y are normalized 0..1 frame coords (x across, y down);
//   z is relative depth on roughly the same scale as x, negative = nearer
//   the camera. timestampMs is performance.now()-style milliseconds.
//
// GOTCHA: model/WASM URLs and NUM_HANDS live in config.js; the first call
//   downloads ~7 MB, so main.js shows a "loading" state while it resolves.

import { loadVision } from "./mediapipe.js";
import { WASM_BASE_URL, HAND_MODEL_URL, NUM_HANDS } from "./config.js";

/**
 * Load MediaPipe and build a VIDEO-mode HandLandmarker (GPU, else CPU).
 * @returns {Promise<{delegate: "GPU"|"CPU",
 *   detect: (video: HTMLVideoElement, timestampMs: number) => any, close: () => void}>}
 */
export async function createHandTracker() {
  const { HandLandmarker, FilesetResolver } = await loadVision();
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);

  const build = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: NUM_HANDS,
    });

  // GPU delegate is much faster but unavailable on some mobile browsers /
  // locked-down GPUs. Fall back to CPU rather than failing outright.
  let landmarker;
  let delegate = "GPU";
  try {
    landmarker = await build("GPU");
  } catch (err) {
    console.warn("HandLandmarker GPU delegate failed, using CPU:", err);
    delegate = "CPU";
    landmarker = await build("CPU");
  }

  // VIDEO mode requires strictly increasing timestamps; guard against the
  // rare case where two rAF callbacks report the same millisecond.
  let lastTimestamp = -1;
  let numHands = NUM_HANDS;

  return {
    delegate,

    detect(video, timestampMs) {
      let ts = timestampMs;
      if (ts <= lastTimestamp) ts = lastTimestamp + 1;
      lastTimestamp = ts;
      return landmarker.detectForVideo(video, ts);
    },

    // Tracking a second hand isn't free: with room for 2 hands and only 1 in
    // view, MediaPipe keeps running its palm detector every frame looking for
    // the other one. Only Spell mode's two-hand gestures need 2.
    setNumHands(n) {
      if (n === numHands) return;
      numHands = n;
      Promise.resolve(landmarker.setOptions({ numHands: n })).catch((err) =>
        console.warn("HandLandmarker setOptions(numHands) failed:", err));
    },

    close() {
      landmarker?.close?.();
    },
  };
}
