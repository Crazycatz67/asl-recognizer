// Entry point: camera -> hand tracker -> (normalize -> classify -> stabilize)
// -> overlay, driven by an explicit state machine.
//
//   idle -> requesting -> loading -> searching <-> tracking
//   any state -> error (recoverable via the "Try again" button)
//
// Recognition switches on when data/dataset.json is present; without it the app
// runs skeleton-only. With a dataset, a "Learn" picker appears: choose a letter
// and a side panel shows its reference photo + a clean canonical-skeleton
// diagram, while the camera frame glows red -> amber -> green as you match it.
// An optional dashed outline guide can be overlaid on the camera too.

import { startCamera, stopCamera, countCameras, facingOf } from "./camera.js";
import { createHandTracker } from "./handTracker.js";
import { createOverlay } from "./overlay.js";
import { normalizeLandmarks, aspectOf } from "./normalize.js";
import { loadDataset } from "./dataset.js";
import { createClassifier } from "./knn.js";
import { createStabilizer } from "./stabilizer.js";
import { buildReference, drawCanonical } from "./reference.js";
import { createSound } from "./sound.js";
import { createFx } from "./fx.js";
import { createBackground } from "./bg.js";
import {
  TARGET_FPS,
  LOST_HAND_FRAMES,
  DATASET_URL,
  LETTERS,
  USE_EXTENDED_FEATURES,
  KNN_K,
  MIRROR_LEFT_HAND,
  MIN_CONFIDENCE,
  STABLE_FRAMES,
  REFERENCE_IMG,
} from "./config.js";

const $ = (id) => document.getElementById(id);
const workspace = $("workspace");
const viewport = $("viewport");
const video = $("camera");
const canvas = $("overlay");
const pillText = $("pillText");
const statsEl = $("stats");
const curtainSub = $("curtainSub");
const letterBadge = $("letterBadge");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const flipBtn = $("flipBtn");
const learnRow = $("learnRow");
const letterPicker = $("letterPicker");
const clearTargetBtn = $("clearTarget");
const refPanel = $("refPanel");
const refLetter = $("refLetter");
const refImg = $("refImg");
const refCanvas = $("refCanvas");
const meterFill = $("meterFill");
const meterLabel = $("meterLabel");
const refHint = $("refHint");
const ghostToggle = $("ghostToggle");
const ghostToggleWrap = $("ghostToggleWrap");
const muteBtn = $("muteBtn");
const toast = $("toast");

const sound = createSound();
const fx = createFx();
const bg = createBackground();

const DETECT_INTERVAL = 1000 / TARGET_FPS;
const HINT_INTERVAL = 250; // ms — throttle the text hint so it doesn't jitter
const HOLD_MS = 1600; // hold a COMPLETE sign (meter full + skeleton all green) this long
const HOLD_GRACE_MS = 220; // tolerate this much tracking flicker without losing the hold
const BUCKET_COLOR = { off: "#f87171", close: "#f59e0b", correct: "#22c55e" };
const BUCKET_LABEL = { off: "keep adjusting", close: "almost there", correct: "hold it…" };
let lastHintAt = 0;
let holdStart = 0; // timestamp the current clean hold began (0 = not holding)
let lastGoodAt = 0; // last frame the sign was complete — for the grace window
let rewarded = false;
let toastTimer = 0;

const PILL = {
  idle: "Camera off",
  requesting: "Starting camera…",
  loading: "Loading hand tracker…",
  searching: "Show your hand ✋",
  tracking: "Tracking your hand",
};

let state = "idle";
let stream = null;
let tracker = null;
let overlay = null;
let wakeLock = null;
let rafId = 0;

let facingMode = "user";
let lastDetectAt = 0;
let missStreak = 0;
let detCount = 0;
let detStamp = performance.now();
let fps = 0;

// ---- recognition + practice (loaded lazily; may be absent) --------

let classifier = null;
let stabilizer = null;
let reference = null;
let lastPred = null;
let targetLetter = null;

// Load once, build the classifier + reference here, then let the raw sample
// array be garbage-collected (each keeps its own compact copy). Resolves to a
// boolean, not the dataset.
const datasetPromise = loadDataset(DATASET_URL)
  .catch((err) => {
    if (err.status !== 404) console.warn("dataset load failed:", err);
    return null;
  })
  .then((ds) => {
    if (!ds) return false;
    const keep = new Set(LETTERS);
    const train = ds.samples.filter((s) => keep.has(s.label));
    classifier = createClassifier(train, { k: KNN_K });
    stabilizer = createStabilizer({
      stableFrames: STABLE_FRAMES,
      minConfidence: MIN_CONFIDENCE,
    });
    reference = buildReference(train, LETTERS); // self-calibrates per letter
    buildLetterPicker(reference.letters);
    learnRow.hidden = false;
    console.info(
      `recognition on: ${classifier.size} vectors, ${classifier.classes.length} letters`
    );
    return true;
  });

