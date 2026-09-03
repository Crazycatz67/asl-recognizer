// Wraps MediaPipe HandLandmarker (Tasks Vision API) for per-frame video use.
//
// createHandTracker() -> { delegate, detect(video, timestampMs), close() }
//
//   detect() returns the raw HandLandmarkerResult. The fields we care about:
//     result.landmarks       -> [ [ {x,y,z}, ... 21 ], ... ]  normalised 0..1
//     result.worldLandmarks  -> same shape, metric units, wrist-centred
//     result.handedness      -> [ [ {categoryName: "Left"|"Right", score} ] ]

import { loadVision } from "./mediapipe.js";
import { WASM_BASE_URL, HAND_MODEL_URL, NUM_HANDS } from "./config.js";

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

  return {
    delegate,

    detect(video, timestampMs) {
      let ts = timestampMs;
      if (ts <= lastTimestamp) ts = lastTimestamp + 1;
      lastTimestamp = ts;
      return landmarker.detectForVideo(video, ts);
    },

    close() {
      landmarker?.close?.();
    },
  };
}
