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
import { buildReference, createCanonicalPlayer } from "./reference.js";
import { createSound } from "./sound.js";
import { createFx } from "./fx.js";
import { createBackground } from "./bg.js";
import { createChallenge } from "./challenge.js";
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
const learnLabel = $("learnLabel");
const learnCurrent = $("learnCurrent");
const azToggle = $("azToggle");
const azProgress = $("azProgress");
const prevLetterBtn = $("prevLetter");
const nextLetterBtn = $("nextLetter");
const letterPicker = $("letterPicker");
const clearTargetBtn = $("clearTarget");
const refPanel = $("refPanel");
const refLetter = $("refLetter");
const refImg = $("refImg");
const refCanvas = $("refCanvas");
const refDesc = $("refDesc");
const refHand = $("refHand");
const meterFill = $("meterFill");
const meterLabel = $("meterLabel");
const refHint = $("refHint");
const ghostToggle = $("ghostToggle");
const ghostToggleWrap = $("ghostToggleWrap");
const handPick = $("handPick");
const muteBtn = $("muteBtn");
const toast = $("toast");
const modeToggle = $("modeToggle");
const pickHint = $("pickHint");
const timeBar = $("timeBar");
const scoreBadge = $("scoreBadge");
const scoreVal = $("scoreVal");
const chStreak = $("chStreak");
const chGain = $("chGain");
const chSeeing = $("chSeeing");
const chBanner = $("chBanner");
const chCard = $("chCard");
const chCardTitle = $("chCardTitle");
const chCardSub = $("chCardSub");
const chStart = $("chStart");

const sound = createSound();
const fx = createFx();
const bg = createBackground();

const DETECT_INTERVAL = 1000 / TARGET_FPS;
const HINT_INTERVAL = 250; // ms — throttle the text hint so it doesn't jitter
const HOLD_MS = 1150; // hold a readable sign this long before the reward
const HOLD_GRACE_MS = 260; // tolerate this much tracking flicker without losing the hold
const BUCKET_COLOR = { off: "#f87171", close: "#f59e0b", correct: "#22c55e" };
const BUCKET_LABEL = { off: "keep adjusting", close: "almost there", correct: "hold it…" };
let lastHintAt = 0;
let holdStart = 0; // timestamp the current clean hold began (0 = not holding)
let lastGoodAt = 0; // last frame the sign was complete — for the grace window
let rewarded = false;
let guideAmt = 0; // 0..1 eased "how much correction guide to show"
let handVote = 0; // signed, +right / -left, hysteresis for auto-detect
let trackedHand = "right"; // the signing hand (real, not MediaPipe's mirrored label)
let handOverride = "auto"; // "auto" | "right" | "left" — the Hand control
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
let refPlayer = null; // animates the canonical shape in the panel
let challenge = null; // the speed game
let azRun = false; // practice: walk A -> Z, auto-advancing on each completion
const azDone = new Set();
let mode = "practice"; // "practice" | "challenge"
let pendingChallengeStart = false; // start the game as soon as the camera is up
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
    refPlayer = createCanonicalPlayer(refCanvas);
    challenge = createChallenge({ letters: reference.letters });
    buildLetterPicker(reference.letters);
    learnRow.hidden = false;
    modeToggle.hidden = false;
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
  for (const b of letterPicker.children) b.classList.toggle("on", b.textContent === letter);
  clearTargetBtn.hidden = !letter;
  prevLetterBtn.hidden = !letter;
  nextLetterBtn.hidden = !letter;
  refPanel.hidden = !letter;
  ghostToggleWrap.hidden = !letter;
  workspace.dataset.target = letter ? "on" : "off";
  // collapse the letter grid to a compact strip once one's chosen
  learnRow.classList.toggle("compact", !!letter);
  learnLabel.textContent = azRun ? "A→Z run" : letter ? "Learning" : "Pick a letter";
  learnCurrent.textContent = letter || "";

  holdStart = 0;
  rewarded = false;
  viewport.style.setProperty("--hold", "0");
  if (letter) {
    refLetter.textContent = letter;
    refImg.src = REFERENCE_IMG(letter); // photo always on when learning
    if (refDesc) refDesc.textContent = reference?.describe(letter) || "";
    // the panel was just un-hidden — wait one frame so its real width exists
    // before we size the canvas to it, otherwise the diagram can draw blank.
    requestAnimationFrame(() => {
      sizeRefCanvas();
      refPlayer?.setTarget(reference?.centroid(letter) || null);
    });
    sound.select();
  } else {
    if (refDesc) refDesc.textContent = "";
    refPlayer?.setTarget(null);
    updateMeter(0, null);
    bg.setMatch(null);
  }
  refHint.textContent = "";
}