// ---- practice: letter picker + reference panel + match meter -----

function buildLetterPicker(letters) {
  letterPicker.innerHTML = "";
  for (const L of letters) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = L;
    b.addEventListener("click", () => setTarget(targetLetter === L ? null : L));
    letterPicker.appendChild(b);
  }
}

function setTarget(letter) {
  targetLetter = letter;
  for (const b of letterPicker.children) {
    const on = b.textContent === letter;
    b.classList.toggle("on", on);
    if (on) b.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }
  clearTargetBtn.hidden = !letter;
  refPanel.hidden = !letter;
  ghostToggleWrap.hidden = !letter;
  workspace.dataset.target = letter ? "on" : "off";

  holdStart = 0;
  rewarded = false;
  viewport.style.setProperty("--hold", "0");
  if (letter) {
    refLetter.textContent = letter;
    refImg.src = REFERENCE_IMG(letter); // photo always on when learning
    // the panel was just un-hidden — wait one frame so its real width exists
    // before we size the canvas to it, otherwise the diagram can draw blank.
    requestAnimationFrame(sizeRefCanvas);
    sound.select();
  } else {
    updateMeter(0, null);
    bg.setMatch(null);
  }
  refHint.textContent = "";
}

// Crisp canvas: back the reference diagram with real device pixels, then draw.
function sizeRefCanvas() {
  if (refPanel.hidden || !reference || !targetLetter) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = refCanvas.clientWidth || refCanvas.parentElement?.clientWidth / 2 || 140;
  const size = Math.max(80, Math.round(cssW * dpr));
  if (refCanvas.width !== size) {
    refCanvas.width = size;
    refCanvas.height = size;
  }
  drawCanonical(refCanvas, reference.centroid(targetLetter));
}
window.addEventListener("resize", sizeRefCanvas);

function updateMeter(score, bucket) {
  meterFill.style.width = `${Math.round(score * 100)}%`;
  meterFill.style.background = BUCKET_COLOR[bucket] || "#475569";
  meterFill.classList.toggle("correct", bucket === "correct");
  meterLabel.textContent = bucket ? BUCKET_LABEL[bucket] : "show your hand";
  meterLabel.style.color = BUCKET_COLOR[bucket] || "#94a3b8";
  meterLabel.classList.toggle("correct", bucket === "correct");
  viewport.dataset.match = bucket || "none";
}

function reward(originLandmark) {
  const r = viewport.getBoundingClientRect();
  const x = originLandmark ? r.left + (1 - originLandmark.x) * r.width : r.left + r.width / 2;
  const y = originLandmark ? r.top + originLandmark.y * r.height : r.top + r.height / 2;
  fx.burst(x, y);
  fx.flash("#22c55e");
  sound.success();
  viewport.classList.add("celebrate");
  setTimeout(() => viewport.classList.remove("celebrate"), 650);
  letterBadge.classList.remove("pop");
  void letterBadge.offsetWidth; // restart the animation
  letterBadge.classList.add("pop");
  showToast(`Nailed ${targetLetter}!  ✓`);
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

function syncMuteBtn() {
  muteBtn.textContent = sound.muted ? "🔇" : "🔊";
  muteBtn.classList.toggle("muted", sound.muted);
}
syncMuteBtn();

// ---- state machine -------------------------------------------------

function setState(next, detail) {
  state = next;
  viewport.dataset.state = next;

  if (next === "error") {
    pillText.textContent = "Problem";
    curtainSub.textContent = detail || "Something went wrong.";
    startBtn.textContent = "Try again";
  } else {
    pillText.textContent = detail || PILL[next] || next;
  }

  const live = next !== "idle" && next !== "error";
  stopBtn.hidden = !live;
  startBtn.disabled = next === "requesting" || next === "loading";
  if (!live) {
    statsEl.hidden = true;
    letterBadge.hidden = true;
    viewport.dataset.match = "none";
    holdStart = 0;
    rewarded = false;
    viewport.style.setProperty("--hold", "0");
    bg.setMatch(null);
  }
}

// ---- lifecycle ---------------------------------------------------

async function start() {
  if (state === "requesting" || state === "loading") return;
  sound.resume(); // this click is the user gesture that unlocks audio
  setState("requesting");
  try {
    stream = await startCamera(video, { facingMode });
    facingMode = facingOf(stream) || facingMode;
    // the viewport is sized by the layout, not the camera — the video and the
    // overlay canvas both `object-fit: cover` it, so any box shape works.

    setState("loading");
    [tracker, overlay] = await Promise.all([createHandTracker(), createOverlay(canvas)]);
    await acquireWakeLock();
    await datasetPromise;
    stabilizer?.reset();
    if (targetLetter) sizeRefCanvas();

    flipBtn.hidden = (await countCameras()) < 2;
    missStreak = LOST_HAND_FRAMES;
    detCount = 0;
    detStamp = performance.now();
    setState("searching");
    rafId = requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    fail(err);
  }
}

function stop() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  stopCamera(stream);
  stream = null;
  tracker?.close();
  tracker = null;
  overlay?.clear();
  overlay = null;
  releaseWakeLock();
  stabilizer?.reset();
  lastPred = null;
  flipBtn.hidden = true;
  startBtn.textContent = "Turn on camera";
  curtainSub.textContent =
    "Runs entirely on your device. Nothing is recorded or uploaded.";
  if (targetLetter) updateMeter(0, null);
  setState("idle");
}

