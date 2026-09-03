// Central place for every external URL and tunable constant.
// Bump MEDIAPIPE_VERSION here and both the JS bundle and the matching wasm
// binaries move together.

export const MEDIAPIPE_VERSION = "0.10.14";

export const VISION_BUNDLE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;

export const WASM_BASE_URL =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

// Google-hosted HandLandmarker model (float16, ~7 MB). Stable URL.
export const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Fingerspelling is one-handed. Kept at 2 for now so the Stage 1 skeleton
// demo shows both hands; drop to 1 once classification lands (one hand is
// faster, and we only ever classify one).
export const NUM_HANDS = 2;

// Cap detection rate. 30/s is plenty for recognition and roughly halves
// CPU/GPU/battery vs. running on every animation frame.
export const TARGET_FPS = 30;

// How many consecutive hand-less frames before we drop from "tracking" back
// to "searching". Small hysteresis stops the status flickering on brief
// detection dropouts.
export const LOST_HAND_FRAMES = 6;

// ---- classification (Stages 3-4) --------------------------------------

// Where the live app loads training vectors from. Produced by
// tools/extract.html. If it 404s, the app runs skeleton-only.
export const DATASET_URL = "data/dataset.json";

// The 24 static letters we classify. J and Z are motion letters (they trace a
// path, not a fixed pose) so they're excluded until Stage 6 adds motion
// buffering; "space" is a Stage 6 concern too. Any dataset row outside this
// set is dropped at load time.
export const LETTERS = "ABCDEFGHIKLMNOPQRSTUVWXY".split("");

// Append engineered shape features (per-finger curl, fingertip gaps, thumb
// position) to the raw 63 coordinates. These make confusable differences
// explicit — e.g. M vs N (thumb under 3 vs 2 fingers), R vs U (fingers
// crossed vs parallel). MUST match between the dataset build and live use.
export const USE_EXTENDED_FEATURES = true;

// Rotation augmentation (dataset build only). For each detected hand we also
// store copies rotated in the image plane by these angles (degrees), so kNN
// has neighbours at every hand tilt. Live inference is UNCHANGED — this only
// widens the training set. Tested: keeps ~95% accuracy from 0° to 30° of tilt
// (vs. dropping to ~64% at 25° without it). Empty array = no augmentation.
export const AUGMENT_ROTATIONS = [-30, -15, 15, 30];

// k for k-nearest-neighbours. Odd avoids ties in the common 2-class case.
export const KNN_K = 5;

// Kaggle's alphabet set is almost all right hands. If MediaPipe reports a
// left hand, mirror it to right-hand geometry before classifying so it
// matches the training data.
export const MIRROR_LEFT_HAND = true;

// A prediction must win at least this share of the k votes to count.
export const MIN_CONFIDENCE = 0.6;

// ...and the same letter must hold for this many consecutive predictions
// before it's shown, so the displayed letter doesn't flicker mid-transition.
export const STABLE_FRAMES = 8;

// ---- practice mode -------------------------------------------------

// Ghost-overlay match thresholds (0..1 similarity to the target letter's
// canonical shape). Below CLOSE = red, CLOSE..CORRECT = amber, above = green.
export const MATCH_CLOSE = 0.62;
export const MATCH_CORRECT = 0.82;

// Path to the per-letter reference photos (one clean grassknoted frame each).
export const REFERENCE_IMG = (letter) => `assets/reference/${letter}.jpg`;