// ---- A -> Z run: pass every letter once, auto-advancing --------------

function setAzRun(on) {
  if (!reference) return;
  azRun = on;
  learnRow.dataset.run = on ? "on" : "off";
  azProgress.hidden = !on;
  if (on) {
    azDone.clear();
    for (const b of letterPicker.children) b.classList.remove("done");
    updateAzProgress();
    setTarget(reference.letters[0]);
  } else {
    for (const b of letterPicker.children) b.classList.remove("done");
    setTarget(null);
  }
}

function updateAzProgress() {
  azProgress.textContent = `${azDone.size} / ${reference.letters.length}`;
}

function advanceAz() {
  if (!azRun || !reference) return;
  azDone.add(targetLetter);
  for (const b of letterPicker.children) {
    if (b.textContent === targetLetter) b.classList.add("done");
  }
  updateAzProgress();
  const next = reference.letters.find((L) => !azDone.has(L));
  if (next) {
    setTarget(next);
  } else {
    showToast("Alphabet complete!  🎉");
    fx.flash("#22c55e");
    sound.success();
    setTimeout(() => setAzRun(false), 300);
  }
}

// The camera view is a selfie mirror of the reference photo. A RIGHT hand's
// mirrored self-view is the flip of the right-hand reference, so we flip the
// reference to match; a LEFT hand's mirrored self-view already matches it.
function applyHand() {
  refPanel.classList.toggle("mirror", trackedHand === "right");
  if (refHand) refHand.textContent = trackedHand ? `· ${trackedHand} hand` : "";
}