function fail(err) {
  cancelAnimationFrame(rafId);
  rafId = 0;
  stopCamera(stream);
  stream = null;
  tracker?.close();
  tracker = null;
  releaseWakeLock();
  flipBtn.hidden = true;
  setState("error", friendlyError(err));
}

async function flip() {
  if (state !== "searching" && state !== "tracking") return;
  flipBtn.disabled = true;
  const want = facingMode === "user" ? "environment" : "user";
  try {
    stopCamera(stream);
    stream = await startCamera(video, { facingMode: want });
    facingMode = facingOf(stream) || want;
  } catch (err) {
    console.error(err);
    fail(err);
  } finally {
    flipBtn.disabled = false;
  }
}

// ---- per-frame loop --------------------------------------------

function loop() {
  if (!tracker) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  if (now - lastDetectAt < DETECT_INTERVAL) return; // throttle to TARGET_FPS
  lastDetectAt = now;
  if (video.readyState < 2) return;

  overlay.resizeToVideo(video);
  const result = tracker.detect(video, now);
  overlay.clear();

  const hasHand = result.landmarks?.length > 0;
  const left = hasHand && result.handedness?.[0]?.[0]?.categoryName === "Left";
  const guiding = reference && targetLetter && ghostToggle.checked;

  if (hasHand) {
    // when learning with the guide on, draw the correction guide instead of
    // the plain skeleton (it IS the skeleton, coloured + with arrows)
    if (guiding) {
      overlay.drawGuide(result.landmarks[0], reference.centroid(targetLetter), {
        aspect: aspectOf(video),
        mirror: MIRROR_LEFT_HAND && left,
        tol: reference.tolerance(targetLetter),
      });
    } else {
      overlay.drawHands(result.landmarks);
    }
    missStreak = 0;
    if (state !== "tracking") setState("tracking");
  } else {
    missStreak++;
    if (missStreak >= LOST_HAND_FRAMES && state !== "searching") setState("searching");
  }

  // normalize once; reused by the classifier and the practice meter
  let vec = null;
  if (hasHand && (classifier || reference)) {
    vec = normalizeLandmarks(result.landmarks[0], {
      aspect: aspectOf(video),
      mirrorX: MIRROR_LEFT_HAND && left,
      extended: USE_EXTENDED_FEATURES, // must match how the dataset was built
    });
  }

  // recognition -> corner badge
  if (classifier) {
    lastPred = hasHand ? classifier.classify(vec) : null;
    stabilizer.push(hasHand ? lastPred : null);
    const shown = stabilizer.current;
    letterBadge.hidden = !shown;
    if (shown) letterBadge.textContent = shown;
  }

  // practice: camera-frame glow + meter + a plain-words hint + the reward
  if (reference && targetLetter) {
    if (hasHand && vec) {
      const m = reference.score(vec, targetLetter);
      updateMeter(m.score, m.bucket); // shape match only — not gated on the classifier
      // ambient background warms toward green, and reacts in the direction of
      // the problem (fingers off -> top; thumb side off -> that side)
      bg.setMatch(m.score, m.bucket, reference.regionErrors(vec, targetLetter));

      // reward only when the sign is genuinely COMPLETE (m.bucket === "correct"
      // already means meter full AND every joint green) and has been held for
      // HOLD_MS — a brief accidental pose won't count. Small tracking dropouts
      // inside HOLD_GRACE_MS don't reset the timer.
      const complete = m.bucket === "correct";
      if (complete) {
        if (!holdStart) holdStart = now;
        lastGoodAt = now;
      } else if (holdStart && now - lastGoodAt > HOLD_GRACE_MS) {
        holdStart = 0;
        rewarded = false;
      }
      const heldMs = holdStart ? now - holdStart : 0;
      const heldFrac = Math.min(1, heldMs / HOLD_MS);
      viewport.style.setProperty("--hold", heldFrac.toFixed(3));
      if (holdStart && heldMs >= HOLD_MS && !rewarded) {
        rewarded = true;
        reward(result.landmarks[0][0]);
      }

      if (now - lastHintAt >= HINT_INTERVAL) {
        lastHintAt = now;
        const misread =
          lastPred && lastPred.label !== targetLetter && lastPred.confidence >= 0.8;
        let tip = reference.hint(vec, targetLetter);
        // hint() can say "looks right" from the coarse feature check while the
        // meter is still short — don't claim it's right unless the meter agrees
        if (!complete && /looks right/i.test(tip)) {
          tip = m.bucket === "close" ? "So close — tiny adjustments" : "Keep shaping it";
        }
        const dots = "●".repeat(Math.round(heldFrac * 5)).padEnd(5, "·");
        refHint.textContent = rewarded
          ? `Nailed it — that's ${targetLetter} ✓`
          : complete
          ? `Hold it…  ${dots}`
          : misread
          ? `${tip}  ·  (reading as ${lastPred.label})`
          : tip;
      }
    } else {
      updateMeter(0, null);
      bg.setMatch(null);
      refHint.textContent = "";
      // hand lost mid-hold: keep the timer alive briefly (grace), else drop it
      if (holdStart && now - lastGoodAt > HOLD_GRACE_MS) {
        holdStart = 0;
        rewarded = false;
        viewport.style.setProperty("--hold", "0");
      }
    }
  } else {
    bg.setMatch(null);
  }

  // stats badge (~2x/sec)
  detCount++;
  if (now - detStamp >= 500) {
    fps = Math.round((detCount * 1000) / (now - detStamp));
    detCount = 0;
    detStamp = now;
    statsEl.hidden = false;
    let line = `${video.videoWidth}×${video.videoHeight} · ${fps} fps · ${tracker.delegate}`;
    if (classifier) line += lastPred ? ` · ${lastPred.label} ${(lastPred.confidence * 100) | 0}%` : " · —";
    else line += " · no dataset";
    statsEl.textContent = line;
  }
}

