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
export const NUM_HANDS = 2; // max; main.js drops to 1 outside Spell mode (see handTracker.setNumHands)

// Cap detection rate. 30/s is plenty for recognition and roughly halves
// CPU/GPU/battery vs. running on every animation frame.
export const TARGET_FPS = 30;

// How many consecutive hand-less frames before we drop from "tracking" back
// to "searching". Small hysteresis stops the status flickering on brief
// detection dropouts.
export const LOST_HAND_FRAMES = 6;

// This same hysteresis idea didn't originally extend to the overlay DRAWING
// itself — a single missed-detection frame (e.g. fingers briefly occluding
// the palm) cleared the skeleton outright that frame, a real reported bug
// ("the skeletal overlay snaps off and on"). OVERLAY_GRACE_FRAMES bridges a
// momentary miss by holding the last known pose on screen — short enough
// that a genuine hand-leaves-frame is still noticed quickly (well under
// LOST_HAND_FRAMES, which still governs the "searching" state label).
export const OVERLAY_GRACE_FRAMES = 3;

// One-euro filter (js/onefilter.js), replacing a fixed-alpha EMA for the
// live landmark smoothing (S8 — see the plan's "ghosting"/lag item). Both
// mincutoff and dcutoff are frequencies in Hz; beta scales estimated
// velocity (signal units/second, in this normalized 0..1 landmark space)
// into extra cutoff. THESE THREE ARE AN INFORMED STARTING GUESS, NOT
// MEASURED — derivation: the old EMA (alpha=0.5 at ~30fps) behaves like a
// ~4.8 Hz low-pass; ONE_EURO_MIN_CUTOFF is deliberately lower (heavier
// smoothing than the old filter EVER had, while genuinely still) and
// ONE_EURO_BETA is sized so a fast deliberate motion (a J/Z swoosh, roughly
// 2-5 units/sec in this coordinate space) pushes the effective cutoff well
// ABOVE the old filter's constant 4.8 Hz (much less lag while moving).
// Needs live-device tuning — cannot be judged from any offline replay
// (`tools/sweep-transition.mjs` runs on raw, unsmoothed landmarks and
// wouldn't see a change here at all).
export const ONE_EURO_MIN_CUTOFF = 1.2;
export const ONE_EURO_BETA = 3.0;
export const ONE_EURO_DCUTOFF = 1.0;

// ---- classification (Stages 3-4) --------------------------------------

// Where the live app loads training vectors from. Produced by
// tools/extract.html. If it 404s, the app runs skeleton-only.
export const DATASET_URL = "data/dataset.json";

// The 24 static letters the kNN/heads classify. J and Z are MOTION letters —
// they trace a path, not a fixed pose — handled by js/motion.js instead. Any
// dataset row outside LETTERS is dropped at load time.
export const LETTERS = "ABCDEFGHIKLMNOPQRSTUVWXY".split("");
export const MOTION_LETTERS = ["J", "Z"];
// full alphabet, in order, for the letter picker / A→Z run / challenge
export const ALL_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

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

// The off / close / correct bands and the score curve are calibrated per letter
// from that letter's own training spread — see js/reference.js buildReference().
// No fixed thresholds here on purpose.

// Path to the per-letter reference photos (one clean grassknoted frame each).
export const REFERENCE_IMG = (letter) => `assets/reference/${letter}.jpg`;

// Reject a prediction whose nearest training example is farther than this
// (normalized-vector distance, knn.js `distance`): the classifier has no
// "not a letter" class, so a relaxed hand, a hand being raised, or an
// in-between shape always landed on SOME letter, often with 4-5/5 votes.
// Measured 2026-09-24 (blocked 80/20 per-letter split, rotation-augmented
// train, held-out at 0/±12°): real letters p95 0.62 / p97 0.73; relaxed
// "space" hands p10 0.69; midpoints of two different letters p50 0.73.
// 0.68 keeps ~96% of real single frames (a letter holds for many frames, so
// a rare reject barely delays it) and drops most non-letter shapes.
export const REJECT_DIST = 0.68;