// Crisp canvas: back the animated reference diagram with real device pixels.
function sizeRefCanvas() {
  if (refPanel.hidden || !reference || !targetLetter) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = refCanvas.clientWidth || refCanvas.parentElement?.clientWidth / 2 || 140;
  const size = Math.max(80, Math.round(cssW * dpr));
  if (refCanvas.width !== size) {
    refCanvas.width = size;
    refCanvas.height = size;
  }
  refPlayer?.redraw();
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

// ---- challenge mode -------------------------------------------

function setMode(next) {
  if (!challenge || next === mode) return;
  mode = next;
  viewport.dataset.mode = mode; // CSS hides the camera curtain in challenge
  for (const b of modeToggle.children) b.classList.toggle("on", b.dataset.mode === mode);
  if (azRun) setAzRun(false); // exit an A->Z run when leaving practice
  setTarget(null); // drop any practice target
  challenge.stop();
  clearChallengeHud();
  learnRow.hidden = mode !== "practice";
  ghostToggleWrap.hidden = true;
  if (mode === "challenge") {
    chCardTitle.textContent = "Challenge";
    chCardSub.textContent = state === "tracking" || state === "searching"
      ? "A random letter, a shrinking timer. How far can you get?"
      : "Turn on the camera, then Start.";
    chCard.hidden = false;
  }
}

function clearChallengeHud() {
  timeBar.hidden = true;
  timeBar.classList.remove("low");
  scoreBadge.hidden = true;
  chStreak.hidden = true;
  chGain.hidden = true;
  chSeeing.hidden = true;
  chBanner.hidden = true;
  chCard.hidden = true;
  refPanel.hidden = !targetLetter;
}

function startChallenge() {
  if (!challenge) return;
  if (state !== "tracking" && state !== "searching") {
    // need the camera first — turn it on and auto-begin once it's tracking
    chCardSub.textContent = "Starting camera…";
    pendingChallengeStart = true;
    start();
    return;
  }
  pendingChallengeStart = false;
  chCard.hidden = true;
  scoreBadge.hidden = false;
  scoreVal.textContent = "0";
  chStreak.hidden = true;
  timeBar.hidden = false;
  challenge.start(performance.now());
}

let lastTickAt = 0;

// react to the game snapshot each frame. `seeing` = what the recogniser reads
// right now (for the on-screen "seeing: X" feedback).
function renderChallenge(snap, seeing) {
  if (!snap) return;
  timeBar.style.setProperty("--time", snap.remainingFrac.toFixed(3));
  timeBar.classList.toggle("low", !!snap.low);

  if (snap.low && performance.now() - lastTickAt > 430) {
    lastTickAt = performance.now();
    sound.tick();
  }

  if (snap.event === "letter") {
    setTarget(snap.letter); // shows the demo + description in the panel
    refPanel.hidden = false;
    workspace.dataset.target = "on";
    chBanner.hidden = true;
    chSeeing.hidden = true;
  } else if (snap.event === "go") {
    refPanel.hidden = true;
    workspace.dataset.target = "off";
    chBanner.className = "ch-banner go";
    chBanner.textContent = "GO";
    chBanner.hidden = false;
  } else if (snap.event === "play") {
    stabilizer?.reset(); // the letter must be formed FRESH during play
  } else if (snap.event === "win") {
    scoreVal.textContent = String(snap.score);
    scoreBadge.classList.remove("pop");
    void scoreBadge.offsetWidth;
    scoreBadge.classList.add("pop");
    chStreak.hidden = snap.streak < 2;
    chStreak.textContent = `🔥${snap.streak}`;
    chGain.textContent = `+${snap.lastGain}`;
    chGain.hidden = false;
    chGain.classList.remove("ch-gain");
    void chGain.offsetWidth;
    chGain.classList.add("ch-gain");
    chBanner.className = "ch-banner win";
    chBanner.textContent = "✓";
    chBanner.hidden = false;
    chSeeing.hidden = true;
    fx.flash("#22c55e");
    sound.success();
  } else if (snap.event === "over") {
    timeBar.hidden = true;
    timeBar.classList.remove("low");
    chBanner.hidden = true;
    chSeeing.hidden = true;
    refPanel.hidden = true;
    chCardTitle.textContent = "Run over";
    chCardSub.innerHTML =
      `Score <b>${snap.score}</b> · Best <b>${snap.best}</b><br>` +
      `Reached round ${snap.round} · missed <b>${snap.missedLetter}</b>`;
    chStart.textContent = "Play again";
    chCard.hidden = false;
    sound.charge(0);
    sound.fail();
  }

  if (snap.phase === "play") {
    refPanel.hidden = true;
    workspace.dataset.target = "off";
    chBanner.className = "ch-banner";
    chBanner.textContent = snap.letter;
    chBanner.hidden = false;
    chSeeing.hidden = false;
    chSeeing.innerHTML = seeing
      ? `seeing <b>${seeing}</b>`
      : `seeing <b>—</b>`;
  } else if (snap.phase === "study") {
    chBanner.hidden = true;
    chSeeing.hidden = true;
  }
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
  if (azRun) setTimeout(advanceAz, 950); // let the reward land, then move on
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
  handPick.hidden = !live;
  startBtn.disabled = next === "requesting" || next === "loading";
  if (!live) {
    statsEl.hidden = true;
    letterBadge.hidden = true;
    pickHint.hidden = true;
    viewport.dataset.match = "none";
    holdStart = 0;
    rewarded = false;
    smoothPts = null;
    guideAmt = 0;
    viewport.style.setProperty("--hold", "0");
    sound.charge(0);
    bg.setMatch(null);
    if (challenge?.active) {
      challenge.stop();
      clearChallengeHud();
    }
  }
  // camera just came up while waiting to start a challenge
  if ((next === "searching" || next === "tracking") && pendingChallengeStart) {
    pendingChallengeStart = false;
    startChallenge();
  } else if (live && mode === "challenge" && challenge && !challenge.active && !chCard.hidden) {
    chCardTitle.textContent = "Challenge";
    chCardSub.textContent = "A random letter, a shrinking timer. How far can you get?";
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
    "Then pick a letter to learn, or switch to Challenge mode. " +
    "Runs entirely on your device — nothing is recorded or uploaded.";
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

// exponential moving average over the 21 landmarks — smooths tracker jitter so
// the skeleton looks fluid and the match meter doesn't twitch. alpha ~0.5 is a
// good jitter/latency trade. Pass null to reset (hand lost).
let smoothPts = null;
function smoothLandmarks(raw) {
  if (!raw) {
    smoothPts = null;
    return null;
  }
  if (!smoothPts || smoothPts.length !== raw.length) {
    smoothPts = raw.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    return smoothPts;
  }
  const a = 0.5;
  for (let i = 0; i < raw.length; i++) {
    smoothPts[i].x += (raw[i].x - smoothPts[i].x) * a;
    smoothPts[i].y += (raw[i].y - smoothPts[i].y) * a;
    smoothPts[i].z += (raw[i].z - smoothPts[i].z) * a;
  }
  return smoothPts;
}

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
  const mpLabel = hasHand ? result.handedness?.[0]?.[0]?.categoryName : null;
  // `left` drives the classification mirror — kept keyed on MediaPipe's raw
  // label because the dataset was built with the exact same rule.
  const left = mpLabel === "Left";
  // We feed MediaPipe a NON-mirrored frame; it reports handedness assuming a
  // mirrored (selfie) one, so the REAL hand is the opposite of its label.
  const realHand = mpLabel === "Left" ? "right" : mpLabel === "Right" ? "left" : null;
  // guide is a practice-mode thing only — the challenge gives you no help
  const guiding =
    mode === "practice" && reference && targetLetter && ghostToggle.checked;

  // which hand is signing — sticky with hysteresis, unless the user forced it
  if (hasHand && handOverride === "auto" && realHand) {
    handVote = Math.max(-8, Math.min(8, handVote + (realHand === "right" ? 1 : -1)));
    const h = handVote > 3 ? "right" : handVote < -3 ? "left" : trackedHand;
    if (h !== trackedHand) {
      trackedHand = h;
      applyHand();
    }
  }

  // smooth the raw landmarks (EMA) — kills the frame-to-frame jitter that makes
  // the skeleton look stringy, and steadies the meter. Reset on a lost hand so
  // it doesn't lerp across a re-acquire.
  const hand = smoothLandmarks(hasHand ? result.landmarks[0] : null);

  // normalize once; reused by the classifier, the practice meter, and the guide
  let vec = null;
  if (hasHand && (classifier || reference)) {
    vec = normalizeLandmarks(hand, {
      aspect: aspectOf(video),
      mirrorX: MIRROR_LEFT_HAND && left,
      extended: USE_EXTENDED_FEATURES, // must match how the dataset was built
    });
  }

  // classify up front too (badge is drawn later) so the practice meter can
  // accept a sign the recogniser reads even if the shape isn't textbook
  if (classifier) {
    lastPred = hasHand && vec ? classifier.classify(vec) : null;
    stabilizer.push(hasHand ? lastPred : null);
  }

  // score the shape once — the guide's reveal ramp and the practice block need it
  const m = hasHand && vec && reference && targetLetter
    ? reference.score(vec, targetLetter)
    : null;
  // a "close" shape the recogniser confidently reads AS the target counts as
  // correct — a functioning, readable sign, not a perfect one
  if (
    m &&
    m.bucket === "close" &&
    lastPred &&
    lastPred.label === targetLetter &&
    lastPred.confidence >= 0.6
  ) {
    m.bucket = "correct";
  }

  // progressive disclosure: the correction guide only fades in once you're
  // actually attempting the shape (score climbing out of "way off"), so the
  // default view stays a clean plain skeleton.
  const revealTarget = m ? Math.max(0, Math.min(1, (m.score - 0.35) / 0.3)) : 0;
  guideAmt += (revealTarget - guideAmt) * 0.12;

  let guideInfo = null; // { part } for the worst-off joint — named in the hint
  if (hasHand) {
    if (guiding) {
      guideInfo = overlay.drawGuide(hand, reference.centroid(targetLetter), {
        aspect: aspectOf(video),
        mirror: MIRROR_LEFT_HAND && left,
        tol: reference.tolerance(targetLetter),
        align: vec ? reference.alignDeg(vec, targetLetter) : 0,
        reveal: guideAmt,
        settled: m?.bucket === "correct", // don't nag once it already counts
      });
    } else {
      overlay.drawHands([hand]);
    }
    missStreak = 0;
    if (state !== "tracking") setState("tracking");
  } else {
    missStreak++;
    if (missStreak >= LOST_HAND_FRAMES && state !== "searching") setState("searching");
  }

  // recognition -> corner badge (hidden during the challenge — no peeking)
  if (classifier) {
    const shown = mode === "practice" ? stabilizer.current : null;
    letterBadge.hidden = !shown;
    if (shown) letterBadge.textContent = shown;
  }

  // challenge: you advance when the RECOGNISER reads your hand as the target
  // (a confident, debounced call — not a shape-meter guess). The "seeing"
  // readout uses the raw current prediction so it feels responsive.
  if (mode === "challenge" && challenge?.active) {
    const seen = stabilizer.current; // debounced: only after N sure frames
    const seeing = lastPred && lastPred.confidence >= 0.5 ? lastPred.label : null;
    renderChallenge(challenge.update(now, seen), seeing);
    bg.setMatch(null);
  }

  // practice: camera-frame glow + meter + a plain-words hint + the reward
  if (mode === "practice" && reference && targetLetter) {
    if (hasHand && m) {
      updateMeter(m.score, m.bucket); // shape match only — not gated on the classifier
      // ambient background warms toward green, and reacts in the direction of
      // the problem (fingers off -> top; thumb side off -> that side)
      bg.setMatch(m.score, m.bucket, reference.regionErrors(vec, targetLetter));

      // reward when the sign is readable (m.bucket === "correct" — a decent
      // shape OR one the recogniser reads as the target) and held for HOLD_MS.
      // Small tracking dropouts inside HOLD_GRACE_MS don't reset the timer.
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
      // rising "charge" tone tracks the hold; success() resolves it
      if (holdStart && !rewarded) sound.charge(0.05 + 0.95 * heldFrac);
      else if (!rewarded) sound.charge(0);
      if (holdStart && heldMs >= HOLD_MS && !rewarded) {
        rewarded = true;
        reward(hand[0]);
      }

      if (now - lastHintAt >= HINT_INTERVAL) {
        lastHintAt = now;
        const misread =
          lastPred && lastPred.label !== targetLetter && lastPred.confidence >= 0.8;
        let tip = reference.hint(vec, targetLetter);
        // hint() can say "looks right" from the coarse feature check while the
        // meter is still short — fall back to the precise joint the on-camera
        // guide is pointing at, so the endgame ("near perfect, can't see what")
        // still has something to act on.
        if (!complete && /looks right/i.test(tip)) {
          tip = guideInfo?.finger
            ? `Adjust your ${guideInfo.finger} finger — follow the yellow marker`
            : guideInfo?.part
            ? `Nudge your ${guideInfo.part} to the marker`
            : m.bucket === "close"
            ? "So close — tiny adjustments"
            : "Keep shaping it";
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
      if (!rewarded) sound.charge(0);
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

  // "pick a letter" nudge — only in practice, camera live, nothing chosen yet
  pickHint.hidden = !(mode === "practice" && !targetLetter);

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
modeToggle.addEventListener("click", (e) => {
  const b = e.target.closest(".mode-btn");
  if (b) setMode(b.dataset.mode);
});
azToggle.addEventListener("click", () => setAzRun(!azRun));
const stepLetter = (dir) => {
  if (!reference || !targetLetter || azRun) return;
  const list = reference.letters;
  const i = list.indexOf(targetLetter);
  setTarget(list[(i + dir + list.length) % list.length]);
};
prevLetterBtn.addEventListener("click", () => stepLetter(-1));
nextLetterBtn.addEventListener("click", () => stepLetter(1));
handPick.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-hand]");
  if (!b) return;
  handOverride = b.dataset.hand;
  for (const el of handPick.querySelectorAll("button")) el.classList.toggle("on", el === b);
  if (handOverride !== "auto") {
    trackedHand = handOverride;
    handVote = 0;
  }
  applyHand();
});
chStart.addEventListener("click", () => {
  chStart.textContent = "Start";
  startChallenge();
});