// ---- screen wake lock (best effort) --------------------------

async function acquireWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    wakeLock?.addEventListener?.("release", () => (wakeLock = null));
  } catch {
    wakeLock = null;
  }
}
function releaseWakeLock() {
  wakeLock?.release?.();
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  const live = state === "searching" || state === "tracking";
  if (live && document.visibilityState === "visible" && !wakeLock) acquireWakeLock();
});

// ---- errors --------------------------------------------------

function friendlyError(err) {
  switch (err?.name) {
    case "NotAllowedError":
      return "Camera blocked. Allow it via the camera icon near the address bar, then Try again.";
    case "NotFoundError":
      return "No camera found on this device.";
    case "NotReadableError":
      return "The camera is being used by another app. Close it and Try again.";
    case "OverconstrainedError":
      return "Requested camera settings aren't supported by this device.";
  }
  if (!navigator.mediaDevices)
    return "Camera unavailable here — open the page over http://localhost or an https:// URL.";
  if (!window.isSecureContext)
    return "Camera needs a secure context — use http://localhost or https://.";
  return `Error: ${err?.message || err}`;
}

// ---- wiring ------------------------------------------------

startBtn.addEventListener("click", start); // "Turn on camera" and "Try again"
stopBtn.addEventListener("click", stop);
flipBtn.addEventListener("click", flip);
clearTargetBtn.addEventListener("click", () => setTarget(null));
muteBtn.addEventListener("click", () => {
  sound.setMuted(!sound.muted);
  syncMuteBtn();
});
