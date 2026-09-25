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
import { normalizeLandmarks, aspectOf, mirrorVector } from "./normalize.js";
import { loadDataset } from "./dataset.js";
import { createClassifier, classifyEitherHand } from "./knn.js";
import { createHandshapeJudge } from "./handshape.js";
import { judgeLetter } from "./verdict.js";
import { loadRefiner } from "./heads.js";
import { createStabilizer } from "./stabilizer.js";
import { buildReference, createCanonicalPlayer, LETTER_GUIDE } from "./reference.js";
import { createSheet } from "./sheet.js";
import { createSound } from "./sound.js";
import { createFx } from "./fx.js";
import { rewardTier, nextRun, celebrationPlan, glowLevel } from "./juice.js";
import { createHero } from "./hero.js";
import { createAurora } from "./aurora.js"; // falls back to bg.js without WebGL2
import { createHandFx, createFramingJudge, handSpanH } from "./handfx.js";
import { createInkBloom } from "./inkbloom.js";
import { createGlyphFx } from "./glyphfx.js";
import { createChallengeFx, burstCount } from "./challengefx.js";
import { createGovernor, hasWebGL2, mountFxDebug } from "./fxquality.js";
import { createChallenge, START_LIVES, PAUSE_GAP_MS } from "./challenge.js";
import { createVersus } from "./versus.js";
import { createLeaderboard } from "./leaderboard.js";
import { createMotionMatcher } from "./motion.js";
import { createSpeller, STROKE_START } from "./speller.js";
import { createSpellDrill } from "./spelldrill.js";
import { createSwipeMatcher } from "./swipe.js";
import { createTwoHandMatcher } from "./twohand.js";
import { createTransitionMatcher } from "./transition.js";
import { buildLexicon, createDecoder, mergeConfusion } from "./decode.js";
import { createReader } from "./reader.js";
import { createCourse } from "./curriculum.js";
import { createTour } from "./tour.js";
import {
  TARGET_FPS,
  LOST_HAND_FRAMES,
  OVERLAY_GRACE_FRAMES,
  ONE_EURO_MIN_CUTOFF,
  ONE_EURO_BETA,
  ONE_EURO_DCUTOFF,
  DATASET_URL,
  LETTERS,
  ALL_LETTERS,
  MOTION_LETTERS,
  USE_EXTENDED_FEATURES,
  KNN_K,
  MIRROR_LEFT_HAND,
  MIN_CONFIDENCE,
  STABLE_FRAMES,
  REFERENCE_IMG, REJECT_DIST } from "./config.js";
import { createLandmarkFilter } from "./onefilter.js";

const MOTION = new Set(MOTION_LETTERS); // J, Z — traced, not held
const motion = createMotionMatcher();
const swipe = createSwipeMatcher(); // spell mode: open-hand sideways sweep = delete
const twohand = createTwoHandMatcher(); // spell mode: hands together = copy, apart = paste
const transition = createTransitionMatcher(); // fluid mode: rhythm-based letter segmentation
let decoder = null; // fluid mode: lexicon decoder — loaded in the background
let lastDecodeAt = 0;
let loadedConfusion = null; // data/confusion.json, blended — shared with reader.js's near-miss diff
let wordBankFailed = false;
let curriculumFailed = false;
let decoderFailed = false;

const $ = (id) => document.getElementById(id);
const workspace = $("workspace");
const viewport = $("viewport");
const video = $("camera");
const canvas = $("overlay");

// Dev-only: "?dev" in the URL exposes live module internals on window so
// tools/testHarness.js can drive the app with synthetic hand data instead of
// a real webcam. Checked once at load — zero cost when absent, and the one
// place it's used below (start()) runs once per camera session, not per
// frame, so it costs nothing in the real camera path either way.
const DEV = new URLSearchParams(location.search).has("dev");
// "?debug" in the URL exposes raw tuning telemetry (Spell's live gesture
// metrics, J/Z's move/drop/turns numbers) that otherwise reads to a learner
// as "here's exactly how you failed" rather than useful feedback — see the
// plan's S5 stage. Off by default; checked once, same cost model as DEV.
const DEBUG = new URLSearchParams(location.search).has("debug");
const pillText = $("pillText");
const statsEl = $("stats");
const curtainSub = $("curtainSub");
const letterBadge = $("letterBadge");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const flipBtn = $("flipBtn");
const learnRow = $("learnRow");
const subMode = $("subMode");
const learnCurrent = $("learnCurrent");
const azProgress = $("azProgress");
const azSkip = $("azSkip");
const prevLetterBtn = $("prevLetter");
const nextLetterBtn = $("nextLetter");
const letterPicker = $("letterPicker");
const clearTargetBtn = $("clearTarget");
const refPanel = $("refPanel");
const refHandle = $("refHandle");
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
const blindToggle = $("blindToggle");
const blindToggleWrap = $("blindToggleWrap");
const handPick = $("handPick");
const muteBtn = $("muteBtn");
const controls = document.querySelector(".controls");
const toast = $("toast");
const modeToggle = $("modeToggle");
const pickHint = $("pickHint");
const framingCue = $("framingCue");
let raceLockFrac = [0, 0]; // Race lockout remaining 0..1 per player (versus snapshot)
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
const chSkip = $("chSkip");
const chSummary = $("chSummary");
const chDiff = $("chDiff");
const chBests = $("chBests");
const chCombo = $("chCombo");
const chPlayGroup = $("chPlay");
const chBoardBtn = $("chBoardBtn");
const chBoard = $("chBoard");
const vsHud = $("vsHud");
const vsP1 = $("vsP1");
const vsP2 = $("vsP2");
const vsTurn = $("vsTurn");
const chLives = $("chLives");
const azNext = $("azNext");
const reco = $("reco");
const recoText = $("recoText");
const letterStat = $("letterStat");
const demoZoomBtn = $("demoZoomBtn");
const demoZoom = $("demoZoom");
const demoZoomCanvas = $("demoZoomCanvas");
const demoZoomImg = $("demoZoomImg");
const refPhotoBtn = $("refPhotoBtn");
const progressBtn = $("progressBtn");
const progressCount = $("progressCount");
const progressPanel = $("progressPanel");
const progressClose = $("progressClose");
const progressStreak = $("progressStreak");
const progressGrid = $("progressGrid");
const contrastBtn = $("contrastBtn");
const runCard = $("runCard");
const runCardTitle = $("runCardTitle");
const runCardBody = $("runCardBody");
const runCardClose = $("runCardClose");
const spellPanel = $("spellPanel");
const spText = $("spText");
const spPending = $("spPending");
const spRing = $("spRing");
const spSpace = $("spSpace");
const spBack = $("spBack");
const spClear = $("spClear");
const spCopy = $("spCopy");
const spPaste = $("spPaste");
const spGrid = $("spGrid");
const spMetrics = $("spMetrics");
const spHint = $("spHint");
const spFluid = $("spFluid");
const gHoldText = $("gHoldText");
const spStep1 = $("spStep1");
const spStep2 = $("spStep2");
const spDecodedRow = $("spDecodedRow");
const spDecodedText = $("spDecodedText");
const spSpeak = $("spSpeak");
const spAutoSpeak = $("spAutoSpeak");
const spDrill = $("spDrill");
const spDrillSrc = $("spDrillSrc");
const spDrillRow = $("spDrillRow");
const spDrillWord = $("spDrillWord");
const spDrillSkip = $("spDrillSkip");
const spDrillScore = $("spDrillScore");
const readPanel = $("readPanel");
const rdModes = $("rdModes");
const rdCourse = $("rdCourse");
const rdPath = $("rdPath");
const rdLessonName = $("rdLessonName");
const rdLessonProg = $("rdLessonProg");
const rdLessonBlurb = $("rdLessonBlurb");
const rdBar = $("rdBar");
const rdCats = $("rdCats");
const rdScore = $("rdScore");
const rdCanvas = $("rdCanvas");
const rdPlay = $("rdPlay");
const rdPause = $("rdPause");
const rdStepBack = $("rdStepBack");
const rdStepFwd = $("rdStepFwd");
const rdSeek = $("rdSeek");
const rdTicks = $("rdTicks");
const rdSpeed = $("rdSpeed");
const rdLen = $("rdLen");
const rdForm = $("rdForm");
const rdInput = $("rdInput");
const rdReveal = $("rdReveal");
const rdFeedback = $("rdFeedback");
const rdNext = $("rdNext");
const rdLoadError = $("rdLoadError");
const spDecodeError = $("spDecodeError");

const sound = createSound();
const fx = createFx();
// on-hand feedback (hold arc, landed ring, ripples, tip beads, Race badges) —
// drawn into the overlay canvas, so it's created once the overlay exists
let handfx = null;
let fxHand = null; // the latest smoothed hand, for rewards fired outside loop()
let inkbloom = null; // B3: fingertip ink bloom (fluid core, "full" only)
let glyphfx = null; // B3: particles assemble into the letter (first / mastery)
const framing = createFramingJudge();

// ---- reward juice (2026-09-25) --------------------------------------------
// Combo glow on the camera frame — the visual twin of a climbing streak
// sound (Challenge combo, Practice runs). Created here rather than in
// index.html: purely decorative, aria-hidden, pointer-events:none (CSS).
const comboGlow = document.createElement("div");
comboGlow.className = "combo-glow";
comboGlow.setAttribute("aria-hidden", "true");
viewport.appendChild(comboGlow);
let glowTimer = 0;
// level 0..3; ttlMs > 0 fades it back out on its own (Practice runs lapse)
function setGlow(level, ttlMs = 0) {
  comboGlow.dataset.level = String(level | 0);
  bg.setStreak((level | 0) / 3); // aurora amber = "on a roll" (never "close")
  clearTimeout(glowTimer);
  if (level && ttlMs > 0) glowTimer = setTimeout(() => { comboGlow.dataset.level = "0"; bg.setStreak(0); }, ttlMs);
}
// Practice "in a row" run: another rep within RUN_WINDOW_MS extends it
const RUN_WINDOW_MS = 30000;
let practiceRun = 0;
let practiceRunAt = null;
// a landmark (normalized video coords) -> page coords, un-mirroring selfie view
function pagePoint(lm) {
  const r = viewport.getBoundingClientRect();
  if (!lm) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  const mx = facingMode === "user" ? 1 - lm.x : lm.x;
  return { x: r.left + mx * r.width, y: r.top + lm.y * r.height };
}
// centre of an element, for rewards that aren't on the hand (Read, drill)
function elCenter(el) {
  const r = el?.getBoundingClientRect?.();
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : pagePoint(null);
}

// S4b: the reference panel is a non-modal bottom sheet on mobile (a full
// side column on landscape/desktop, where "sheet-open" is forced by CSS
// regardless of this state — see .reference's landscape media query).
// Non-modal because you're meant to glance at it WHILE still signing at the
// camera behind it, unlike a true dialog — camera interaction never blocks.
const refSheet = createSheet(refPanel, { modal: false });
function syncRefHandle() {
  refHandle.setAttribute("aria-expanded", String(refSheet.isOpen()));
  refHandle.setAttribute("aria-label", refSheet.isOpen() ? "collapse reference details" : "expand reference details");
}
// expanded by default whenever a new letter's reference appears — the
// collapse is an opt-in for more camera room, not the starting point
function openRefSheet() {
  refSheet.open();
  syncRefHandle();
}
refHandle.addEventListener("click", () => {
  refSheet.toggle();
  syncRefHandle();
});

// ---- couldn't-load banners (S3) ---------------------------------
// A failed fetch used to fail silently (`.catch(() => {})`) and leave
// whatever depended on it permanently missing with no sign why — Read mode
// stuck on "loading word list…" forever, Course tab just empty. This makes
// the failure visible with a real retry action instead.
function showLoadError(el, label, retryFn) {
  if (!el) return;
  el.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = `⚠ ${label}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Retry";
  btn.addEventListener("click", () => {
    hideLoadError(el);
    retryFn();
  });
  el.appendChild(span);
  el.appendChild(btn);
  el.hidden = false;
}
function hideLoadError(el) {
  if (el) el.hidden = true;
}
// Re-checked on mode entry too (not just at fetch time) — a failure that
// happened while the user was in a different mode must still surface once
// they actually switch into Read/Spell, not only if they were already there.
function refreshReadLoadError() {
  if (wordBankFailed) showLoadError(rdLoadError, "Couldn't load the word list", loadWordBank);
  else if (curriculumFailed && readStyle === "course") showLoadError(rdLoadError, "Couldn't load lessons", loadCurriculum);
  else hideLoadError(rdLoadError);
}
function refreshSpellLoadError() {
  if (decoderFailed) showLoadError(spDecodeError, "Couldn't load the sentence decoder — spelling still works", loadDecoderAssets);
  else hideLoadError(spDecodeError);
}

// ---- tiny persistence ------------------------------------------
const PREF = "asl-pref-";
const loadPref = (k, d = null) => {
  try {
    const v = localStorage.getItem(PREF + k);
    return v === null ? d : v;
  } catch {
    return d;
  }
};
const savePref = (k, v) => {
  try {
    localStorage.setItem(PREF + k, v);
  } catch {}
};
const loadJSON = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(PREF + k)) ?? d;
  } catch {
    return d;
  }
};
const saveJSON = (k, v) => savePref(k, JSON.stringify(v));
// Haptic buzz is a form of motion too — gate it on the same OS-level
// preference fx.js/bg.js/reference.js respect, live-subscribed so a
// mid-session toggle takes effect immediately.
const reduceMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let reduceMotion = reduceMotionQuery?.matches ?? false;
reduceMotionQuery?.addEventListener?.("change", (e) => { reduceMotion = e.matches; });
// ---- visual effects budget (visual layer v2, B0) — js/fxquality.js --------
// One governor decides how much every effect may draw ("full" | "lite" |
// "off") so MediaPipe's GPU delegate keeps ~30 detections/s. The "Effects"
// button in the top bar cycles the manual override (Auto / Lite / Off),
// persisted like the other prefs; ?debug shows effect ms + detection fps.
const FX_LABEL = { auto: "Auto", lite: "Lite", off: "Off" };
const fxq = createGovernor({
  override: FX_LABEL[loadPref("fx")] ? loadPref("fx") : "auto",
  reducedMotion: reduceMotion,
  webgl2: hasWebGL2(),
  hidden: document.visibilityState === "hidden",
});
reduceMotionQuery?.addEventListener?.("change", (e) => fxq.set({ reducedMotion: e.matches }));
const fxDebug = DEBUG ? mountFxDebug(fxq) : null;
const fxBtn = $("fxBtn");
function syncFxBtn() {
  const o = fxq.state().override;
  fxBtn.querySelector(".fx-val").textContent = FX_LABEL[o] || "Auto";
  fxBtn.setAttribute("aria-label", `Visual effects: ${FX_LABEL[o] || "Auto"} (now ${fxq.level}) — tap to change`);
  fxBtn.title = `Visual effects: ${FX_LABEL[o] || "Auto"}`;
}
fxBtn.addEventListener("click", () => {
  const order = ["auto", "lite", "off"];
  const next = order[(order.indexOf(fxq.state().override) + 1) % order.length];
  savePref("fx", next);
  fxq.set({ override: next });
  syncFxBtn();
});
fxq.subscribe(syncFxBtn);
syncFxBtn();
// CSS effects read the level too (e.g. the liquid hold meter stops flowing on "off")
const syncFxAttr = () => { document.documentElement.dataset.fx = fxq.level; };
fxq.subscribe(syncFxAttr);
syncFxAttr();
document.addEventListener("visibilitychange", () => fxq.set({ hidden: document.visibilityState === "hidden" }));
// always-on background (B1): WebGL2 aurora, bg.js canvas blobs as fallback —
// same setMatch(score, bucket, regions) API either way
const bg = createAurora({ governor: fxq, viewport, debug: DEBUG });
if (DEBUG) window.__fx = { bg, gov: fxq }; // measure effects in isolation (see aurora.js bench)
// B4: adaptive Challenge visuals — one intensity (combo, streak, word length,
// difficulty) drives the aurora ramp, a frame aura, the banner and bursts
const chAura = document.createElement("div");
chAura.className = "ch-aura";
chAura.setAttribute("aria-hidden", "true");
chAura.hidden = true;
viewport.appendChild(chAura);
const cfx = createChallengeFx({ bg, aura: chAura, banner: chBanner, timeBar, combo: chCombo, governor: fxq });
if (DEBUG) window.__fx.cfx = cfx;
let raceHands = [null, null]; // Race: each player's latest hand (palm burst for the round winner)
let vsProgressSeen = [0, 0]; // word rounds: letters each player had landed last frame
let vsWaiting = false; // Take turns: the waiting player's hand is up
// only rewrite the banner when it changes — per-frame innerHTML restarted
// the landed letter's pop animation every frame
let partHitAt = 0;
function setBannerHtml(html) {
  if (chBanner.innerHTML === html) return; // compare live DOM: other paths set textContent
  chBanner.innerHTML = html;
}
let fxPrevHand = null; // last frame's smoothed landmarks, for hand speed
let fxPrevAt = 0;

const buzz = (p) => {
  if (reduceMotion) return;
  try {
    navigator.vibrate?.(p);
  } catch {}
};

// ---- on-camera colour key (Stage 7c) -----------------------------
// A "● ● ● ?" chip in the camera's top-left corner whenever the correction
// guide is on; tap it for the legend (good / close / fix / target / worst
// finger). It also opens by itself the first COLOR_KEY_AUTO_MAX times a "fix"
// state stays on the hand for COLOR_KEY_FIX_MS — the moment a new user is
// looking at magenta bones and wondering what they mean — and closes again
// after COLOR_KEY_AUTO_CLOSE_MS unless the user taps it. Legend rows for the
// states currently on the hand get a .live highlight.
const colorKey = $("colorKey");
const colorKeyBtn = $("colorKeyBtn");
const colorKeyList = $("colorKeyList");
const COLOR_KEY_FIX_MS = 3000;
const COLOR_KEY_AUTO_MAX = 2;
const COLOR_KEY_AUTO_CLOSE_MS = 8000;
let colorKeyAutoCount = Number(loadPref("colorkey-auto", "0")) || 0;
let colorKeyShown = false;
let colorKeyFixSince = 0;
let colorKeyAutoTimer = 0;
let colorKeyLiveKey = "";
function setColorKeyOpen(open) {
  colorKeyList.hidden = !open;
  colorKeyBtn.setAttribute("aria-expanded", String(open));
  colorKey.classList.toggle("open", open);
}
colorKeyBtn.addEventListener("click", () => {
  clearTimeout(colorKeyAutoTimer);
  colorKeyAutoTimer = 0;
  setColorKeyOpen(colorKeyList.hidden);
});
function updateColorKey(visible, stats, now) {
  if (visible !== colorKeyShown) {
    colorKeyShown = visible;
    colorKey.hidden = !visible;
    colorKeyFixSince = 0;
  }
  if (!visible) return;
  const live = stats?.shown
    ? `${stats.counts.good ? "g" : ""}${stats.counts.close ? "c" : ""}${stats.counts.fix ? "f" : ""}${stats.ghost ? "t" : ""}${stats.worstFinger ? "w" : ""}`
    : "";
  if (live !== colorKeyLiveKey) {
    colorKeyLiveKey = live;
    for (const li of colorKeyList.children) li.classList.toggle("live", live.includes(li.dataset.k));
  }
  if (stats?.counts.fix) {
    if (!colorKeyFixSince) colorKeyFixSince = now;
    else if (
      now - colorKeyFixSince > COLOR_KEY_FIX_MS &&
      colorKeyAutoCount < COLOR_KEY_AUTO_MAX &&
      colorKeyList.hidden
    ) {
      colorKeyAutoCount++;
      savePref("colorkey-auto", String(colorKeyAutoCount));
      setColorKeyOpen(true);
      colorKeyFixSince = 0;
      clearTimeout(colorKeyAutoTimer);
      colorKeyAutoTimer = setTimeout(() => {
        colorKeyAutoTimer = 0;
        setColorKeyOpen(false);
      }, COLOR_KEY_AUTO_CLOSE_MS);
    }
  } else {
    colorKeyFixSince = 0;
  }
}

// (the first-visit walkthrough is js/tour.js, wired near the end of this file —
// it replaced the static #intro popup in Stage 7a)

const HARD_LETTERS = new Set(["M", "N", "D"]); // recogniser is weaker on these
const statsMap = loadJSON("stats", {});
const MASTERY_DONE = 3; // completions before a letter counts as "mastered"

// ---- practice progress: mastery grid + daily streak ---------------
// statsMap already tracked {done, bestMs} per letter for the small
// "done 3x . best 2.1s" line, but nothing ever summed it up into something
// you could look at and feel good about. This is that view.

function masteryCounts() {
  let mastered = 0, started = 0;
  for (const L of ALL_LETTERS) {
    const d = statsMap[L]?.done || 0;
    if (d >= MASTERY_DONE) mastered++;
    else if (d > 0) started++;
  }
  return { mastered, started, total: ALL_LETTERS.length };
}

function renderProgressCount() {
  const { mastered, total } = masteryCounts();
  progressCount.textContent = `${mastered}/${total}`;
}

function renderProgressPanel() {
  progressGrid.innerHTML = "";
  for (const L of ALL_LETTERS) {
    const d = statsMap[L]?.done || 0;
    const cell = document.createElement("div");
    cell.className = "pg-cell" + (d >= MASTERY_DONE ? " mastered" : d > 0 ? " started" : "");
    cell.textContent = L;
    cell.title = d ? `${L}: done ${d}×` : `${L}: not practiced yet`;
    progressGrid.appendChild(cell);
  }
  const streak = Number(loadPref("streak", "0"));
  progressStreak.textContent = streak >= 2 ? `🔥 ${streak}-day streak` : "Practice today to start a streak";
  renderProgressCount();
}

// call once per completed rep. Local calendar day, not UTC, so it lines up
// with when the user actually feels like their "day" is.
function touchStreak() {
  const today = new Date();
  const key = `${today.getFullYear()}-${today.getMonth()}-${today.getDate()}`;
  if (loadPref("last-practice-day") === key) return; // already counted today
  const prevDay = loadPref("last-practice-day");
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = `${yesterday.getFullYear()}-${yesterday.getMonth()}-${yesterday.getDate()}`;
  const streak = prevDay === yKey ? Number(loadPref("streak", "0")) + 1 : 1;
  savePref("streak", String(streak));
  savePref("last-practice-day", key);
}

progressBtn.addEventListener("click", () => {
  renderProgressPanel();
  progressPanel.hidden = false;
});
progressClose.addEventListener("click", () => { progressPanel.hidden = true; });
progressPanel.addEventListener("click", (e) => {
  if (e.target === progressPanel) progressPanel.hidden = true; // click the backdrop to close
});
renderProgressCount(); // show a real count on load, not the "0/26" placeholder

// ---- high contrast: in-app toggle, on top of the OS-level preference ------
// Was prefers-contrast:more only — no way to turn it on regardless of system
// setting. loadPref("contrast") holds an explicit user override ("1"/"0");
// with no override, follow the OS media query and keep following it live.
const contrastQuery = window.matchMedia?.("(prefers-contrast: more)");
function applyContrast(on) {
  document.documentElement.classList.toggle("high-contrast", on);
  contrastBtn.setAttribute("aria-pressed", String(on));
}
function currentContrastPref() {
  const stored = loadPref("contrast");
  return stored === null ? null : stored === "1";
}
applyContrast(currentContrastPref() ?? contrastQuery?.matches ?? false);
contrastQuery?.addEventListener?.("change", (e) => {
  if (currentContrastPref() === null) applyContrast(e.matches); // no override — keep following the OS
});
contrastBtn.addEventListener("click", () => {
  const next = !document.documentElement.classList.contains("high-contrast");
  savePref("contrast", next ? "1" : "0");
  applyContrast(next);
});

const DETECT_INTERVAL = 1000 / TARGET_FPS;
const HINT_INTERVAL = 250; // ms — throttle the text hint so it doesn't jitter
const HOLD_MS = 1150; // hold a readable sign this long before the reward
const HOLD_GRACE_MS = 260; // hand LOST: tolerate this much tracking flicker without losing the hold
const HOLD_PRESENT_GRACE_MS = 100; // hand in view but shape broken: ~3 frames of noise, no more
const RELEASE_SETTLE_MS = 400; // after a new letter appears, ignore the hand this long
const BUCKET_COLOR = { off: "#f87171", close: "#f59e0b", correct: "#22c55e" };
// Meter labels (Stage 7e): say what to DO, not just how close you are. The
// first set points at the on-camera ▲ marker; the plain set is for when the
// guide isn't drawn (guide off, Test blind, J/Z).
const BUCKET_LABEL = { off: "fix the ▲ finger", close: "almost — nudge the ▲ finger", correct: "hold still…" };
const BUCKET_LABEL_PLAIN = { off: "keep shaping it", close: "almost there", correct: "hold still…" };
// When the recogniser reads a letter that differs from the target mainly by
// which way the hand points, say so instead of a generic shape tip.
const ORIENT_TIP = {
  G: "turn your hand so your fingers point across your body",
  H: "turn your hand so your fingers point across your body",
  P: "tip your hand so your index finger points down",
  Q: "point your thumb and index finger down at the floor",
};
// Look-alike pairs the camera can't split by shape alone (M vs N measure the
// same in the landmarks — tools/lab, 2026-09-25): name the one difference.
// Keyed target + what it looks like.
const PAIR_TIP = {
  NM: "for N only your index and middle fingers go over your thumb; its tip peeks out between your middle and ring fingers",
  MN: "for M three fingers (index, middle, ring) go over your thumb; its tip peeks out between your ring finger and pinky",
};
let lastHintAt = 0;
let holdStart = 0; // timestamp the current clean hold began (0 = not holding)
let lastGoodAt = 0; // last frame the sign was complete — for the grace window
let needRelease = false; // new letter: wait for the old sign to be released
let releaseFrom = null; // the letter whose hand must be released
let armedAt = 0; // performance.now() before which the new letter can't count
let azAdvancePending = false; // a reward is waiting to advance the A->Z run
let targetLetterBefore = null; // the target before the current setTarget() call
// offscreen player that renders the still J/Z "how to trace it" diagrams
const diagramCanvas = document.createElement("canvas");
diagramCanvas.width = diagramCanvas.height = 480;
let diagramPlayer = null;
const diagramCache = new Map();
function strokeDiagramURL(letter) {
  if (diagramCache.has(letter)) return diagramCache.get(letter);
  if (!diagramPlayer) return null;
  let url = null;
  try {
    const cx = diagramCanvas.getContext("2d");
    if (diagramPlayer.diagram(letter)) {
      // paint the dark card background UNDER the drawing (fillStyle set
      // here — the drawing itself leaves its own last fill colour behind)
      cx.fillStyle = "#0b1220";
      cx.globalCompositeOperation = "destination-over";
      cx.fillRect(0, 0, diagramCanvas.width, diagramCanvas.height);
      cx.globalCompositeOperation = "source-over";
      url = diagramCanvas.toDataURL("image/png");
    }
  } catch {}
  if (url) diagramCache.set(letter, url);
  return url;
}
let rewarded = false;
let motionRewardAt = 0; // when a J/Z stroke last completed — re-arms so you can repeat it
let guideAmt = 0; // 0..1 eased "how much correction guide to show"
const GUIDE_MIN_REVEAL = 0.4; // guide strength the moment a hand is scored (Stage 7c)
let motionChargeAmt = 0; // eased J/Z charge-tone input — see the charge() call below
let handVote = 0; // when the on-camera hand started disagreeing with trackedHand (ms, 0 = agrees)
const HAND_FLIP_MS = 1000; // Stage 7d: that long before the reference auto-flips
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
let lastSpellText = null; // syncSpellText(): last text/pending rendered
let lastSpellPending = null;
const DECODE_BLANK = { letter: "", conf: 0 }; // see the fluid decode call
let spellLastCommitAt = 0;
let handSeenSince = 0; // when the current continuous hand sighting began
let lastHandSeenAt = 0;
const HAND_ENTRY_MS = 400;
let spellMaxAway = 0; // Spell: farthest (hand-spans) the wrist got from the last letter while NOT holding // Spell: when the last letter landed (gates J/Z strokes)
let lastHold = null; // setHold(): last --hold value written
let lastMeterKey = null; // updateMeter(): last score|bucket shown
let missStreak = 0;
let lastGoodHand = null; // raw landmarks, held briefly through a momentary detection miss
let overlayGrace = 0;
let detCount = 0;
let detStamp = performance.now();
let fps = 0;

// ---- recognition + practice (loaded lazily; may be absent) --------

let classifier = null;
let stabilizer = null;
let reference = null;
let refPlayer = null; // animates the canonical shape in the panel
let demoZoomPlayer = null; // the enlarged demo
let challenge = null; // the speed game
let azRun = false; // practice: walk a bounded queue (A->Z or Review), auto-advancing on each completion
let runKind = null; // "az" | "review" | null (mirrors which queue azRun is walking)
let runQueue = ALL_LETTERS; // the queue azRun walks — ALL_LETTERS for A->Z, a picked subset for Review
let azAdvancing = false; // guards the "next: X" bridge
// the pending "Next: X" bridge (advanceAz / skipLetter). Cancelled when the run
// ends — leaving the run or switching mode within the 0.7-1.3 s bridge used
// to still call setTarget(next) in the new mode (lab issue LAB-054).
let azBridgeTimer = 0;
const azDone = new Set();
const azSkipped = new Set(); // letters skipped (not completed) in the current run
let azTimes = []; // {letter, ms} per completion in the current run
const REVIEW_SIZE = 10; // a review session is a defined length, not open-ended grinding

// Spaced-repetition-ish priority: never-practiced letters first, HARD_LETTERS
// weighted up (the recogniser is weaker on them, so they need more reps),
// recently-SKIPPED letters weighted up too (a skip is a stronger "this one's
// giving you trouble" signal than just not having practiced it — turns
// frustration into curriculum data instead of just a dead end), then
// whichever you haven't touched in the longest. Lower score = reviewed sooner.
function reviewPriority(L) {
  const s = statsMap[L];
  const done = s?.done || 0;
  const hardBonus = HARD_LETTERS.has(L) ? 2 : 0;
  const skipBonus = Math.min(s?.skipped || 0, 3) * 1.5; // capped — don't let one letter dominate forever
  const daysSince = s?.last ? (Date.now() - s.last) / 86400000 : 999; // never seen -> very stale
  return done - hardBonus - skipBonus - Math.min(daysSince, 10) * 0.3;
}
function buildReviewQueue(n) {
  return [...ALL_LETTERS].sort((a, b) => reviewPriority(a) - reviewPriority(b)).slice(0, n);
}
let firstHandAt = 0; // when a hand first appeared for the current target
let stuckSince = 0; // when the current (uncompleted) attempt began
let stuckShown = false;
let mode = "practice"; // "practice" | "challenge" | "spell"
let pendingChallengeStart = false; // start the game as soon as the camera is up
let speller = null; // spell mode: continuous fingerspelling -> transcript
let spellStab = null; // its own (faster) stabilizer so held letters commit sooner
let spellAnchor = null; // wrist position at the last commit — for "moved" re-arm
let spellClipboard = ""; // last text "grabbed" in spell mode (for the paste gesture)
let spellWrist = []; // short wrist-position history — a "hand is still" gate
let spellSuppressUntil = 0; // block letter commits briefly after a gesture
let fluidMode = loadPref("fluid") === "1"; // spell: transition.js letters + decode + speak
let fluidLastLetterAt = 0; // for auto-speak-on-pause
let fluidSpoke = false; // already spoke this pause?
let drill = null; // spell mode: "spell this word" practice targets
let drillMode = loadPref("drill") === "1";
let drillSrc = loadPref("drill-src") === "starter" ? "starter" : "course";
let challengeWords = []; // Challenge word rounds, from practice-words.json
let drillStarter = []; // fallback word pool (short + common) when no course tier
let drillHitAt = 0; // debounce the success -> next-word advance
let reader = null; // read mode: receptive practice
let course = null; // read mode: teaching-order lessons with progress gating
let readStyle = loadPref("read-style") === "course" ? "course" : "free";
let readPlayer = null; // animates the word being spelled
let readTimers = []; // per-letter playback timeouts
let lastPred = null;
let refiner = null; // learned M/N and D/O/C clean-up heads (optional)
let handshape = null; // js/handshape.js judge — the letter's defining traits
let targetLetter = null;

// load the refinement heads in the background — the app works without them
loadRefiner(new URL("heads.json", import.meta.url).href)
  .then((r) => {
    refiner = r;
    if (r) console.info(`refinement heads on (covers ${r.covers.join("")})`);
  })
  .catch(() => {});

// read mode's word bank (independent of the dataset) — also feeds the
// spell-mode drill's starter pool. Retriable + visible on failure (S3):
// this used to fail silently and leave Read mode stuck on "loading word
// list…" forever with no way to know why or recover without a page reload.
function loadWordBank() {
  fetch(new URL("../data/practice-words.json", import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .then((bank) => {
      if (!bank) throw new Error("empty response");
      reader = createReader(bank, { confusion: loadedConfusion });
      if (rdSpeed) rdSpeed.value = loadPref("read-speed") || rdSpeed.value;
      buildReadCats();
      if (mode === "read") applyReadStyle(); // restored straight into read mode

      // spell-mode drill: a short+common starter pool; the course tier is the
      // other source (wired in refillDrill once curriculum.json lands)
      drillStarter = [...(bank.short || []), ...(bank.common || [])];
      // Challenge word rounds: familiar everyday words (it filters to 3-5
      // letters without doubles itself)
      challengeWords = [...(bank.short || []), ...(bank.common || []), ...(bank.food || []), ...(bank.animals || [])];
      challenge?.setWords(challengeWords);
      drill = createSpellDrill(drillStarter);
      if (spDrillSrc) spDrillSrc.value = drillSrc;
      if (mode === "spell") applyDrill();
      wordBankFailed = false;
      if (mode === "read") refreshReadLoadError();
    })
    .catch(() => {
      wordBankFailed = true;
      if (mode === "read") refreshReadLoadError();
    });
}
loadWordBank();

// read mode's course spine: letter tiers unlocked in a teaching order
function loadCurriculum() {
  fetch(new URL("../data/curriculum.json", import.meta.url))
    .then((r) => (r.ok ? r.json() : null))
    .then((json) => {
      if (!json) throw new Error("empty response");
      course = createCourse(json, loadJSON("course", null));
      buildReadPath();
      renderLesson();
      if (mode === "read" && readStyle === "course") applyReadStyle();
      if (mode === "spell" && drillMode && drillSrc === "course") {
        refillDrill();
        nextDrillWord();
      }
      curriculumFailed = false;
      if (mode === "read") refreshReadLoadError();
    })
    .catch(() => {
      curriculumFailed = true;
      if (mode === "read") refreshReadLoadError();
    });
}
loadCurriculum();

// fluid mode's lexicon decoder + measured confusion matrix, in the
// background; fluid mode falls back to the raw transcript until it's ready,
// so a failure here is a lesser degradation than the two above — still
// surfaced (S3) rather than silently missing forever.
function loadDecoderAssets() {
  Promise.all([
    fetch(new URL("../data/words25k.txt", import.meta.url)).then((r) => (r.ok ? r.text() : null)),
    fetch(new URL("../data/confusion.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ])
    .then(([txt, conf]) => {
      if (!txt) throw new Error("word list failed");
      loadedConfusion = conf ? mergeConfusion(conf) : null;
      decoder = createDecoder(buildLexicon(txt), { confusion: loadedConfusion || undefined });
      // reader.js's near-miss diff (S3) needs this too — it's a separate,
      // smaller fetch (data/confusion.json alone) that often resolves before
      // this Promise.all (words25k.txt is much bigger), so `reader` may
      // already exist by the time we get here; setConfusion() updates it in
      // place instead of the data silently never reaching it.
      reader?.setConfusion(loadedConfusion);
      console.info(`fluid-mode decoder ready${conf ? " (measured confusion blended)" : ""}`);
      decoderFailed = false;
      if (mode === "spell") refreshSpellLoadError();
    })
    .catch(() => {
      decoderFailed = true;
      if (mode === "spell") refreshSpellLoadError();
    });
}
loadDecoderAssets();

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
    // the letter's defining traits, calibrated from real (un-rotated) samples
    handshape = createHandshapeJudge(train.filter((s) => s.rot == null));
    refPlayer = createCanonicalPlayer(refCanvas);
    diagramPlayer = createCanonicalPlayer(diagramCanvas);
    demoZoomPlayer = createCanonicalPlayer(demoZoomCanvas);
    readPlayer = createCanonicalPlayer(rdCanvas);
    challenge = createChallenge({ letters: ALL_LETTERS, words: challengeWords, difficulty: chDifficulty, pauseGapMs: PAUSE_GAP_MS }); // incl. J/Z
    renderChBests();
    speller = createSpeller();
    // 10 frames (~1/3 s at 30 fps) at >=4-of-5 kNN votes. Was 6 frames at
    // 3-of-5: a look-alike flicker (A<->S, M<->N) only had to win ~0.2 s to
    // commit a letter the signer never made.
    // 16 frames (~0.53 s at 30 fps; was 10 ≈ 0.33 s — a learner moving
    // slowly between letters held the in-between shape that long)
    spellStab = createStabilizer({ stableFrames: 16, minConfidence: 0.8 });
    buildLetterPicker(ALL_LETTERS);
    learnRow.hidden = false;
    modeToggle.hidden = false;

    // restore last session's setup
    const savedHand = loadPref("hand");
    if (savedHand === "right" || savedHand === "left") {
      handOverride = savedHand;
      trackedHand = savedHand;
      for (const b of handPick.querySelectorAll("button"))
        b.classList.toggle("on", b.dataset.hand === savedHand);
      applyHand();
    }
    if (loadPref("mode") === "challenge") setMode("challenge");
    else if (loadPref("mode") === "spell") setMode("spell");
    else if (loadPref("mode") === "read") setMode("read");
    else {
      const savedLetter = loadPref("letter");
      if (savedLetter && ALL_LETTERS.includes(savedLetter)) setTarget(savedLetter);
    }

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
    b.className =
      "chip" + (HARD_LETTERS.has(L) ? " hard" : "") + (MOTION.has(L) ? " motion" : "");
    b.textContent = L;
    b.title = MOTION.has(L)
      ? `${L} — a motion letter (trace it)`
      : HARD_LETTERS.has(L)
      ? `${L} — trickier for the recogniser`
      : L;
    b.addEventListener("click", () => setTarget(targetLetter === L ? null : L));
    letterPicker.appendChild(b);
  }
}

function updateLetterStat() {
  const s = targetLetter && statsMap[targetLetter];
  letterStat.textContent = s?.done
    ? `done ${s.done}× · best ${(s.bestMs / 1000).toFixed(1)}s`
    : "";
}

// Everything that carries "how the LAST letter was going" — reset whenever the
// target changes so it can't leak into the next one (2026-09-24 live QA:
// the A->Z run didn't reset the guide between letters; the old letter's
// confirmed recognition, full-strength guide, hold and tone all carried over).
function resetPracticeFeedback(nextLetter) {
  releaseFrom = targetLetterBefore;
  needRelease = !!(nextLetter && targetLetterBefore && nextLetter !== targetLetterBefore);
  armedAt = performance.now() + (nextLetter ? RELEASE_SETTLE_MS : 0);
  holdStart = 0;
  lastGoodAt = 0;
  rewarded = false;
  azAdvancePending = false;
  guideAmt = 0;
  motionChargeAmt = 0;
  lastPred = null;
  stabilizer?.reset();
  sound.chargeStop();
  bg.setMatch(null);
  setHold("0");
}
// while a reward is waiting to advance the run, the letter stays "done" —
// dropping and re-making the sign mustn't fire a second reward (that used to
// double-count stats and could skip the NEXT letter)
const rewardLatched = () => azAdvancePending || azAdvancing;

function setTarget(letter) {
  targetLetterBefore = targetLetter;
  targetLetter = letter;
  for (const b of letterPicker.children) b.classList.toggle("on", b.textContent === letter);
  clearTargetBtn.hidden = !letter;
  prevLetterBtn.hidden = !letter;
  nextLetterBtn.hidden = !letter;
  refPanel.hidden = !letter || blindToggle.checked;
  if (letter && !blindToggle.checked) openRefSheet();
  ghostToggleWrap.hidden = !letter;
  workspace.dataset.target = letter ? "on" : "off";
  // collapse the letter grid to a compact strip once one's chosen
  learnRow.classList.toggle("compact", !!letter);
  learnCurrent.textContent = letter || "";

  resetPracticeFeedback(letter);
  motionRewardAt = 0;
  firstHandAt = 0;
  stuckSince = 0;
  stuckShown = false;
  motion.reset();
  refPanel.classList.remove("nudge");
  viewport.classList.toggle("is-motion", MOTION.has(letter));
  setHold("0");
  applyHand(); // motion letters never mirror the panel — keep the Z demo readable
  reco.hidden = true;
  if (letter) {
    refLetter.textContent = letter;
    // photo always on when learning — except J/Z, where a still photo is one
    // ambiguous frame of a motion: show the traced-path diagram instead
    refImg.src = (MOTION.has(letter) && strokeDiagramURL(letter)) || REFERENCE_IMG(letter);
    if (refDesc) refDesc.textContent = reference?.describe(letter) || "";
    updateLetterStat();
    if (!azRun && mode === "practice") savePref("letter", letter);
    // the panel was just un-hidden — wait one frame so its real width exists
    // before we size the canvas to it, otherwise the diagram can draw blank.
    requestAnimationFrame(() => {
      sizeRefCanvas();
      if (MOTION.has(letter)) refPlayer?.setMotion(letter);
      else refPlayer?.setTarget(reference?.centroid(letter) || null);
    });
    if (mode !== "challenge") sound.select(); // Challenge has its own roundStart()
  } else {
    if (refDesc) refDesc.textContent = "";
    letterStat.textContent = "";
    refPlayer?.setTarget(null);
    updateMeter(0, null);
    bg.setMatch(null);
  }
  refHint.textContent = "";
}

// ---- bounded runs: A -> Z (all 26, in order) or Review (a spaced-repetition
// subset), both auto-advancing on each completion and ending at a defined
// finish line instead of open-ended free-pick grinding ------------------

function setAzRun(on, kind = "az") {
  if (!reference) return;
  azRun = on;
  runKind = on ? kind : null;
  runQueue = kind === "review" ? buildReviewQueue(REVIEW_SIZE) : ALL_LETTERS;
  clearTimeout(azBridgeTimer);
  azBridgeTimer = 0;
  azAdvancing = false;
  azNext.hidden = true;
  learnRow.dataset.run = on ? "on" : "off";
  azProgress.hidden = !on;
  azSkip.hidden = !on; // free-pick has nothing to skip past
  blindToggleWrap.hidden = !on; // free-pick is meant to teach — no blind option there
  if (!on) blindToggle.checked = false; // don't leave free-pick accidentally blind
  for (const b of subMode.children)
    b.classList.toggle("on", on ? b.dataset.sub === kind : b.dataset.sub === "free");
  for (const b of letterPicker.children) b.classList.remove("done");
  if (on) {
    azDone.clear();
    azSkipped.clear();
    azTimes = [];
    updateAzProgress();
    setTarget(runQueue[0]);
  } else {
    setTarget(null);
  }
}

function updateAzProgress() {
  azProgress.textContent = `${azDone.size} / ${runQueue.length}`;
}

function advanceAz() {
  if (!azRun || !reference || azAdvancing) return;
  azAdvancing = true;
  const done = targetLetter;
  azDone.add(done);
  if (firstHandAt) azTimes.push({ letter: done, ms: performance.now() - firstHandAt });
  for (const b of letterPicker.children) {
    if (b.textContent === done) b.classList.add("done");
  }
  updateAzProgress();
  const next = runQueue.find((L) => !azDone.has(L));
  if (next) {
    azNext.innerHTML = `Next&nbsp; <b>${next}</b>`;
    azNext.hidden = false;
    azBridgeTimer = setTimeout(() => {
      azBridgeTimer = 0;
      azNext.hidden = true;
      azAdvancing = false;
      setTarget(next);
    }, 1300);
  } else {
    showRunCard();
  }
}

// Skip the current letter without completing it — was impossible before:
// the only way out of a hard stop (M/N/D commonly) was abandoning the whole
// run. Marks it visited (so the run still ends) but with no time entry (so
// it doesn't pollute "Fastest"/"Took a while"), and bumps a persisted
// `skipped` counter that reviewPriority() reads — a skip is real curriculum
// data, not just a letter you happened not to practice.
function skipLetter() {
  if (!azRun || !reference || azAdvancing || !targetLetter) return;
  azAdvancing = true;
  practiceRun = 0; // a skip breaks the in-a-row run
  setGlow(0);
  const skipped = targetLetter;
  azDone.add(skipped);
  azSkipped.add(skipped);
  const s = (statsMap[skipped] ||= { done: 0, bestMs: Infinity });
  s.skipped = (s.skipped || 0) + 1;
  saveJSON("stats", statsMap);
  for (const b of letterPicker.children) {
    if (b.textContent === skipped) b.classList.add("done");
  }
  updateAzProgress();
  const next = runQueue.find((L) => !azDone.has(L));
  if (next) {
    azNext.innerHTML = `Next&nbsp; <b>${next}</b>`;
    azNext.hidden = false;
    azBridgeTimer = setTimeout(() => {
      azBridgeTimer = 0;
      azNext.hidden = true;
      azAdvancing = false;
      setTarget(next);
    }, 700); // shorter than advanceAz's reward bridge — nothing to celebrate
  } else {
    showRunCard();
  }
}
azSkip.addEventListener("click", skipLetter);

function showRunCard() {
  const times = [...azTimes].sort((a, b) => a.ms - b.ms);
  const fmt = (t) => `${t.letter} ${(t.ms / 1000).toFixed(1)}s`;
  const fast = times.slice(0, 3).map(fmt).join(" · ") || "—";
  const tricky = times.filter((t) => t.ms > 8000).map((t) => t.letter);
  const isReview = runKind === "review";
  if (runCardTitle) runCardTitle.textContent = isReview ? "Review complete! 🎉" : "Alphabet complete! 🎉";
  runCardBody.innerHTML =
    (isReview ? `You reviewed ${azDone.size} letters.<br>` : `You signed all ${azDone.size} letters.<br>`) +
    `<br><b>Fastest:</b> ${fast}` +
    (tricky.length ? `<br><b>Took a while:</b> ${tricky.join(" ")}` : "") +
    (azSkipped.size ? `<br><b>Skipped:</b> ${[...azSkipped].join(" ")}` : "");
  runCard.hidden = false;
  fx.flash("#22c55e");
  sound.runComplete();
  buzz([0, 40, 30, 60, 30, 90]);
  // finale: confetti rain + the letter chips light up in a wave + a big label
  // (reduced motion: no rain/wave movement — a still highlight + label, CSS)
  fx.rain();
  fx.moment(isReview ? "Review done! 🎉" : "A → Z! 🎉", { ...elCenter(viewport), tone: "finale", ms: 1800 });
  [...letterPicker.children].forEach((b, i) => b.style.setProperty("--i", String(i)));
  letterPicker.classList.remove("finale");
  void letterPicker.offsetWidth;
  letterPicker.classList.add("finale");
  setTimeout(() => letterPicker.classList.remove("finale"), 2400);
}
runCardClose.addEventListener("click", () => {
  runCard.hidden = true;
  setAzRun(false);
});

// Selfie (front) view: it's a mirror of the reference photo, so a RIGHT hand
// needs the reference flipped to match. Back camera: the view is un-mirrored,
// so it's the LEFT hand that needs the flip. J/Z are the exception — the panel
// plays a *motion* demo, and a mirrored Z reads as a backwards Z, so those
// always show the plain canonical stroke regardless of which hand is tracked.
// Read mode shows someone ELSE spelling to you, so it stays in the viewer's
// view (the letter centroids' own frame). The J/Z motion demos are authored
// in the signer's (selfie) view, so flip just those segments — otherwise the
// hand jumped sides at every J/Z mid-word.
function setReadMotionView(on) {
  rdCanvas.style.transform = on ? "scaleX(-1)" : "";
}
// back the Read canvas with real device pixels (it was a fixed 320px square,
// visibly softer than Practice's demo)
function sizeReadCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.max(160, Math.round((rdCanvas.clientWidth || 320) * dpr));
  if (rdCanvas.width !== size) {
    rdCanvas.width = size;
    rdCanvas.height = size;
    readPlayer?.redraw();
  }
}
window.addEventListener("resize", sizeReadCanvas);

function applyHand() {
  const flipForHand = facingMode === "user" ? "right" : "left";
  const motionLetter = MOTION.has(targetLetter);
  refPanel.classList.toggle("mirror", trackedHand === flipForHand && !motionLetter);
  // Stage 7d: a clear chip instead of a tiny "· right hand" suffix
  if (refHand) {
    const selfie = facingMode === "user";
    refHand.hidden = !trackedHand;
    refHand.textContent = trackedHand ? `Your ${trackedHand} hand${selfie ? " · mirrored" : ""}` : "";
    refHand.title = selfie
      ? "The camera is a mirror, like a selfie. The pictures are flipped to match."
      : "Back camera: you see the hand the way other people do.";
  }
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

// --hold lives on the viewport (CSS reads it inside); writing it every frame
// invalidates style for the whole camera area, so skip unchanged values.
function setHold(v) {
  if (v === lastHold) return;
  lastHold = v;
  viewport.style.setProperty("--hold", v);
}

function updateMeter(score, bucket) {
  // runs every frame in Practice — only write when what's shown changes
  // directional label only when the on-camera guide (and its ▲) is showing
  const guideOn =
    ghostToggle.checked && !blindToggle.checked && !!targetLetter && !MOTION.has(targetLetter);
  const key = Math.round(score * 100) + "|" + bucket + "|" + guideOn;
  if (key === lastMeterKey) return;
  lastMeterKey = key;
  meterFill.style.width = `${Math.round(score * 100)}%`;
  meterFill.style.background = BUCKET_COLOR[bucket] || "#475569";
  meterFill.classList.toggle("correct", bucket === "correct");
  meterLabel.textContent = bucket
    ? (guideOn ? BUCKET_LABEL : BUCKET_LABEL_PLAIN)[bucket]
    : "show your hand";
  meterLabel.style.color = BUCKET_COLOR[bucket] || "#94a3b8";
  meterLabel.classList.toggle("correct", bucket === "correct");
  viewport.dataset.match = bucket || "none";
}

// ---- read mode (receptive practice) -------------------------

function buildReadCats() {
  if (!reader || !rdCats) return;
  rdCats.setAttribute("role", "group");
  rdCats.setAttribute("aria-label", "Word categories");
  rdCats.innerHTML = "";
  for (const c of reader.categories) {
    const on = reader.activeCategories.includes(c);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rd-cat" + (on ? " on" : "");
    b.textContent = c;
    b.dataset.cat = c;
    b.setAttribute("aria-pressed", String(on));
    rdCats.appendChild(b);
  }
}

// --- course: teaching-order lessons -------------------------

function buildReadPath() {
  if (!course || !rdPath) return;
  rdPath.innerHTML = "";
  for (const t of course.view()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className =
      "rd-step" +
      (t.active ? " active" : "") +
      (t.locked ? " locked" : "") +
      (!t.locked && t.done >= t.need ? " done" : "");
    b.dataset.step = String(t.index);
    b.disabled = t.locked;
    const mark = t.locked ? "🔒" : t.done >= t.need ? "✓" : `${t.done}/${t.need}`;
    b.innerHTML = `${t.name} <span class="tick" aria-hidden="true">${mark}</span>`;
    b.setAttribute(
      "aria-label",
      t.locked
        ? `${t.name} — locked`
        : `${t.name}${t.active ? ", current lesson" : ""} — ${t.done} of ${t.need} correct`
    );
    b.setAttribute("aria-pressed", String(t.active));
    rdPath.appendChild(b);
  }
}

function renderLesson() {
  if (!course) return;
  const t = course.tier;
  if (!t) return;
  if (rdLessonName) rdLessonName.textContent = `${t.name}  ·  ${t.letters.split("").join(" ")}`;
  if (rdLessonBlurb) rdLessonBlurb.textContent = t.blurb || "";
  const p = course.progress();
  if (rdLessonProg) {
    rdLessonProg.textContent = course.complete ? "course complete 🎉" : `${p.done} / ${p.need}`;
  }
  if (rdBar) rdBar.style.width = `${Math.round(p.ratio * 100)}%`;
}

function applyReadStyle() {
  refreshReadLoadError();
  if (!reader) return;
  savePref("read-style", readStyle); // remember intent even if the course JSON is still loading
  const onCourse = readStyle === "course" && !!course;
  if (rdModes) {
    for (const b of rdModes.children) {
      const on = b.dataset.rmode === readStyle;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  if (rdCourse) rdCourse.hidden = !onCourse;
  if (rdCats) rdCats.hidden = onCourse;
  if (onCourse) {
    buildReadPath();
    renderLesson();
  }
  nextReadWord();
}

// S3 transport — pause/step/scrub, live-synced to the player's own clock
// while playing. Scoped to the common case (see playWord): a word with no
// J/Z, played as one setWord run with a single clean timeline.
let rdTransportRaf = 0;
function stopTransportSync() {
  cancelAnimationFrame(rdTransportRaf);
  rdTransportRaf = 0;
}
function syncSeekBar() {
  if (!readPlayer) return;
  const info = readPlayer.wordInfo();
  if (!info) { stopTransportSync(); return; }
  rdSeek.value = String(Math.round(readPlayer.elapsedMs()));
  rdTransportRaf = requestAnimationFrame(syncSeekBar);
}
function updatePauseButton() {
  const p = !!readPlayer?.isPaused();
  rdPause.innerHTML = `<span aria-hidden="true">${p ? "▶" : "⏸"}</span>`;
  rdPause.setAttribute("aria-label", p ? "play" : "pause");
  rdPause.title = p ? "play" : "pause";
}
function enableTransport() {
  const info = readPlayer.wordInfo();
  if (!info) return;
  rdPause.hidden = false;
  rdStepBack.hidden = false;
  rdStepFwd.hidden = false;
  rdSeek.hidden = false;
  rdSeek.max = String(Math.round(info.totalMs));
  rdSeek.value = "0";
  rdTicks.innerHTML = info.letterStarts.map((ms) => `<option value="${Math.round(ms)}"></option>`).join("");
  updatePauseButton();
  stopTransportSync();
  rdTransportRaf = requestAnimationFrame(syncSeekBar);
}
function disableTransport() {
  rdPause.hidden = true;
  rdStepBack.hidden = true;
  rdStepFwd.hidden = true;
  rdSeek.hidden = true;
  stopTransportSync();
}
function currentLetterIndex(starts, elapsed) {
  let idx = 0;
  for (let k = 0; k < starts.length; k++) if (starts[k] <= elapsed + 0.5) idx = k;
  return idx;
}
function stepReadLetter(dir) {
  const info = readPlayer?.wordInfo();
  if (!info) return;
  readPlayer.pause();
  const starts = info.letterStarts;
  const idx = currentLetterIndex(starts, readPlayer.elapsedMs());
  const target = Math.max(0, Math.min(starts.length - 1, idx + dir));
  readPlayer.seek(starts[target]);
  rdSeek.value = String(Math.round(readPlayer.elapsedMs()));
  stopTransportSync();
  updatePauseButton();
}
function togglePause() {
  if (!readPlayer) return;
  if (readPlayer.isPaused()) {
    readPlayer.resume();
    stopTransportSync();
    rdTransportRaf = requestAnimationFrame(syncSeekBar);
  } else {
    readPlayer.pause();
    stopTransportSync();
  }
  updatePauseButton();
}

function playWord(word) {
  sizeReadCanvas(); // the panel is laid out by now — match its real size
  readTimers.forEach(clearTimeout);
  readTimers = [];
  stopTransportSync();
  if (!readPlayer || !word) return;
  const speed = Number(rdSpeed.value) || 900;
  const letters = word.toUpperCase().split("");
  rdLen.textContent = "· ".repeat(letters.length).trim();
  readPlayer.setTarget(null);

  const hasMotion = letters.some((L) => MOTION.has(L));
  if (!hasMotion) {
    // S3 transport (pause/step ± letter/scrub) needs one continuous clock
    // to act on, so the common case — no J/Z — plays as a SINGLE setWord
    // run instead of S2e's per-run setTimeout ladder below.
    const items = letters.map((L) => ({ letter: L, vec: reference?.centroid(L) }));
    readTimers.push(
      setTimeout(() => {
        setReadMotionView(false);
        readPlayer.setWord(items, { holdMs: speed });
        enableTransport();
      }, 250)
    );
    return;
  }

  // A word containing J/Z has no single clean timeline to scrub — a stroke
  // is a self-contained animation, not a bone-space pose the transport
  // clock can seek into — so it falls back to Replay-only, same as before
  // S3. An explicit scope boundary (checked against real word lists in
  // S2e), not a silent gap.
  disableTransport();

  // S2e: chain consecutive STATIC letters through one coarticulated setWord
  // run (no neutral detour between them, distance-scaled transitions) rather
  // than retriggering setTarget per letter. J/Z have no single target shape
  // to chain through in bone space, so they still use setMotion on their own
  // per-letter timer and split the word into separate runs around them.
  let i = 0;
  while (i < letters.length) {
    if (MOTION.has(letters[i])) {
      const L = letters[i];
      readTimers.push(setTimeout(() => { setReadMotionView(true); readPlayer.setMotion(L); }, 250 + i * speed));
      i++;
      continue;
    }
    const runStart = i;
    const run = [];
    while (i < letters.length && !MOTION.has(letters[i])) {
      run.push({ letter: letters[i], vec: reference?.centroid(letters[i]) });
      i++;
    }
    readTimers.push(
      setTimeout(() => { setReadMotionView(false); readPlayer.setWord(run, { holdMs: speed }); }, 250 + runStart * speed)
    );
  }

  readTimers.push(
    setTimeout(() => readPlayer.setTarget(null), 250 + letters.length * speed + 500)
  );
}

function nextReadWord() {
  if (!reader) return;
  const w =
    readStyle === "course" && course ? reader.next(course.words()) : reader.next();
  rdInput.value = "";
  rdInput.disabled = false;
  rdFeedback.textContent = "";
  rdFeedback.className = "rd-feedback";
  rdNext.hidden = true;
  rdScore.textContent = String(reader.score) + (reader.streak >= 2 ? `  🔥${reader.streak}` : "");
  playWord(w);
  rdInput.focus();
}

function enterRead() {
  if (!reader) {
    refreshReadLoadError();
    if (!wordBankFailed) rdFeedback.textContent = "loading word list…";
    return;
  }
  applyReadStyle();
}
function leaveRead() {
  readTimers.forEach(clearTimeout);
  readTimers = [];
  stopTransportSync();
  readPlayer?.setTarget(null);
}

// A wrong guess on a fingerspelling test is usually one letter mistaken for
// a look-alike — the diff + confusable note say exactly which, instead of
// just "wrong" (S3 near-miss feedback). Builds DOM nodes directly (not
// innerHTML-with-user-text) since `guess` is untrusted user input.
function renderDiff(container, diff, answerStr, guessStr) {
  const line = document.createElement("span");
  line.className = "rd-diff";
  for (let i = 0; i < answerStr.length; i++) {
    const bad = diff.some((d) => d.i === i);
    const span = document.createElement("span");
    if (bad) span.className = "bad-ltr";
    span.textContent = answerStr[i];
    line.appendChild(span);
  }
  container.appendChild(line);
  if (guessStr) {
    const you = document.createElement("span");
    you.textContent = ` — you wrote “${guessStr}”`;
    container.appendChild(you);
  }
}

function renderConfusable(container, c) {
  const note = document.createElement("span");
  note.className = "rd-confusable";
  note.textContent = `${c.expected.toUpperCase()} and ${c.got.toUpperCase()} are easy to mix up.`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "show me those two";
  btn.addEventListener("click", () => renderCompare(c.expected.toUpperCase(), c.got.toUpperCase()));
  note.appendChild(btn);
  container.appendChild(note);
}

// Inline side-by-side of the two confused letters' reference photo + how-to
// text, right under the feedback — "show me those two side by side" (S3).
function renderCompare(a, b) {
  const old = rdFeedback.querySelector(".rd-compare");
  old?.remove();
  const box = document.createElement("div");
  box.className = "rd-compare";
  for (const L of [a, b]) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = REFERENCE_IMG(L);
    img.alt = `reference hand shape for ${L}`;
    const cap = document.createElement("figcaption");
    cap.textContent = L;
    const p = document.createElement("p");
    p.textContent = LETTER_GUIDE[L] || "";
    fig.appendChild(img);
    fig.appendChild(cap);
    fig.appendChild(p);
    box.appendChild(fig);
  }
  rdFeedback.appendChild(box);
}

function judgeRead(revealed) {
  if (!reader || !reader.current) return;
  const answer = reader.current;
  const guess = rdInput.value;
  const result = revealed ? { ok: false, diff: [], confusables: [] } : reader.check(guess);
  const ok = result.ok;
  rdInput.disabled = true;
  rdScore.textContent = String(reader.score) + (reader.streak >= 2 ? `  🔥${reader.streak}` : "");
  let promo = null;
  if (readStyle === "course" && course) {
    promo = course.record(ok);
    saveJSON("course", course.state());
    buildReadPath();
    renderLesson();
  }
  rdFeedback.textContent = "";
  if (ok) {
    rdFeedback.textContent = promo && promo.unlocked
      ? `✓ correct — 🔓 new lesson: ${promo.tierName}`
      : "✓ correct";
    rdFeedback.className = "rd-feedback good";
    buzz(promo && promo.unlocked ? 40 : 20);
    sound.correct?.(reader.streak);
    // visual twin: a ring on the answer that grows with the streak, and a
    // label every 5 in a row
    const at = elCenter(rdFeedback);
    fx.ring(at.x, at.y, { color: "#4ade80", rings: Math.min(3, 1 + Math.floor(reader.streak / 3)), radius: 44 });
    if (reader.streak >= 5 && reader.streak % 5 === 0) fx.moment(`🔥 ${reader.streak} in a row`, { ...at, tone: "mastery" });
    setTimeout(nextReadWord, promo && promo.unlocked ? 1400 : 850);
  } else {
    rdFeedback.className = "rd-feedback bad";
    if (revealed) {
      rdFeedback.textContent = `it was “${answer}”`;
    } else {
      renderDiff(rdFeedback, result.diff, answer, guess.trim().toLowerCase());
      buzz(60);
      sound.wrong?.();
      // only the single strongest confusable — piling on every mismatched
      // pair reads as noise, not help
      const top = result.confusables.slice().sort((x, y) => y.weight - x.weight)[0];
      if (top) renderConfusable(rdFeedback, top);
    }
    // S3: wrong answers persist until dismissed instead of vanishing in
    // 1.6s — a learner needs time to actually read the diff / confusable
    // note, not just glimpse it before the next word replaces it.
    rdNext.hidden = false;
  }
}

// ---- challenge mode -------------------------------------------

function setMode(next) {
  if (!challenge || next === mode) return;
  mode = next;
  savePref("mode", mode);
  tracker?.setNumHands(mode === "spell" ? 2 : 1);
  // live QA: "when switching modes the audio gets bugged and loud ... stuck".
  // Only Practice feeds the hold tone, so leaving it mid-hold froze the
  // voice at its last pitch forever.
  sound.chargeStop();
  setGlow(0); // a combo/run glow belongs to the mode that earned it
  cfx.reset(); // so do the Challenge aura / aurora ramp / Race split
  practiceRun = 0;
  stabilizer?.reset(); // a letter confirmed in one mode must not carry into the next
  viewport.dataset.mode = mode; // CSS hides the camera curtain in challenge
  for (const b of modeToggle.children) {
    const on = b.dataset.mode === mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  if (azRun) setAzRun(false); // exit an A->Z run when leaving practice
  setTarget(null); // drop any practice target
  challenge.stop();
  versus?.stop(); // two-player game too — never leak its HUD / 2-hand tracking
  versus = null;
  delete viewport.dataset.turn;
  clearChallengeHud();
  // a Start click in Challenge that's still waiting on the camera (denied,
  // still prompting, etc.) leaves this armed; without clearing it here, a
  // camera that comes up later in a DIFFERENT mode auto-starts Challenge's
  // HUD/timer on top of whatever mode the user is actually in.
  pendingChallengeStart = false;
  learnRow.hidden = mode !== "practice";
  ghostToggleWrap.hidden = true;
  spellPanel.hidden = mode !== "spell";
  readPanel.hidden = mode !== "read";
  viewport.hidden = mode === "read"; // read mode has no camera
  if (mode === "read") enterRead();
  else leaveRead();
  if (mode === "spell") {
    spellStab?.reset(); // don't commit a letter left latched from before
    swipe.reset();
    twohand.reset();
    transition.reset();
    spellWrist = [];
    spellAnchor = null;
    spDecodedRow.hidden = !fluidMode;
    if (spDecodedText) spDecodedText.textContent = "…";
    syncSpellText();
    applyDrill(); // show / refresh the word-drill row if it's on
    refreshSpellLoadError();
  }
  if (mode === "challenge") {
    chCardTitle.textContent = "Challenge";
    chCardSub.textContent = state === "tracking" || state === "searching"
      ? CH_INTRO
      : "Turn on the camera, then Start.";
    chSummary.hidden = true;
    chDiff.hidden = false;
    renderChBests();
    chCard.hidden = false;
  }
}

function clearChallengeHud() {
  delete viewport.dataset.turn; // Take turns shade
  timeBar.hidden = true;
  timeBar.classList.remove("low");
  scoreBadge.hidden = true;
  chStreak.hidden = true;
  chLives.hidden = true;
  chGain.hidden = true;
  chSeeing.hidden = true;
  chSkip.hidden = true;
  chBanner.hidden = true;
  chCombo.hidden = true;
  vsHud.hidden = true;
  delete viewport.dataset.play;
  setGlow(0);
  chCard.hidden = true;
  refPanel.hidden = !targetLetter;
  if (targetLetter) openRefSheet();
}

function startVersus() {
  // J/Z are traced strokes (one hand's motion) — two-player rounds use the
  // 24 static letters (+ short words later in the game)
  versus = createVersus({
    pauseGapMs: PAUSE_GAP_MS, // a hidden tab doesn't cost the round
    letters: LETTERS.filter((L) => !MOTION.has(L)),
    words: challengeWords,
    mode: chPlay,
    difficulty: chDifficulty,
  });
  vsStab.forEach((st) => st.reset());
  // both modes track two hands: Race reads both, Take turns reads only the
  // current player's side (so the other player can't sign for them)
  tracker?.setNumHands(2);
  viewport.dataset.play = chPlay;
  vsProgressSeen = [0, 0];
  chCard.hidden = true;
  chSummary.hidden = true;
  scoreBadge.hidden = true;
  timeBar.hidden = false;
  vsHud.hidden = false;
  versus.start(performance.now());
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
  if (chPlay !== "solo") return startVersus();
  versus = null;
  delete viewport.dataset.turn;
  chCard.hidden = true;
  scoreBadge.hidden = false;
  scoreVal.textContent = "0";
  chStreak.hidden = true;
  timeBar.hidden = false;
  chSummary.hidden = true;
  chCombo.hidden = true;
  chCombo.textContent = "";
  setGlow(0);
  challenge.start(performance.now(), chDifficulty);
}

// ---- Challenge v2 card: difficulty picker + per-difficulty bests ----
const CH_INTRO =
  "A letter flashes up — sign it before the timer runs out. Land them in a row " +
  "for a combo multiplier. Later rounds bring look-alike letters and short words.";
let chDifficulty = loadPref("ch-diff") === "hard" ? "hard" : "normal";

// ---- two-player Challenge + leaderboard (owner request 2026-09-25) ----
// chPlay: "solo" (today's game) | "turns" (players alternate rounds, one
// camera) | "race" (both on camera at once, left half = Player 1 blue, right
// half = Player 2 orange; first to sign it wins the round). The engine is
// js/versus.js; the board is js/leaderboard.js (kept on this device).
let chPlay = ["turns", "race"].includes(loadPref("ch-play")) ? loadPref("ch-play") : "solo";
let versus = null;
let heroTwoHands = false; // the landing screen asked the tracker for 2 hands
const vsStab = [0, 1].map(() => createStabilizer({ stableFrames: STABLE_FRAMES, minConfidence: MIN_CONFIDENCE }));
const leaderboard = createLeaderboard();
const PLAYER_COLORS = [{ stroke: "#38bdf8", joint: "#e0f2fe" }, { stroke: "#fb923c", joint: "#ffedd5" }];
const PLAYER_FLASH = ["#38bdf8", "#fb923c"];
const PLAYER_DIM = [{ stroke: "rgba(56, 189, 248, 0.4)", joint: "rgba(224, 242, 254, 0.4)" }, { stroke: "rgba(251, 146, 60, 0.4)", joint: "rgba(255, 237, 213, 0.4)" }];
const boardKey = () => (chPlay === "solo" ? `solo-${chDifficulty}` : chPlay);
const boardTitle = () =>
  chPlay === "solo" ? `Solo · ${chDifficulty === "hard" ? "Hard" : "Normal"}` : chPlay === "race" ? "Race (winners)" : "Take turns (winners)";
const CH_PLAY_INTRO = {
  solo: CH_INTRO,
  turns: "Two players, one camera — take turns. Each letter is one player's; the other watches. 3 lives each; highest score wins.",
  race: "Two players side by side — left half is Player 1 (blue), right half is Player 2 (orange). You both sign the same letter: first to land it wins the round. Hold a wrong shape and you're locked out for a moment. First to 7 rounds wins.",
};
function renderChPlay() {
  for (const b of chPlayGroup.querySelectorAll("button")) {
    const on = b.dataset.play === chPlay;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  if (!pendingChallengeStart && (state === "tracking" || state === "searching")) chCardSub.textContent = CH_PLAY_INTRO[chPlay];
}
function renderBoard(highlight = -1) {
  const rows = leaderboard.top(boardKey());
  chBoard.innerHTML =
    `<h4>${boardTitle()}</h4>` +
    (rows.length
      ? `<ol>${rows.map((r, i) => `<li class="${i === highlight ? "me" : ""}"><b>${escapeHtml(r.name)}</b><span>${r.score}${r.round ? ` · rd ${r.round}` : ""}</span></li>`).join("")}</ol>`
      : `<p class="empty">No scores yet — be the first.</p>`);
}
// after a run: if the score places, ask for initials and save it
function offerLeaderboard(board, score, round, streak, label = "") {
  if (!leaderboard.qualifies(board, score)) return;
  const wrap = document.createElement("div");
  wrap.className = "ch-initials";
  wrap.innerHTML = `<span>${label || "New high score!"} Initials:</span><input maxlength="3" aria-label="Your initials" autocomplete="off" spellcheck="false"><button type="button">Save</button>`;
  const input = wrap.querySelector("input"), btn = wrap.querySelector("button");
  const saveIt = () => {
    const rank = leaderboard.add(board, { name: input.value, score, round, streak, date: new Date().toISOString().slice(0, 10) });
    wrap.innerHTML = rank ? `<span>Saved — #${rank} on the board 🏆</span>` : "";
    chBoard.hidden = false;
    chBoardBtn.setAttribute("aria-expanded", "true");
    renderBoard(rank - 1);
  };
  btn.addEventListener("click", saveIt);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") saveIt(); e.stopPropagation(); });
  chSummary.appendChild(wrap);
  chSummary.hidden = false;
  setTimeout(() => input.focus(), 50);
}
function renderChDiff() {
  for (const b of chDiff.querySelectorAll("button")) {
    const on = b.dataset.diff === chDifficulty;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
}
function renderChBests() {
  if (!challenge) return (chBests.textContent = "");
  const st = challenge.savedStats(chDifficulty);
  chBests.textContent = st.best
    ? `${chDifficulty === "hard" ? "Hard" : "Normal"} best: ${st.best} pts · longest combo ${st.bestStreak || 0} · round ${st.bestRound || 0}`
    : "";
}
chDiff.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-diff]");
  if (!b) return;
  chDifficulty = b.dataset.diff;
  savePref("ch-diff", chDifficulty);
  renderChDiff();
  renderChBests();
  if (!chBoard.hidden) renderBoard();
});
renderChDiff();
chPlayGroup.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-play]");
  if (!b) return;
  chPlay = b.dataset.play;
  savePref("ch-play", chPlay);
  renderChPlay();
  if (!chBoard.hidden) renderBoard();
});
chBoardBtn.addEventListener("click", () => {
  chBoard.hidden = !chBoard.hidden;
  chBoardBtn.setAttribute("aria-expanded", String(!chBoard.hidden));
  if (!chBoard.hidden) renderBoard();
});
renderChPlay();

let lastTickAt = 0;

// react to the game snapshot each frame. Every sound here has a visual twin
// (banner / flash / chip) — sound is never the only signal (Deaf-first).
let lastDrainAt = 0;
const bannerFor = (snap) => {
  // word rounds: landed letters lit, the next one underlined; the letter
  // just landed pops and drops an ember (CSS) for ~600 ms
  if (!snap.target || snap.target.length < 2) return escapeHtml(snap.target || "");
  const popping = performance.now() - partHitAt < 600;
  return [...snap.target]
    .map((c, i) => `<span class="${i < snap.progress ? "done" : i === snap.progress ? "next" : ""}${popping && i === snap.progress - 1 ? " pop" : ""}">${c}</span>`)
    .join("");
};
function renderChallenge(snap, near) {
  if (!snap) return;
  if (snap.partHit) partHitAt = performance.now();
  cfx.update(snap);
  timeBar.style.setProperty("--time", snap.remainingFrac.toFixed(3));
  timeBar.classList.toggle("low", !!snap.low);
  timeBar.classList.toggle("drain", !!snap.draining);

  if (snap.low && performance.now() - lastTickAt > 430) {
    lastTickAt = performance.now();
    sound.tick();
  }

  chLives.hidden = false;
  chLives.textContent = "♥".repeat(snap.lives) + "♡".repeat(Math.max(0, START_LIVES - snap.lives));

  if (snap.event === "letter") {
    const isWord = snap.target.length > 1;
    // Normal previews a single letter's demo; Hard (and word rounds) show
    // only what to sign
    if (!isWord && snap.difficulty === "normal") {
      setTarget(snap.target); // shows the demo + description in the panel
      refPanel.hidden = false;
      workspace.dataset.target = "on";
      chBanner.hidden = true;
    } else {
      refPanel.hidden = true;
      workspace.dataset.target = "off";
      chBanner.className = `ch-banner study${isWord ? " word" : ""}`;
      setBannerHtml(bannerFor(snap));
      chBanner.hidden = false;
    }
    chSeeing.hidden = true;
    sound.roundStart();
  } else if (snap.event === "go") {
    refPanel.hidden = true;
    workspace.dataset.target = "off";
    chBanner.className = "ch-banner go";
    chBanner.textContent = "GO";
    chBanner.hidden = false;
    sound.go();
  } else if (snap.event === "play") {
    stabilizer?.reset(); // the letter must be formed FRESH during play
  } else if (snap.event === "win") {
    scoreVal.textContent = String(snap.score);
    scoreBadge.classList.remove("pop");
    void scoreBadge.offsetWidth;
    scoreBadge.classList.add("pop");
    chStreak.hidden = snap.streak < 2;
    chStreak.textContent = `🔥${snap.streak}`;
    chGain.textContent = snap.mult > 1 ? `+${snap.lastGain}  ×${snap.mult}` : `+${snap.lastGain}`;
    chGain.hidden = false;
    chGain.classList.remove("ch-gain");
    void chGain.offsetWidth;
    chGain.classList.add("ch-gain");
    chBanner.className = "ch-banner win";
    chBanner.textContent = "✓";
    chBanner.hidden = false;
    chSeeing.hidden = true;
    chSkip.hidden = true;
    chCombo.hidden = snap.mult < 2;
    chCombo.textContent = `×${snap.mult} combo`;
    if (snap.comboUp) {
      chCombo.classList.remove("up");
      void chCombo.offsetWidth;
      chCombo.classList.add("up");
      sound.comboUp(snap.mult);
    }
    fx.flash(snap.mult >= 3 ? "#fde047" : "#22c55e");
    handfx?.landed(fxHand);
    cfx.hit();
    // hit burst from the palm, bigger as the run heats up (governor-capped)
    const nb = burstCount(18, cfx.intensity, fxq.level);
    if (nb && fxHand) { const p = pagePoint(fxHand[9]); fx.burst(p.x, p.y, { count: nb }); }
    setGlow(glowLevel(snap.mult)); // the combo's visual twin, on the frame
    bg.pulse(0.35 + 0.15 * snap.mult);
    sound.hit(snap.mult);
    buzz([0, 30, 25, 55]);
  } else if (snap.event === "miss") {
    chBanner.className = "ch-banner miss";
    chBanner.textContent = "✕";
    chBanner.hidden = false;
    // no peeking during play — but after a miss, say what it read
    chSeeing.className = "ch-seeing";
    chSeeing.innerHTML = snap.missReadAs
      ? `so close — read as <b>${escapeHtml(snap.missReadAs)}</b>, not <b>${escapeHtml(snap.missedLetter)}</b>`
      : `time — it was <b>${escapeHtml(snap.missedLetter)}</b>`;
    chSeeing.hidden = false;
    chSkip.hidden = true;
    chStreak.hidden = true;
    chCombo.hidden = true;
    fx.flash("#f87171");
    setGlow(0);
    sound.lifeLost();
    buzz(90);
  } else if (snap.event === "over") {
    timeBar.hidden = true;
    timeBar.classList.remove("low", "drain");
    chBanner.hidden = true;
    chSeeing.hidden = true;
    chSkip.hidden = true;
    chCombo.hidden = true;
    refPanel.hidden = true;
    renderChallengeSummary(snap);
    chStart.textContent = "Play again";
    chCard.hidden = false;
    sound.charge(0);
    setGlow(0);
    cfx.reset();
    if (snap.newBest) {
      sound.newBest();
      fx.flash("#fde047");
      if (fxHand) inkbloom?.bloom(fxHand, "mastery"); // gold bloom (full quality only)
      fx.rain({ count: 90, colors: ["#fde047", "#facc15", "#f8fafc", "#22c55e"] });
      buzz([0, 40, 30, 60, 30, 120]);
    } else {
      sound.gameOver();
      buzz([0, 60, 40, 120]);
    }
  }

  if (snap.partHit) {
    sound.partHit(snap.progress);
    buzz(12);
  }

  if (snap.phase === "play") {
    refPanel.hidden = true;
    workspace.dataset.target = "off";
    chBanner.className = `ch-banner${snap.target.length > 1 ? " word" : ""}`;
    setBannerHtml(bannerFor(snap));
    chBanner.hidden = false;
    // live QA: "Challenge is too easy". The old live "seeing X" readout let
    // you cycle shapes until the model agreed — now play shows only whether
    // you're holding a WRONG shape (the clock drains), never which letter.
    chSeeing.className = `ch-seeing${snap.draining ? " drain" : ""}`;
    chSeeing.textContent = snap.draining ? "✕ not that shape — the clock is draining" : near ? "~ close…" : "";
    chSeeing.hidden = !snap.draining && !near;
    if (snap.draining && performance.now() - lastDrainAt > 400) {
      lastDrainAt = performance.now();
      sound.drain();
    }
    chSkip.hidden = false;
  } else if (snap.phase === "study" && snap.event !== "letter") {
    chSeeing.hidden = true;
    chSkip.hidden = true;
  }
}

let versusCurrent = 0; // whose turn it is (turns mode) — the skeleton colour follows it
const vsName = (p) => `Player ${p + 1}`;
function renderVersus(snap) {
  if (!snap) return;
  // a new turn starts clean: the last player's held letter can't carry over
  if (snap.current !== versusCurrent) vsStab[snap.current]?.reset();
  versusCurrent = snap.current;
  raceLockFrac = snap.players.map((P) => P.lockFrac || 0);
  const leader = snap.mode === "race" ? cfx.updateRace(snap) : -1;
  timeBar.style.setProperty("--time", snap.remainingFrac.toFixed(3));
  timeBar.classList.toggle("low", !!snap.low);
  const race = snap.mode === "race";
  const playing = snap.phase === "play" && !!snap.target;
  if (snap.event === "letter") vsProgressSeen = [0, 0];
  [vsP1, vsP2].forEach((el, p) => {
    const P = snap.players[p];
    const lives = "♥".repeat(Math.max(0, P.lives)) + "♡".repeat(Math.max(0, START_LIVES - P.lives));
    // each player's own progress on the target (owner: in Race word rounds
    // you couldn't tell who landed which letter, which letter registered, or
    // which one each of you was on): done letters ticked in the player's
    // colour, the one they're on boxed. Only for players who are playing.
    const mine = race || snap.current === p;
    const prog = snap.progress?.[p] ?? 0;
    const track = playing && mine
      ? `<span class="vs-word">${[...snap.target].map((c, i) => `<i class="${i < prog ? "done" : i === prog ? "now" : ""}">${c}</i>`).join("")}</span>`
      : "";
    const html = `${leader === p ? "★ " : ""}${vsName(p)} · ${P.score}${track}<small>${race ? `rounds ${P.wins}/7` : lives}${P.mult > 1 ? ` · ×${P.mult}` : ""}${P.locked ? " · locked" : ""}</small>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; } // no per-frame DOM churn
    // a letter just registered for this player: pop their panel + a small
    // burst on their hand in their colour, so it's clear WHO landed it
    if (playing && prog > vsProgressSeen[p] && prog < snap.target.length) {
      el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit");
      const wh = race ? raceHands[p] : fxHand;
      if (wh && fxq.level !== "off") { const q = pagePoint(wh[9]); fx.burst(q.x, q.y, { count: 10, colors: [PLAYER_FLASH[p]] }); }
      sound.hit?.(1);
    }
    vsProgressSeen[p] = prog;
    el.classList.toggle("active", !race && snap.phase !== "over" && snap.current === p);
    el.classList.toggle("idle", !race && snap.current !== p);
    el.classList.toggle("locked", !!P.locked);
  });
  const turnText = race ? `Round ${snap.round}` : snap.phase === "over" ? "" : `${vsName(snap.current)}'s turn — ${snap.current === 0 ? "left" : "right"} side${vsWaiting ? ` · ${vsName(1 - snap.current)}, wait` : ""}`;
  if (vsTurn.textContent !== turnText) vsTurn.textContent = turnText;
  // Take turns: shade the waiting player's half
  const turnSide = !race && snap.phase !== "over" ? String(snap.current) : "";
  if (viewport.dataset.turn !== turnSide) viewport.dataset.turn = turnSide;
  const word = snap.target && snap.target.length > 1;
  if (snap.event === "letter") {
    chBanner.className = `ch-banner study${word ? " word" : ""}`;
    chBanner.textContent = snap.target;
    chBanner.hidden = false;
    sound.roundStart();
  } else if (snap.event === "go") {
    chBanner.className = "ch-banner go";
    chBanner.textContent = "GO";
    sound.go();
  } else if (snap.event === "win") {
    const w = snap.roundWinner;
    chBanner.className = "ch-banner win";
    chBanner.textContent = race ? `${vsName(w)}!` : "✓";
    const el = w === 0 ? vsP1 : vsP2;
    el.classList.remove("won"); void el.offsetWidth; el.classList.add("won");
    fx.flash(PLAYER_FLASH[w]);
    // the round winner's palm bursts in their colour
    const wh = race ? raceHands[w] : fxHand;
    if (wh && fxq.level !== "off") { const p = pagePoint(wh[9]); fx.burst(p.x, p.y, { count: 24, colors: [PLAYER_FLASH[w], "#f8fafc"] }); }
    sound.hit(snap.players[w].mult);
    buzz([0, 30, 25, 55]);
  } else if (snap.event === "miss") {
    chBanner.className = "ch-banner miss";
    chBanner.textContent = race ? "Nobody — time!" : "✕";
    fx.flash("#f87171");
    sound.lifeLost();
  } else if (snap.event === "over") {
    timeBar.hidden = true;
    chBanner.hidden = true;
    const [a, b] = snap.players;
    const w = snap.gameWinner;
    chCardTitle.textContent = w < 0 ? "It's a tie!" : `${vsName(w)} wins!`;
    chCardSub.textContent = race
      ? `Rounds ${a.wins}–${b.wins} · points ${a.score}–${b.score}`
      : `Points ${a.score}–${b.score} · reached round ${snap.round}`;
    chSummary.innerHTML = "";
    chSummary.hidden = true;
    if (w >= 0) offerLeaderboard(snap.mode, snap.players[w].score, snap.round, 0, `${vsName(w)} makes the board!`);
    chStart.textContent = "Rematch";
    chCard.hidden = false;
    if (w >= 0) { fx.flash(PLAYER_FLASH[w]); sound.newBest(); } else sound.gameOver();
    cfx.reset();
    versus.stop();
    tracker?.setNumHands(1);
  }
  if (snap.phase === "play") {
    chBanner.className = `ch-banner${word ? " word" : ""}`;
    chBanner.innerHTML = word
      ? [...snap.target].map((c, i) => `<span class="${race ? "" : i < snap.progress[snap.current] ? "done" : i === snap.progress[snap.current] ? "next" : ""}">${c}</span>`).join("")
      : escapeHtml(snap.target || "");
    chBanner.hidden = false;
  }
}

function renderChallengeSummary(snap) {
  const sm = snap.summary;
  chCardTitle.textContent = snap.newBest ? "New personal best!" : "Run over";
  chCardSub.textContent = "";
  const pct = Math.round((sm?.accuracy || 0) * 100);
  const slow = (sm?.slowest || []).filter(Boolean);
  chSummary.innerHTML =
    (snap.newBest ? `<div class="newbest">★ NEW BEST ★</div>` : "") +
    `<div class="stats">` +
    `<div class="stat"><b>${sm?.score ?? snap.score}</b><span>score · best ${sm?.best ?? snap.best}</span></div>` +
    `<div class="stat"><b>×${Math.max(1, Math.min(4, sm?.bestStreak >= 10 ? 4 : sm?.bestStreak >= 6 ? 3 : sm?.bestStreak >= 3 ? 2 : 1))}</b><span>best combo · ${sm?.bestStreak ?? 0} in a row</span></div>` +
    `<div class="stat"><b>${pct}%</b><span>landed · round ${sm?.round ?? snap.round}</span></div>` +
    `</div>` +
    (slow.length
      ? `<div class="practice">Practice these: ${slow
          .map((t) => `<button type="button" data-practice="${escapeHtml(t[0])}">${escapeHtml(t)}</button>`)
          .join("")}</div>`
      : "");
  chSummary.hidden = false;
  renderChBests();
  offerLeaderboard(`solo-${sm?.difficulty || chDifficulty}`, sm?.score ?? snap.score, sm?.round ?? snap.round, sm?.bestStreak ?? 0);
}
chSummary.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-practice]");
  if (!b) return;
  setMode("practice");
  setTarget(b.dataset.practice);
});

function reward(originLandmark, handLm = null) {
  handfx?.landed(handLm || fxHand); // the hold arc hands off to an amber ring
  // per-letter stats: completions + best time from first-sighting to lock
  let tier = "letter";
  if (targetLetter) {
    const s = (statsMap[targetLetter] ||= { done: 0, bestMs: Infinity });
    const prevDone = s.done || 0;
    s.done++;
    tier = rewardTier(prevDone, s.done, MASTERY_DONE);
    s.last = Date.now(); // feeds the Review queue's "longest since practiced" ranking
    const ms = firstHandAt ? performance.now() - firstHandAt : Infinity;
    if (ms < s.bestMs) s.bestMs = ms;
    saveJSON("stats", statsMap);
    updateLetterStat();
    renderProgressCount();
    touchStreak();
  }
  // reps in a row climb the scale + grow the celebration (bounded)
  const now = performance.now();
  practiceRun = nextRun(practiceRun, practiceRunAt, now, RUN_WINDOW_MS);
  practiceRunAt = now;
  const plan = celebrationPlan(tier, practiceRun);
  buzz(tier === "letter" ? [0, 35, 25, 55] : [0, 35, 25, 55, 25, 80]);
  const { x, y } = pagePoint(originLandmark);
  const colors = tier === "mastery"
    ? ["#fde047", "#facc15", "#fef9c3", "#f8fafc", "#22c55e"]
    : tier === "first" ? ["#38bdf8", "#7dd3fc", "#22c55e", "#f8fafc", "#fde047"] : undefined;
  fx.burst(x, y, { count: plan.particles, stars: plan.stars, ...(colors ? { colors } : {}) });
  // B3: ink blooms out of the fingertips that made the sign (full quality),
  // and the big tiers assemble the glyph beside the hand
  const rh = handLm || fxHand;
  if (rh) {
    inkbloom?.bloom(rh, tier);
    if ((tier === "first" || tier === "mastery") && targetLetter) {
      const pts = rh.map(pagePoint);
      const box = {
        left: Math.min(...pts.map((p) => p.x)), right: Math.max(...pts.map((p) => p.x)),
        top: Math.min(...pts.map((p) => p.y)), bottom: Math.max(...pts.map((p) => p.y)),
      };
      glyphfx?.assemble(targetLetter, { from: [4, 8, 12, 16, 20].map((i) => pts[i]), box, tier });
    }
  }
  fx.ring(x, y, { color: plan.color, rings: plan.rings }); // "locked in" on the hand
  fx.flash(plan.color);
  bg.pulse(tier === "mastery" ? 1 : tier === "first" ? 0.75 : 0.45);
  sound.success({ step: practiceRun - 1, tier });
  setGlow(glowLevel(practiceRun - 1), RUN_WINDOW_MS); // runs of 3+ light the frame
  if (plan.moment && targetLetter) {
    fx.moment(tier === "mastery" ? `${targetLetter} mastered ★` : `First ${targetLetter}!`,
      { x, y: Math.max(40, y - 70), tone: plan.moment });
  }
  viewport.classList.add("celebrate");
  setTimeout(() => viewport.classList.remove("celebrate"), 650);
  letterBadge.classList.remove("pop");
  void letterBadge.offsetWidth; // restart the animation
  letterBadge.classList.add("pop");
  const runTag = practiceRun >= 3 ? `  · ${practiceRun} in a row` : "";
  showToast(
    tier === "mastery" ? `${targetLetter} mastered! ★ (${MASTERY_DONE}×)`
    : tier === "first" ? `First ${targetLetter}! ✨${runTag}`
    : `Nailed ${targetLetter}!  ✓${runTag}`
  );
  if (azRun) {
    // let the reward land, then move on — only if we're still on that letter
    azAdvancePending = true;
    const doneLetter = targetLetter;
    setTimeout(() => {
      azAdvancePending = false;
      if (targetLetter === doneLetter) advanceAz();
    }, 950);
  }
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
  const lbl = sound.muted ? "Unmute sound" : "Mute sound";
  muteBtn.setAttribute("aria-label", lbl);
  muteBtn.setAttribute("aria-pressed", String(sound.muted));
  muteBtn.title = lbl;
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
  controls.hidden = !live;
  startBtn.disabled = next === "requesting" || next === "loading";
  if (!live) {
    statsEl.hidden = true;
    letterBadge.hidden = true;
    pickHint.hidden = true;
    viewport.dataset.match = "none";
    holdStart = 0;
    rewarded = false;
    landmarkFilter.reset();
    guideAmt = 0;
    updateColorKey(false, null, 0);
    motionChargeAmt = 0;
    setHold("0");
    sound.charge(0);
    setGlow(0);
    bg.setMatch(null);
    if (challenge?.active || versus?.active) {
      challenge.stop();
      versus?.stop();
      clearChallengeHud();
    }
    // camera failed (denied, no device, etc.) while a Challenge Start click
    // was waiting on it — don't leave it armed, or a camera that succeeds
    // later in a different mode will silently auto-start Challenge's HUD.
    pendingChallengeStart = false;
  }
  // camera just came up while waiting to start a challenge
  if (mode === "challenge" && (next === "searching" || next === "tracking") && pendingChallengeStart) {
    pendingChallengeStart = false;
    startChallenge();
  } else if (
    live && mode === "challenge" && challenge && !challenge.active && !chCard.hidden &&
    !pendingChallengeStart // don't stomp "Starting camera..." while a Start click is in flight
  ) {
    chCardTitle.textContent = "Challenge";
    chCardSub.textContent = CH_INTRO;
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
    applyFacing();
    // the viewport is sized by the layout, not the camera — the video and the
    // overlay canvas both `object-fit: cover` it, so any box shape works.

    setState("loading");
    [tracker, overlay] = await Promise.all([createHandTracker(), createOverlay(canvas)]);
    handfx = createHandFx({ ctx: overlay.ctx, governor: fxq });
    inkbloom ||= createInkBloom({ stage: $("stage"), before: canvas, governor: fxq, debug: DEBUG });
    glyphfx ||= createGlyphFx({ governor: fxq });
    if (DEBUG) Object.assign(window.__fx, { inkbloom, glyphfx });
    tracker.setNumHands(mode === "spell" ? 2 : 1);
    await acquireWakeLock();
    await datasetPromise;
    if (DEV) {
      // tools/testHarness.js's one hook into the live app — see that file for
      // the full API. Getters (not plain values) for reference/classifier
      // since they're `let` bindings normally populated inside
      // datasetPromise.then(); by this point that's already resolved, but the
      // getters cost nothing and protect against a future reordering.
      window.__aslDev = {
        tracker, overlay, video, canvas, sound,
        get reference() { return reference; },
        get classifier() { return classifier; },
        get versus() { return versus; }, // two-player QA (tools/fx-drive.js)
      };
    }
    stabilizer?.reset();
    if (targetLetter) sizeRefCanvas();

    flipBtn.hidden = (await countCameras()) < 2;
    missStreak = LOST_HAND_FRAMES;
    lastGoodHand = null;
    overlayGrace = 0;
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
  fxq.reportFps(null, false, performance.now());
  bg.setHand({ present: false });
  fxDebug?.setFps(null);
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
    "Then pick a letter and copy the hand shape. " +
    "Everything stays on your device. Nothing is recorded or uploaded.";
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
    applyFacing();
  } catch (err) {
    console.error(err);
    fail(err);
  } finally {
    flipBtn.disabled = false;
  }
}

// The front camera is a selfie (mirror the display); the back camera shows the
// world as-is (don't). That reversal also flips the mirror relationship the
// handedness + reference-flip logic depends on — see the loop and applyHand().
function applyFacing() {
  viewport.dataset.facing = facingMode;
  applyHand();
}

// ---- per-frame loop --------------------------------------------

// Adaptive (one-euro) smoothing over the 21 landmarks — see js/onefilter.js.
// Replaces a fixed-alpha EMA: heavy smoothing while the hand is nearly
// still (kills tracker jitter), much lighter while it's actually moving
// (kills the visible lag/"ghosting" a constant-alpha filter has at speed).
const landmarkFilter = createLandmarkFilter({
  mincutoff: ONE_EURO_MIN_CUTOFF,
  beta: ONE_EURO_BETA,
  dcutoff: ONE_EURO_DCUTOFF,
});
// t in SECONDS (one-euro's cutoffs are frequencies in Hz); `now` elsewhere in
// this file is performance.now() in ms. Pass raw=null to reset (hand lost).
function smoothLandmarks(raw, nowMs) {
  return landmarkFilter.filter(raw, nowMs / 1000);
}

// ---- two-player Race: per-hand players + classification ----
// Each detected hand belongs to a player by its ON-SCREEN side (the front
// camera view is mirrored): left half = Player 1, right half = Player 2. Two
// hands on the same side -> the left-most is Player 1.
function racePlayers(landmarks) {
  const sx = (lm) => (facingMode === "user" ? 1 - lm[0].x : lm[0].x);
  const idx = landmarks.map((lm, i) => i).sort((a, b) => sx(landmarks[a]) - sx(landmarks[b]));
  const owner = new Array(landmarks.length).fill(-1);
  if (idx.length === 1) owner[idx[0]] = sx(landmarks[idx[0]]) < 0.5 ? 0 : 1;
  else if (idx.length >= 2) { owner[idx[0]] = 0; owner[idx[1]] = 1; }
  return owner;
}
// one hand -> the recogniser's letter, exactly as the solo path does it
// (either-hand kNN, non-letter shapes rejected, learned heads)
function classifyHand(lm, mpLabel) {
  if (!classifier || !lm || lm.length < 21 || !lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const v = normalizeLandmarks(lm, { aspect: aspectOf(video), mirrorX: MIRROR_LEFT_HAND && mpLabel === "Left", extended: USE_EXTENDED_FEATURES });
  const either = classifyEitherHand(classifier, v, mirrorVector);
  const pred = either.pred;
  if (!pred || pred.distance > REJECT_DIST) return null;
  if (refiner) pred.label = refiner.refine(either.vec, pred.label);
  return pred;
}

function loop() {
  if (!tracker) return;
  rafId = requestAnimationFrame(loop);

  const now = performance.now();
  // throttle to TARGET_FPS. A strict `now - last < interval` misfires on a
  // 60 Hz display: two frames are ~33.3 ms +/- jitter, so about half the time
  // it waits a third frame (50 ms) and detection averages ~22-24/s instead of
  // 30. Allow a few ms of early slack and advance on a fixed schedule
  // (re-syncing after a long gap) so the rate holds at TARGET_FPS.
  const sinceDetect = now - lastDetectAt;
  if (sinceDetect < DETECT_INTERVAL - 4) return;
  lastDetectAt = sinceDetect > DETECT_INTERVAL * 2 ? now : lastDetectAt + DETECT_INTERVAL;
  if (video.readyState < 2) return;

  overlay.resizeToVideo(video);
  const result = tracker.detect(video, now);
  overlay.clear();

  // A single non-finite coordinate (rare, but MediaPipe can emit one on a
  // degenerate frame) would poison the one-euro filter's state until the hand
  // is lost and read as a confident wrong letter (QA 2026-09-23: NaN -> kNN
  // "A" at 0.8). Treat such a frame as no hand.
  const hasHandRaw =
    result.landmarks?.length > 0 &&
    result.landmarks[0].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
  const hasHand = hasHandRaw;
  // Landing screen open (e.g. "Try it with your hand"): the camera only
  // stirs the hero's ink. Nothing behind it is graded, rewarded, voiced or
  // saved — the fx canvas sits under the hero, so a reward sound there would
  // have no visible twin (Deaf-first). Any half-done hold is dropped so the
  // first frame after Start can't cash it in; Challenge's clock pauses across
  // the gap on its own (pauseGapMs).
  if (!hero?.isOpen() && heroTwoHands) {
    // hero closed: back to the mode's own hand count
    heroTwoHands = false;
    tracker?.setNumHands(mode === "spell" || (mode === "challenge" && versus?.active && versus.mode === "race") ? 2 : 1);
  }
  if (hero?.isOpen()) {
    // two hands while the hero is open: one paints orange, the other blue
    if (!heroTwoHands) { heroTwoHands = true; tracker?.setNumHands(2); }
    const handsOk = (result.landmarks || []).filter((lm) => lm.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
    hero.feedHands(handsOk.length ? handsOk : null, facingMode === "user", video, result.handedness);
    bg.setHand({ present: false });
    sound.charge(0);
    if (holdStart) { holdStart = 0; setHold("0"); }
    handSeenSince = 0;
    tickDetStats(now);
    return;
  }
  // Spell: the first ~0.4s after a hand appears is the hand arriving, not a
  // letter — raising a hand used to commit whatever shape it came up in.
  // After ~0.3s with no hand, forget the latched letter so the same shape
  // coming back isn't a phantom repeat.
  if (hasHand && !handSeenSince) handSeenSince = now;
  if (!hasHand && handSeenSince && now - lastHandSeenAt > 300) {
    handSeenSince = 0;
    spellStab?.reset();
  }
  if (hasHand) lastHandSeenAt = now;
  const handEntering = hasHand && now - handSeenSince < HAND_ENTRY_MS;
  const mpLabel = hasHand ? result.handedness?.[0]?.[0]?.categoryName : null;
  // MediaPipe classifies handedness from the raw pixels — it doesn't know which
  // camera produced them — and its label was validated against the real hand on
  // the front camera, so we read it the SAME way for both cameras. The back
  // camera only differs in *display*: the stage isn't CSS-mirrored (see the
  // [data-facing] rule), applyHand() flips the reference for the other hand, and
  // reward() places the burst without the selfie flip. Nothing here inverts.
  const rawLeft = mpLabel === "Left";
  const isLeftHand = rawLeft;
  const left = isLeftHand; // drives the classification mirror (mirrorX)
  const realHand = mpLabel ? (isLeftHand ? "left" : "right") : null;
  const motionTarget = MOTION.has(targetLetter); // J / Z — traced, no shape match
  // guide is a practice-mode thing only — and not for the motion letters.
  // "Test blind" (bounded runs only) suppresses it regardless of ghostToggle.
  const guiding =
    mode === "practice" &&
    reference &&
    targetLetter &&
    !motionTarget &&
    ghostToggle.checked &&
    !blindToggle.checked;

  // which hand is signing — follows whatever's on camera in near real time, so
  // you can swap hands mid-session (A→Z run, practice, challenge) and the
  // reference re-orients. Stage 7d: it must disagree for HAND_FLIP_MS straight
  // (was 3 frames, ~0.1 s) — a single misread burst mid-sign used to flip the
  // reference photo back and forth, which read as the app glitching.
  if (hasHand && handOverride === "auto" && realHand) {
    if (realHand === trackedHand) {
      handVote = 0;
    } else if (!handVote) {
      handVote = now;
    } else if (now - handVote >= HAND_FLIP_MS) {
      trackedHand = realHand;
      handVote = 0;
      applyHand();
    }
  }

  // smooth the raw landmarks (EMA) — kills the frame-to-frame jitter that makes
  // the skeleton look stringy, and steadies the meter. Reset on a lost hand so
  // it doesn't lerp across a re-acquire.
  const hand = smoothLandmarks(hasHand ? result.landmarks[0] : null, now);
  // background presence/stillness cue (presentation only): mean landmark
  // speed in frame-widths per second, from the smoothed landmarks
  {
    let speed = 0;
    if (hand && fxPrevHand && now > fxPrevAt) {
      let sum = 0;
      for (let i = 0; i < 21; i++) sum += Math.hypot(hand[i].x - fxPrevHand[i].x, hand[i].y - fxPrevHand[i].y);
      speed = sum / 21 / ((now - fxPrevAt) / 1000);
    }
    // span: wrist -> middle knuckle, in frame heights (framing distance)
    const span = hand ? Math.hypot(hand[9].x - hand[0].x, (hand[9].y - hand[0].y)) : 0;
    bg.setHand({ present: !!hand, speed, span });
    fxPrevHand = hand ? hand.map((p) => ({ x: p.x, y: p.y })) : null;
    fxPrevAt = now;
  }

  // J/Z motion buffer — fed the SMOOTHED landmarks so idle jitter doesn't
  // accumulate into a fake "stroke"
  // aspect: landmark x/y are fractions of width/height; motion.js measures
  // paths in true proportions so sideways and vertical travel are comparable
  motion.push(hand, now, video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 1);
  const stroke = motion.match(now); // "J" | "Z" | null (fires once per stroke)
  // spell-mode gestures use RAW landmarks — EMA smoothing damps exactly the
  // fast motion a swipe is made of
  swipe.push(hasHand ? result.landmarks[0] : null, now); // open-hand sideways sweep = delete
  twohand.push(result.landmarks, now); // two-hand copy / paste

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
    // either way round: a wrong MediaPipe handedness call mirrors the vector
    // (see classifyEitherHand) — the heads then see the winning orientation
    const either = hasHand && vec ? classifyEitherHand(classifier, vec, mirrorVector) : null;
    lastPred = either?.pred ?? null;
    // too far from ANY real letter (a relaxed / rising / in-between hand) ->
    // no prediction at all, rather than its nearest letter (see REJECT_DIST)
    if (lastPred && lastPred.distance > REJECT_DIST) lastPred = null;
    // learned heads clean up kNN's M↔N / D↔O↔C mixups (no-op if unavailable)
    if (lastPred && refiner) {
      const refined = refiner.refine(either.vec, lastPred.label);
      if (refined !== lastPred.label) { lastPred.label = refined; lastPred.refined = true; }
    }
    stabilizer.push(hasHand ? lastPred : null);
    if (spellStab) spellStab.push(mode === "spell" && hasHand && !handEntering ? lastPred : null);
  }

  // score the shape once — the guide's reveal ramp and the practice block need it
  // (motion letters J/Z have no static shape to score)
  const m = hasHand && vec && reference && targetLetter && !motionTarget
    ? reference.score(vec, targetLetter, { refiner }) // heads settle M/N + D/O/C look-alikes
    : null;
  // m.bucket === "correct" <=> the hand is READABLE by the shared per-joint
  // rule (js/jointstate.js): no joint badly off, at most a few slightly off.
  // The guide colours the hand with the same joint states and the reward
  // uses the same verdict, so what you see is what counts. (The old
  // "the recogniser reads it" upgrade is gone: it made the meter say correct
  // while joints were still drawn off.)
  // 2026-09-24 (owner: "match the accuracy of the LETTER rather than the
  // photo"): whether a sign counts is now decided by the letter's defining
  // traits (js/handshape.js — which fingers are up / folded, spread, thumb,
  // pointing direction), not by every joint's distance from the average
  // photo pose. Letters that share a finger pattern are split by the
  // recogniser: it must not be reading a DIFFERENT letter whose traits also
  // match (for the fist letters A E M N S T it's the only signal).
  if (m && handshape) {
    const v = judgeLetter(handshape, vec, targetLetter, lastPred?.label, m.tol);
    m.traits = v.traits;
    m.strict = v.strict;
    m.confusedWith = v.confusedWith;
    m.bucket = v.bucket;
    m.errors = v.errors; // colour each finger by ITS trait — the same verdict the reward uses
  } else if (m) {
    m.strict = m.bucket === "correct";
  }

  // progressive disclosure: the correction guide is on at a low floor as soon
  // as a hand is scored (Stage 7c — staying plain blue until score >= 0.35
  // read as "the guide is broken"), then strengthens as you get closer.
  const revealTarget = m
    ? GUIDE_MIN_REVEAL + (1 - GUIDE_MIN_REVEAL) * Math.max(0, Math.min(1, (m.score - 0.35) / 0.3))
    : 0;
  guideAmt += (revealTarget - guideAmt) * 0.12;

  let guideInfo = null; // { part } for the worst-off joint — named in the hint
  if (hasHand) {
    if (mode === "practice" && motionTarget && ghostToggle.checked && !blindToggle.checked) {
      // J / Z: show the swoosh to trace on the live hand
      overlay.drawMotionGuide(hand, targetLetter, { mirror: facingMode === "user" });
    } else if (guiding) {
      // the meter picks the best tilt + mirror fit; the guide must draw the
      // target in that same orientation or the arrows point where the wrist
      // can't go
      const o = vec ? reference.orient(vec, targetLetter) : { mirrored: false, deg: 0 };
      // reference.score() rotates the LIVE hand by +deg to meet the letter, so
      // the letter drawn in the live frame is rotated by -deg — unless the
      // target is also mirrored (M·R(-d) = R(d)·M). Passing +deg always drew
      // the ghost 2x the tilt off for an unmirrored fit (up to 44°): tips
      // showed "fix" while the meter said matched.
      const guideMirror = (MIRROR_LEFT_HAND && left) !== o.mirrored;
      guideInfo = overlay.drawGuide(hand, reference.centroid(targetLetter), {
        aspect: aspectOf(video),
        mirror: guideMirror,
        tol: reference.matchTolerance(targetLetter),
        align: guideMirror ? o.deg : -o.deg,
        errors: m?.errors, // colour with the scorer's own per-joint verdict
        reveal: guideAmt,
        settled: !!m?.strict, // don't nag once it really counts
        screenMirror: facingMode === "user", // the stage is CSS-mirrored for the front camera
      });
    } else if (mode === "challenge" && versus?.active && versus.mode === "race") {
      const owner = racePlayers(result.landmarks);
      raceHands = [null, null];
      owner.forEach((o, i) => { if (o >= 0) raceHands[o] = result.landmarks[i]; });
      // a locked-out player's skeleton dims to 0.4 (the badge arc counts down)
      overlay.drawHands(result.landmarks, { colors: owner.map((o) => (raceLockFrac[o] > 0 ? PLAYER_DIM[o] : PLAYER_COLORS[o]) || PLAYER_COLORS[0]) });
      // "1"/"2" wrist badges (shape + glyph, not just hue) + lockout countdown
      handfx?.drawRaceBadges(result.landmarks, owner, {
        locked: raceLockFrac, screenMirror: facingMode === "user", colors: PLAYER_FLASH,
      });
    } else if (mode === "challenge" && versus?.active && versus.mode === "turns") {
      // every hand in its owner's colour; the waiting player's is dimmed
      const owner = racePlayers(result.landmarks);
      overlay.drawHands(result.landmarks, { colors: owner.map((o) => (o === versusCurrent ? PLAYER_COLORS[o] : PLAYER_DIM[o]) || PLAYER_COLORS[0]) });
      handfx?.drawRaceBadges(result.landmarks, owner, { locked: [0, 0], screenMirror: facingMode === "user", colors: PLAYER_FLASH });
    } else if (mode === "spell" && result.landmarks?.length > 1) {
      overlay.drawHands(result.landmarks); // show both hands for the copy/paste gesture
    } else {
      overlay.drawHands([hand]);
    }
    missStreak = 0;
    if (state !== "tracking") setState("tracking");
    lastGoodHand = result.landmarks[0];
    overlayGrace = OVERLAY_GRACE_FRAMES;
  } else if (overlayGrace > 0 && lastGoodHand) {
    // bridge a momentary detection miss (e.g. fingers briefly occluding the
    // palm) so the skeleton doesn't visibly snap off for one frame and back
    // on the next — just the plain last-known pose, no guide/scoring, since
    // hasHand is genuinely false this frame (classification/motion/sound
    // above already correctly saw "no hand" — this is purely cosmetic).
    overlay.drawHands([lastGoodHand]);
    overlayGrace--;
    missStreak++;
    if (missStreak >= LOST_HAND_FRAMES && state !== "searching") setState("searching");
  } else {
    missStreak++;
    if (missStreak >= LOST_HAND_FRAMES && state !== "searching") setState("searching");
  }

  // on-camera colour key (Stage 7c) + the tour's live legend
  const guideStats = hasHand && guiding ? overlay.guideStats() : null;

  // on-hand feedback (presentation only): the hold arc + upward-only verdict
  // ripple + tip beads in Practice (Challenge stays "no peeking"); animations
  // already running (landed ring) finish in every mode
  fxHand = hasHand ? hand : null;
  if (handfx) {
    const practiceShape = mode === "practice" && !!targetLetter && !motionTarget && hasHand;
    const hf0 = DEBUG ? performance.now() : 0;
    handfx.draw(practiceShape ? hand : null, {
      hold: practiceShape ? Number(lastHold) || 0 : 0,
      bucket: practiceShape ? m?.bucket : null,
      tipStates: guideStats?.tips || null,
      now,
    });
    if (DEBUG) fxq.cost("handfx", performance.now() - hf0);
  }
  // framing: too near / too far is the #1 cause of bad landmarks
  {
    const f = hasHand ? framing.update(handSpanH(hand, aspectOf(video)), now) : framing.state;
    const show = hasHand && f !== "good" ? f : "";
    if (framingCue.dataset.state !== show) {
      framingCue.dataset.state = show;
      framingCue.hidden = !show;
      framingCue.textContent = show === "near" ? "↙ Move back a little" : show === "far" ? "↗ Come a little closer" : "";
    }
  }
  updateColorKey(guiding, guideStats, now);

  // recognition -> corner badge (hidden during the challenge — no peeking)
  if (classifier) {
    const shown =
      mode === "practice" ? stabilizer.current
      : mode === "spell" ? spellStab?.current
      : null;
    letterBadge.hidden = !shown;
    if (shown) letterBadge.textContent = shown;
  }

  // spell mode: continuous fingerspelling -> a running transcript
  if (mode === "spell" && speller && spellStab) {
    bg.setMatch(null);

    // open-hand sideways wipe -> throw away the half-formed word (or, if there
    // isn't one, delete the last finished character)
    if (swipe.match(now) === "delete" && (speller.clearPending() || speller.backspace())) {
      syncSpellText();
      spellStab.reset(); // the moving hand mustn't then register as a letter
      transition.reset();
      spellAnchor = null;
      spellSuppressUntil = now + 500;
      buzz([0, 25, 45, 25]);
      fx.flash("rgba(248, 113, 113, 0.4)");
    }

    // two open hands together -> copy;  pulled apart -> paste it back
    const two = twohand.match(now);
    if (two === "copy") {
      doSpellCopy();
      spellStab.reset();
      transition.reset();
      spellSuppressUntil = now + 600; // open hands settling after a gesture aren't a letter
    } else if (two === "paste" && spellClipboard && speller.insert(spellClipboard)) {
      syncSpellText();
      spellStab.reset();
      transition.reset();
      spellSuppressUntil = now + 600;
      buzz([0, 12, 22, 12, 22]);
      fx.flash("rgba(56, 189, 248, 0.5)");
    }

    // FLUID MODE — letters come from js/transition.js (settle-after-move) instead
    // of the "held still N frames" stabiliser path
    if (fluidMode) {
      transition.push(hand, handEntering || now < spellSuppressUntil ? null : lastPred, now);
      const e = transition.read();
      if (e && now >= spellSuppressUntil) {
        const added = speller.addLetter(e.letter, e.conf, now);
        if (added === "full") {
          showToast("Line full — Clear or Copy");
        } else {
          fluidLastLetterAt = now; // for auto-speak-on-pause
          fluidSpoke = false;
          sound.lock?.(Math.max(0, (speller.pending?.length || 1) - 1)); // climbs through the word
          if (hand) { const p = pagePoint(hand[9]); fx.ring(p.x, p.y, { color: "#38bdf8", radius: 46 }); }
          buzz(8);
        }
      }
    }

    // "hand is still" gate — a held letter barely moves; a hand mid-transition
    // or mid-swipe moves a lot and used to register a string of junk letters
    spellWrist.push({ t: now, x: hand?.[0]?.x ?? 0, y: hand?.[0]?.y ?? 0, has: hasHand });
    while (spellWrist.length && now - spellWrist[0].t > 200) spellWrist.shift();
    // unknown speed (too few frames, or a frame without a hand in the window)
    // counts as MOVING — it used to default to 0 = still
    let handSpeed = Infinity;
    if (hasHand && hand && spellWrist.length >= 3 && spellWrist.every((f) => f.has)) {
      const a = spellWrist[0], b = spellWrist.at(-1);
      const w = hand[0];
      let mx = 0, my = 0;
      for (const j of [5, 9, 13, 17]) { mx += hand[j].x; my += hand[j].y; }
      const span = Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
      handSpeed = Math.hypot(b.x - a.x, b.y - a.y) / span; // hand-spans moved in ~0.2 s
    }
    const still = handSpeed < 0.3 && now >= spellSuppressUntil && !handEntering;

    const cand = spellStab.candidate;
    const cur = spellStab.current;
    // in fluid mode the stabiliser never drives a commit — transition.js does
    const holding = !fluidMode && still && spellStab.progress >= 1 && !!cand && cand === cur;

    // a notable wrist shift since the last commit lets a deliberate bounce
    // re-arm a doubled letter (LL, SS) without waiting for the full pause
    // Measured in hand-spans (like handSpeed above), not raw frame units —
    // 0.14 of the frame was a small nudge for a hand far from the camera and
    // a large move up close, so drift re-armed repeats for some signers.
    // A re-arm needs a real bounce AWAY from the letter: only distance
    // covered while NOT holding counts, and the anchor follows the hand while
    // it holds — slow drift during a long hold used to add up to 0.8 spans
    // and re-commit the same letter.
    if (hasHand && hand && spellAnchor) {
      let mx = 0, my = 0;
      for (const j of [5, 9, 13, 17]) { mx += hand[j].x; my += hand[j].y; }
      const span = Math.hypot(mx / 4 - hand[0].x, my / 4 - hand[0].y) || 1e-6;
      if (holding) spellAnchor = { x: hand[0].x, y: hand[0].y };
      else spellMaxAway = Math.max(spellMaxAway, Math.hypot(hand[0].x - spellAnchor.x, hand[0].y - spellAnchor.y) / span);
    }
    const moved = spellMaxAway > 0.8;

    // J/Z motion letters bypassed every Spell gate (stillness, the post-swipe
    // suppression window) and re-armed repeats — moving between handshapes
    // could land a stray J/Z about once a second. Only accept a stroke outside
    // the suppression window and not right on the heels of another commit.
    // (A stroke right after its own start shape — J after a held I — is
    // exempt: speller.feed() swaps that letter for the stroke.)
    const spellStroke =
      stroke && now >= spellSuppressUntil &&
      (now - spellLastCommitAt > 700 || speller.last === STROKE_START[stroke])
        ? stroke : null;

    const res = speller.feed({
      holding,
      letter: cur,
      stroke: spellStroke,
      handPresent: hasHand,
      moved,
      now,
    });

    if (res.event === "letter") {
      spellLastCommitAt = now;
      spellMaxAway = 0;
      spellAnchor = hasHand && hand ? { x: hand[0].x, y: hand[0].y } : null;
      sound.lock?.(Math.max(0, (speller.pending?.length || 1) - 1)); // climbs through the word
      if (hasHand && hand) { const p = pagePoint(hand[9]); fx.ring(p.x, p.y, { color: "#38bdf8", radius: 46 }); }
      buzz(10);
    } else if (res.event === "word") {
      sound.word?.(); // its own quiet cue — success() is the big reward sound
      buzz([0, 18, 30, 18]);
      fx.flash("rgba(56, 189, 248, 0.4)");
    } else if (res.event === "full") {
      showToast("Line full — Clear or Copy");
    }

    syncSpellText();
    const building = !fluidMode && cand && /^[A-Z]$/.test(cand) ? cand : "";
    spPending.textContent = fluidMode
      ? (transition.metrics().held || "–")
      : building || "–";
    spRing.style.setProperty(
      "--p",
      building ? spellStab.progress.toFixed(2) : "0"
    );

    // word drill: match what's been spelled so far against the target word
    if (drillMode && drill && drill.target && !spDrillRow.hidden) {
      const committed = speller.text.trim().split(/\s+/).pop() || "";
      const attempt = speller.pending || committed;
      const solved = spDrillWord.classList.contains("solved");
      if (!solved) paintDrill(attempt);
      if (!solved && drill.match(attempt).ok && now - drillHitAt > 900) {
        drillHitAt = now;
        drill.submit(attempt);
        spDrillWord.classList.add("solved");
        spDrillWord.querySelectorAll(".ltr").forEach((s) => s.classList.remove("miss"));
        renderDrillScoreOnly();
        sound.success?.({ mode: "drill", step: Math.max(0, (drill.streak || 1) - 1) });
        buzz([0, 20, 40, 20]);
        fx.flash("rgba(74, 222, 128, 0.38)");
        const dw = elCenter(spDrillWord);
        fx.burst(dw.x, dw.y, { count: 22 + 4 * Math.min(5, drill.streak || 0), colors: ["#38bdf8", "#4ade80", "#f8fafc", "#fde047"] });
        setTimeout(() => {
          speller.clearPending();
          syncSpellText();
          nextDrillWord();
        }, 700);
      }
    }

    // fluid mode: decode the raw letter stream -> a clean, speakable sentence,
    // and auto-speak it once the signer clearly stops (a ~2.2 s pause)
    if (fluidMode) {
      spDecodedRow.hidden = false;
      if (decoder && speller.raw.length && now - lastDecodeAt > 350) {
        lastDecodeAt = now;
        // speller.raw is already one entry per committed letter, so a
        // repeated letter is a real double (transition.js only commits one
        // after a deliberate bounce). decode()'s collapse() merges adjacent
        // repeats — right for per-frame streams, wrong here: HELLO decoded as
        // "held", COFFEE as "code" (QA 2026-09-23). A blank between entries
        // keeps every committed letter.
        const d = decoder.decode(speller.raw.flatMap((r) => [r, DECODE_BLANK]));
        spDecodedText.textContent = d.text || "…";
        spDecodedText.dataset.fallback = d.fallback ? "1" : "";
      } else if (!speller.raw.length) {
        spDecodedText.textContent = "…";
      }
      if (
        spAutoSpeak?.checked && !fluidSpoke && fluidLastLetterAt &&
        now - fluidLastLetterAt > 2200 &&
        spDecodedText.textContent && spDecodedText.textContent !== "…"
      ) {
        fluidSpoke = true;
        speak(spDecodedText.textContent);
      }
    } else {
      spDecodedRow.hidden = true;
    }

    // live gesture readout — so a gesture that won't register can be tuned.
    // swipe wants sideways ≥ 1.1 (and > up/down); copy/paste want the two-hand
    // gap to swing past ~2.2 <-> ~1.6
    if (spMetrics && DEBUG && now - lastHintAt >= HINT_INTERVAL) {
      lastHintAt = now;
      const twoHands = (result.landmarks?.length ?? 0) >= 2;
      if (twoHands) {
        const tm = twohand.metrics();
        spMetrics.textContent = tm?.gap != null
          ? `hands: gap ${tm.gap} (saw ${tm.min}–${tm.max}) — copy/paste needs a big swing`
          : `hands: ${tm?.hands ?? "…"}`;
      } else {
        const sm = swipe.metrics();
        spMetrics.textContent =
          hasHand && sm
            ? `${still ? "still ✓" : "moving — hold to lock"} · swipe sideways ${sm.dx}/1.1`
            : "";
      }
    }
  }

  // challenge: you advance when the RECOGNISER reads your hand as the target
  // (a confident, debounced call — not a shape-meter guess). The "seeing"
  // readout uses the raw current prediction so it feels responsive.
  // the "?" tour pauses a live run: skipping updates while it's open leaves a
  // frame gap longer than pauseGapMs, so the run's clock resumes where it
  // was when the tour closes (LAB-055)
  const runPaused = tour.isOpen();
  if (mode === "challenge" && versus?.active && !runPaused) {
    const seen = [null, null];
    if (versus.mode === "race") {
      const lms = result.landmarks || [];
      const owner = racePlayers(lms);
      const got = [null, null];
      lms.forEach((lm, i) => {
        if (owner[i] >= 0) got[owner[i]] = classifyHand(lm, result.handedness?.[i]?.[0]?.categoryName);
      });
      for (const p of [0, 1]) {
        vsStab[p].push(got[p]);
        seen[p] = got[p] ? vsStab[p].current : null; // no hand -> no (stale) letter
      }
    } else {
      // Take turns: each player owns their half of the screen (as in Race).
      // Only a hand on the CURRENT player's side is read — owner live test:
      // "if I gave up and player 2 tried it while it was still player one's
      // turn, it read as player one's turn and gave me the point".
      const lms = result.landmarks || [];
      const owner = racePlayers(lms);
      const i = owner.indexOf(versusCurrent);
      const got = i >= 0 ? classifyHand(lms[i], result.handedness?.[i]?.[0]?.categoryName) : null;
      vsStab[versusCurrent].push(got);
      seen[versusCurrent] = got ? vsStab[versusCurrent].current : null;
      // the other side waiting: say so when their hand is up
      vsWaiting = owner.some((o) => o >= 0 && o !== versusCurrent);
    }
    renderVersus(versus.update(now, seen));
    bg.setMatch(null);
  }

  if (mode === "challenge" && challenge?.active && !runPaused) {
    // a traced J/Z stroke, or the debounced classifier call for a static letter
    // (only while a hand is in view: stabilizer.current latches the last
    // confirmed letter after the hand leaves, and a stale wrong letter must
    // not drain the clock)
    const seen = stroke || (hasHand ? stabilizer.current : null);
    // "near": the hand is close to the needed letter's shape — shown as a
    // hint and earns a one-time grace second at time-out
    const needed = challenge.needed;
    const near =
      !!needed && hasHand && !!vec && !!reference && !MOTION.has(needed) &&
      reference.score(vec, needed).bucket !== "off";
    renderChallenge(challenge.update(now, seen, { near }), near);
    bg.setMatch(null);
  }

  // practice: camera-frame glow + meter + a plain-words hint + the reward
  if (mode === "practice" && motionTarget) {
    // J / Z — no shape meter; you complete it by tracing the stroke in the air,
    // and you can repeat it as many times as you like (the reward re-arms).
    bg.setMatch(null);
    reco.hidden = true;
    if (hasHand && !firstHandAt) firstHandAt = now;

    // live "you're getting there" progress from the stroke metrics, shown on the
    // same fill bar + rising tone the held letters use, snapping to full on a hit
    const mt = motion.metrics();
    let prog = 0;
    if (hasHand && mt) {
      prog = Math.max(0, Math.min(1, mt.progress[targetLetter] ?? 0));
    }
    const shownProg = rewarded ? 1 : prog;
    updateMeter(shownProg, rewarded ? "correct" : prog > 0.55 ? "close" : null);
    setHold(shownProg.toFixed(3));
    // prog is a live geometric metric (for Z it includes a rolling-window
    // reversal count that jumps around during a genuine zigzag) — for
    // a static-letter hold, charge()'s input is a smooth elapsed-time
    // fraction, but here it can swing frame to frame, and charge() restarts a
    // fresh 90ms pitch ramp on every call. Feeding it raw produced a warbling
    // "buzz" artifact, worst on Z (reported live QA) since Z's back-and-forth
    // motion is the noisiest input of the two. Ease it the same way guideAmt
    // is eased above — the on-screen meter/text still show the raw prog.
    // hysteresis: start the tone at 0.25, keep it until prog falls below
    // 0.12 (the old hard 0.15 edge made it pop on and off while struggling);
    // snap to silence instead of decaying for ~85s toward a 240Hz hum
    const chargeOn = motionChargeAmt > 0 ? prog > 0.12 : prog > 0.25;
    const chargeTarget = hasHand && chargeOn ? 0.05 + 0.95 * prog : 0;
    motionChargeAmt += (chargeTarget - motionChargeAmt) * 0.25;
    if (motionChargeAmt < 0.03 || !hasHand) motionChargeAmt = 0;
    if (!rewarded) sound.charge(motionChargeAmt, { soft: true });

    if (now - lastHintAt >= HINT_INTERVAL) {
      lastHintAt = now;
      refHint.textContent = rewarded
        ? `Nailed ${targetLetter}! ✓  — do it again whenever you're ready`
        : blindToggle.checked
        ? "" // "Test blind" — no instructions, just the meter and the eventual reward
        : hasHand
        ? targetLetter === "J"
          ? "Little finger up in a fist — then hook it down and back toward you"
          : "Index finger out — draw a big Z in the air: across, down-slash, across"
        : "Show your hand, then trace the letter in the air";
      // while a hand is mid-stroke show the live metric readout (debug only —
      // a learner reads raw thresholds as a judgment they failed); otherwise
      // fall back to this letter's practice stats ("done 3× · best 2.1s")
      if (DEBUG && hasHand && mt) {
        letterStat.textContent = mt.debug[targetLetter] || "";
      } else {
        updateLetterStat();
      }
    }

    if (stroke === targetLetter && !rewarded) {
      rewarded = true;
      motionRewardAt = now;
      reward(hand?.[targetLetter === "J" ? 20 : 8], hand);
    }
    // re-arm after the celebration so the next swoosh counts too
    if (rewarded && motionRewardAt && now - motionRewardAt > 1500 && !rewardLatched()) {
      rewarded = false;
      motionRewardAt = 0;
      firstHandAt = 0; // fresh "time to complete" clock for the next rep
      motion.reset(); // clear the buffer so the same swoosh can't double-count
    }
  } else if (mode === "practice" && reference && targetLetter) {
    if (hasHand && m) {
      updateMeter(m.score, m.bucket); // shape match only — not gated on the classifier
      // ambient background warms toward green, and reacts in the direction of
      // the problem (fingers off -> top; thumb side off -> that side)
      bg.setMatch(m.score, m.bucket, reference.regionErrors(vec, targetLetter));

      if (!firstHandAt) firstHandAt = now; // starts the "time to complete" clock

      // calm recogniser-agreement readout — reassures that the computer reads
      // the letter, not just that the shape meter is happy
      const agrees = stabilizer.current === targetLetter;
      reco.hidden = false;
      reco.classList.toggle("match", agrees);
      recoText.textContent = agrees
        ? "recognised"
        : stabilizer.current
        ? `reads ${stabilizer.current}`
        : "…";

      // reward when the sign is readable (m.bucket === "correct" — a decent
      // shape OR one the recogniser reads as the target) and held for HOLD_MS.
      // Small tracking dropouts inside HOLD_GRACE_MS don't reset the timer.
      // A NEW letter only counts after the previous one's hand is released
      // (hand dropped, clearly off, or the recogniser confirms something
      // other than the letter just done) and a short settle (armedAt) —
      // live QA: in an A->Z run a hand still up from Q would count for R or
      // be flagged instantly.
      if (needRelease && (!hasHand || m.bucket === "off" ||
          (stabilizer.current && stabilizer.current !== releaseFrom))) needRelease = false;
      // counts exactly when the guide shows no magenta and only a few orange
      // joints (the shared rule) — room for user error, same verdict you see
      const complete = m.strict && !needRelease && now >= armedAt;
      if (complete) {
        if (!holdStart) holdStart = now;
        lastGoodAt = now;
        stuckSince = 0;
        stuckShown = false;
        refPanel.classList.remove("nudge");
      } else if (holdStart && now - lastGoodAt > HOLD_PRESENT_GRACE_MS) {
        // hand in view but the shape broke: drop the hold fast (the long
        // grace below is for tracking dropouts only — it used to let one
        // good frame every 260ms carry a whole hold)
        holdStart = 0;
        if (!rewardLatched()) rewarded = false;
      }
      // "stuck" assist: ~12s on one letter without landing it -> replay the
      // demo and flag the panel
      if (!complete && !azAdvancing) {
        if (!stuckSince) stuckSince = now;
        else if (!stuckShown && now - stuckSince > 12000) {
          stuckShown = true;
          refPanel.classList.add("nudge");
          refPlayer?.setTarget(reference.centroid(targetLetter));
        }
      }
      const heldMs = holdStart ? now - holdStart : 0;
      const heldFrac = Math.min(1, heldMs / HOLD_MS);
      setHold(heldFrac.toFixed(3));
      // rising "charge" tone tracks the hold; success() resolves it
      if (holdStart && !rewarded) sound.charge(0.05 + 0.95 * heldFrac);
      else if (!rewarded) sound.charge(0);
      if (holdStart && heldMs >= HOLD_MS && !rewarded) {
        rewarded = true;
        reward(hand[0], hand);
      }

      if (now - lastHintAt >= HINT_INTERVAL) {
        lastHintAt = now;
        // the shape is nearer a look-alike (the reason it isn't counting) or
        // the recogniser confidently reads another letter
        const lookAs = m.confusedWith ||
          (lastPred && lastPred.label !== targetLetter && lastPred.confidence >= 0.8 ? lastPred.label : null);
        const misread = !complete && !!lookAs;
        // the letter's own failing trait is the most useful instruction
        const badTrait = m.traits?.traits.find((t) => t.state === "fix") || m.traits?.traits.find((t) => t.state === "close");
        let tip = badTrait?.hint || reference.hint(vec, targetLetter);
        // hint() can say "looks right" from the coarse feature check while the
        // meter is still short — fall back to the precise joint the on-camera
        // guide is pointing at, so the endgame ("near perfect, can't see what")
        // still has something to act on.
        if (!complete && /looks right/i.test(tip)) {
          tip = guideInfo?.finger
            ? `Move your ${guideInfo.finger} finger toward the ▲ marker`
            : guideInfo?.part
            ? `Move your ${guideInfo.part} toward the ▲ marker`
            : m.bucket === "close"
            ? "So close — tiny changes now"
            : "Keep shaping it";
        }
        // "(reading as X)" was cryptic; say what it looks like and what to change
        const misreadTip = misread
          ? `Looks like ${lookAs} right now — ${PAIR_TIP[targetLetter + lookAs] || ORIENT_TIP[targetLetter] || tip.charAt(0).toLowerCase() + tip.slice(1)}`
          : "";
        const dots = "●".repeat(Math.round(heldFrac * 5)).padEnd(5, "·");
        const prefix = stuckShown && !complete ? "Still tricky? " : "";
        // "Test blind" keeps the pass/fail state (Nailed it / Hold it…) — that's
        // the test — but drops the tip text, which is the "how" it's meant to hide.
        refHint.textContent = rewarded
          ? `Nailed it — that's ${targetLetter} ✓`
          : complete
          ? `Hold still…  ${dots}`
          : blindToggle.checked
          ? ""
          : misread
          ? `${prefix}${misreadTip}`
          : `${prefix}${tip}`;
      }
    } else {
      updateMeter(0, null);
      bg.setMatch(null);
      refHint.textContent = "";
      reco.hidden = true;
      if (!rewarded) sound.charge(0);
      // hand lost mid-hold: keep the timer alive briefly (grace), else drop it
      if (holdStart && now - lastGoodAt > HOLD_GRACE_MS) {
        holdStart = 0;
        if (!rewardLatched()) rewarded = false;
        setHold("0");
      }
    }
  } else {
    bg.setMatch(null);
    if (mode !== "practice" || !targetLetter) sound.charge(0); // nothing to charge toward
  }

  // first-run tour: scenes that react to your hand (Stage 7a)
  if (tour.isOpen()) {
    tour.feed({ hasHand, guideStats, hold: Number(lastHold) || 0, rewarded, target: targetLetter });
  }

  // "pick a letter" nudge — only in practice, camera live, nothing chosen yet
  pickHint.hidden = !(mode === "practice" && !targetLetter);

  tickDetStats(now);
}

// stats badge + effects governor feed (~2x/sec) — detections per second, the
// load that matters for recognition (also counted while the hero is open)
function tickDetStats(now) {
  detCount++;
  if (now - detStamp >= 500) {
    fps = Math.round((detCount * 1000) / (now - detStamp));
    detCount = 0;
    detStamp = now;
    // effects budget: Race tracks two hands (heaviest load) -> pinned to lite
    fxq.set({ mode: mode === "challenge" && versus?.active && versus.mode === "race" ? "race" : mode });
    fxq.reportFps(fps, true, now);
    fxDebug?.setFps(fps);
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
  // the rAF loop (the only thing that updates the hold tone) pauses in a
  // hidden tab — stop the tone instead of leaving it droning
  if (document.visibilityState === "hidden") sound.chargeStop();
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
blindToggle.addEventListener("change", () => {
  // guiding/hint text re-evaluate every frame from blindToggle.checked directly;
  // the reference panel doesn't, so it needs an explicit refresh on toggle.
  refPanel.hidden = !targetLetter || blindToggle.checked;
  if (targetLetter && !blindToggle.checked) openRefSheet();
});
muteBtn.addEventListener("click", () => {
  sound.setMuted(!sound.muted);
  syncMuteBtn();
});
modeToggle.addEventListener("click", (e) => {
  const b = e.target.closest(".mode-btn");
  if (b) setMode(b.dataset.mode);
});
subMode.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sub]");
  if (!b) return;
  if (b.dataset.sub === "free") setAzRun(false);
  else setAzRun(true, b.dataset.sub); // "az" | "review"
});
const stepLetter = (dir) => {
  if (!reference || !targetLetter || azRun) return;
  const list = ALL_LETTERS;
  const i = list.indexOf(targetLetter);
  setTarget(list[(i + dir + list.length) % list.length]);
};
prevLetterBtn.addEventListener("click", () => stepLetter(-1));
nextLetterBtn.addEventListener("click", () => stepLetter(1));
handPick.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-hand]");
  if (!b) return;
  handOverride = b.dataset.hand;
  savePref("hand", handOverride);
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
chSkip.addEventListener("click", () => challenge?.skip());

// spell-mode transcript controls
const escapeHtml = (s) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const syncSpellText = () => {
  if (!speller) return;
  const t = speller.text;
  const p = speller.pending;
  // called every frame in Spell mode — only touch the DOM when the text
  // actually changed (innerHTML + reading scrollHeight forces a layout)
  if (t === lastSpellText && p === lastSpellPending) return;
  lastSpellText = t;
  lastSpellPending = p;
  const sep = t && p && !t.endsWith(" ") ? " " : "";
  spText.innerHTML =
    escapeHtml(t) + sep +
    (p ? `<span class="sp-pending">${escapeHtml(p)}</span>` : "");
  spText.scrollTop = spText.scrollHeight;
};
spSpace.addEventListener("click", () => { speller?.space(); syncSpellText(); });
spBack.addEventListener("click", () => { speller?.backspace(); syncSpellText(); });
spClear.addEventListener("click", () => {
  speller?.clear();
  transition.reset();
  fluidSpoke = false;
  fluidLastLetterAt = 0;
  syncSpellText();
  spDecodedText.textContent = "…";
  if (drillMode && drill?.target) renderDrillWord(); // drop the half-painted prompt
});

// fluid mode: transition.js letters + decoder + speech
function applyFluid() {
  fluidMode = spFluid.checked;
  savePref("fluid", fluidMode ? "1" : "0");
  transition.reset();
  spellStab?.reset();
  spellWrist = [];
  spDecodedRow.hidden = !fluidMode;
  spellPanel.classList.toggle("fluid", fluidMode);
  spHint.textContent = fluidMode
    ? "Sign at a natural pace — each settled shape is a letter, a pause finishes a word. Tap 🔊 to hear it."
    : "Spell a word (shown dashed) — pause a second and it's saved. Swipe to scrap it.";
  // The "Hand gestures" / "How to spell" copy below was written for the
  // still-mode mechanic ("hold it still until the ring fills") and stayed
  // that way even in fluid mode, where a letter locks in when the hand
  // SETTLES after moving — no ring, no held-still countdown. Swap the copy
  // that actually describes the mechanic; everything else in those lists
  // (word-finish, scrap, copy/paste, J/Z) applies the same in both modes.
  if (gHoldText) {
    gHoldText.innerHTML = fluidMode
      ? "<b>Add a letter</b> — form the handshape at a natural signing pace; it locks in once your hand <b>settles</b> after moving."
      : "<b>Add a letter</b> — form the handshape and <b>hold it still</b> until the ring fills (about half a second).";
  }
  if (spStep1) {
    spStep1.innerHTML = fluidMode
      ? "<b>Spell a word</b> — sign continuously at a natural pace. Letters build up as a <b>dashed word</b> — that's a draft, not saved yet."
      : "<b>Spell a word</b> — form each letter and hold it briefly. Letters build up as a <b>dashed word</b> — that's a draft, not saved yet.";
  }
  if (spStep2) {
    spStep2.innerHTML = fluidMode
      ? "<b>Next letter</b> — keep moving into the next handshape; a brief settle after each one is what locks it in, not a held pose."
      : "<b>Next letter</b> — just change handshape; no pause needed. Hold each one still for a beat so it's read cleanly.";
  }
}
spFluid.checked = fluidMode;
applyFluid();
spFluid.addEventListener("change", applyFluid);

// ---- spell-mode word drill (B4) --------------------------------
// Give the signer a target word; colour it in as they spell it; on an exact
// match, celebrate and move on. Source is either the active course tier or a
// short+common starter pool. Reads the attempt straight out of speller.js.

function refillDrill() {
  if (!drill) return;
  const fromCourse = drillSrc === "course" && course && course.words().length;
  drill.setWords(fromCourse ? course.words() : drillStarter);
}

function renderDrillScoreOnly() {
  if (!drill || !spDrillScore) return;
  spDrillScore.textContent = drill.done
    ? `${drill.done} done${drill.streak >= 2 ? `  🔥${drill.streak}` : ""}`
    : "";
}

function renderDrillWord() {
  if (!drill || !spDrillWord) return;
  const w = drill.target || "";
  spDrillWord.innerHTML = w
    .split("")
    .map((c) => `<span class="ltr">${c.toUpperCase()}</span>`)
    .join("");
  spDrillWord.classList.remove("solved");
  renderDrillScoreOnly();
}

// colour the prompt: matched prefix green, first wrong letter red
function paintDrill(attempt) {
  if (!drill || !spDrillWord || spDrillWord.classList.contains("solved")) return;
  const m = drill.match(attempt);
  const spans = spDrillWord.querySelectorAll(".ltr");
  spans.forEach((s, i) => {
    s.classList.toggle("hit", i < m.n);
    s.classList.toggle("miss", m.bad && i === m.n);
  });
}

function nextDrillWord() {
  if (!drill) return;
  drill.next();
  renderDrillWord();
}

function applyDrill() {
  drillMode = spDrill.checked;
  savePref("drill", drillMode ? "1" : "0");
  spDrillRow.hidden = !drillMode;
  spellPanel.classList.toggle("drill", drillMode);
  if (drillMode) {
    refillDrill();
    if (!drill?.target) nextDrillWord();
    else renderDrillWord();
  }
}
spDrill.checked = drillMode;
spDrillSkip.addEventListener("click", () => {
  drill?.skip();
  renderDrillWord();
  speller?.clearPending();
  syncSpellText();
});
spDrillSrc.addEventListener("change", () => {
  drillSrc = spDrillSrc.value === "starter" ? "starter" : "course";
  savePref("drill-src", drillSrc);
  refillDrill();
  nextDrillWord();
});
spDrill.addEventListener("change", applyDrill);

function speak(text) {
  const t = (text || "").trim();
  if (!t || !window.speechSynthesis) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch {}
}
spSpeak.addEventListener("click", () =>
  speak(spDecodedText.textContent !== "…" ? spDecodedText.textContent : speller?.display)
);

// read mode
rdForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (rdInput.disabled) return;
  judgeRead(false);
});
rdReveal.addEventListener("click", () => { if (!rdInput.disabled) judgeRead(true); });
rdNext.addEventListener("click", nextReadWord);
rdPlay.addEventListener("click", () => reader && playWord(reader.current));
rdPause.addEventListener("click", togglePause);
rdStepBack.addEventListener("click", () => stepReadLetter(-1));
rdStepFwd.addEventListener("click", () => stepReadLetter(1));
rdSeek.addEventListener("input", () => {
  if (!readPlayer) return;
  readPlayer.pause();
  readPlayer.seek(Number(rdSeek.value));
  stopTransportSync();
  updatePauseButton();
});
rdSpeed.addEventListener("change", () => {
  savePref("read-speed", rdSpeed.value);
  if (mode === "read" && reader) playWord(reader.current);
});
rdCats.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cat]");
  if (!b || !reader) return;
  reader.toggleCategory(b.dataset.cat);
  buildReadCats();
  if (mode === "read") nextReadWord();
});
rdModes.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-rmode]");
  if (!b || b.dataset.rmode === readStyle) return;
  if (b.dataset.rmode === "course" && !course) return; // still loading
  readStyle = b.dataset.rmode;
  applyReadStyle();
});
rdPath.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-step]");
  if (!b || !course || b.disabled) return;
  if (!course.select(Number(b.dataset.step))) return;
  saveJSON("course", course.state());
  buildReadPath();
  renderLesson();
  nextReadWord();
});

async function doSpellCopy() {
  const out = speller?.display?.trim();
  if (!out) return;
  spellClipboard = out; // remembered for the paste gesture
  let okIcon = "Copied ✓";
  try {
    await navigator.clipboard.writeText(out);
  } catch {
    okIcon = "Copied (local)"; // clipboard API blocked — the paste gesture still works
  }
  spCopy.textContent = okIcon;
  setTimeout(() => (spCopy.textContent = "Copy"), 1200);
  fx.flash("rgba(34, 197, 94, 0.35)");
  buzz([0, 18, 28, 18]);
}
spCopy.addEventListener("click", doSpellCopy);
spPaste.addEventListener("click", async () => {
  let t = "";
  try { t = await navigator.clipboard.readText(); } catch {}
  if (!t) t = spellClipboard;
  if (t && speller?.insert(t)) syncSpellText();
});

// spell mode: an A–Z reference chart in the panel; tap a letter to enlarge it
if (spGrid) {
  spGrid.setAttribute("role", "group");
  spGrid.setAttribute("aria-label", "Alphabet reference — activate a letter to enlarge it");
  for (const L of ALL_LETTERS) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "sp-cell";
    cell.dataset.letter = L;
    cell.setAttribute("aria-label", `${L} — enlarge`);
    cell.innerHTML = `<img alt="" src="${REFERENCE_IMG(L)}" /><b aria-hidden="true">${L}</b>`;
    spGrid.appendChild(cell);
  }
  spGrid.addEventListener("click", (e) => {
    const cell = e.target.closest(".sp-cell");
    if (!cell || !reference) return;
    const L = cell.dataset.letter;
    if (MOTION.has(L)) demoZoomPlayer?.setMotion?.(L);
    else demoZoomPlayer?.setTarget(reference.centroid(L));
    openDemoZoom("anim");
  });
}

// the enlarge overlay shows either the live demo-hand animation or a static
// reference photo, never both — swap which element is visible per open()
function openDemoZoom(kind) {
  demoZoomCanvas.hidden = kind !== "anim";
  demoZoomImg.hidden = kind !== "photo";
  demoZoom.hidden = false;
}

// enlarge the demo (tap the panel canvas)
demoZoomBtn.addEventListener("click", () => {
  if (!reference || !targetLetter) return;
  demoZoomPlayer?.setTarget(reference.centroid(targetLetter));
  openDemoZoom("anim");
});
// enlarge the reference photo (tap the panel photo — was previously not
// tappable at all, and the inline photo is too small to read finger detail)
refPhotoBtn?.addEventListener("click", () => {
  if (!refImg.src) return;
  demoZoomImg.src = refImg.src;
  openDemoZoom("photo");
});
demoZoom.addEventListener("click", () => {
  demoZoom.hidden = true;
  demoZoomPlayer?.setTarget(null);
});

// keyboard: arrows step letters, space starts/skips the challenge, a-z jump
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  // the tour is modal: its own keys (Escape = skip, via sheet.js) only
  if (tour?.isOpen()) return;
  if (hero?.isOpen()) return; // the hero owns the keyboard (Escape = Start)
  // Escape closes whatever overlay is open
  if (e.key === "Escape") {
    if (!demoZoom.hidden) { demoZoom.hidden = true; demoZoomPlayer?.setTarget(null); return; }
    if (!progressPanel.hidden) { progressPanel.hidden = true; return; }
    if (!runCard.hidden) { runCardClose.click(); return; }
  }
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;

  if (mode === "spell") {
    if (e.key === "Backspace") { e.preventDefault(); speller?.backspace(); syncSpellText(); return; }
    if (e.key === " ") { e.preventDefault(); speller?.space(); syncSpellText(); return; }
  }

  if (e.key === "ArrowRight") stepLetter(1);
  else if (e.key === "ArrowLeft") stepLetter(-1);
  else if (e.key === " ") {
    if (mode === "challenge") {
      e.preventDefault();
      if (!chCard.hidden) chStart.click();
      else if (challenge?.phase === "play") challenge.skip();
    }
  } else if (/^[a-z]$/i.test(e.key) && mode === "practice" && !azRun && reference) {
    const L = e.key.toUpperCase();
    if (ALL_LETTERS.includes(L)) setTarget(L);
  }
});

// ---- first-run walkthrough (Stage 7a) — js/tour.js ------------------------
// Opens by itself on a first visit (same "seen-intro" pref the old static
// #intro used, so returning users aren't shown it again) and from the "?"
// button in the top bar. main.js only lends it hooks into the camera, the Hand
// control and Practice; the tour decides everything else. Fed once per camera
// frame from loop().
// index.html defers a service-worker update's reload while this is true, so
// a deploy never wipes a transcript or ends a run mid-session (LAB-056)
window.__aslBusy = () =>
  (state !== "idle" && state !== "error") || !!speller?.text || !!speller?.pending ||
  !!challenge?.active || !!versus?.active || tour.isOpen();

const tourBtn = $("tourBtn");
let tourReturn = null; // { mode, ghost, blind } the tour borrowed Practice from
const tour = createTour({
  hud: viewport.querySelector(".hud"),
  cameraState: () => state,
  startCamera: () => start(),
  reference: () => reference,
  hand: () => handOverride,
  setHand: (side) => handPick.querySelector(`button[data-hand="${side}"]`)?.click(),
  // same rule as applyHand(): the selfie view flips the demo for a right hand
  mirrored: () => trackedHand === (facingMode === "user" ? "right" : "left"),
  practice: (letter) => {
    if (!reference || !challenge) return false;
    // never end a live Challenge / two-player run for the tour (LAB-055):
    // it's paused (see runPaused in loop()) and continues when the tour closes
    if (mode === "challenge" && (challenge.active || versus?.active)) return "Your Challenge run is paused. Finish or close the tour to get back to it.";
    // borrow Practice (+ its guide toggles); onDone puts you back where you were
    tourReturn ??= { mode, ghost: ghostToggle.checked, blind: blindToggle.checked };
    if (mode !== "practice") setMode("practice");
    if (azRun) setAzRun(false);
    ghostToggle.checked = true;
    blindToggle.checked = false;
    if (targetLetter !== letter) setTarget(letter);
    else {
      // same letter again (scene 4 -> 5): start a fresh hold
      holdStart = 0;
      rewarded = false;
      setHold("0");
    }
    return true;
  },
  onDone: () => {
    savePref("seen-intro", "1");
    if (tourReturn) {
      const r = tourReturn;
      tourReturn = null;
      ghostToggle.checked = r.ghost;
      blindToggle.checked = r.blind;
      setMode(r.mode);
    }
    tourBtn.focus();
  },
});
tourBtn.addEventListener("click", () => tour.open());

// ---- landing / hero (visual layer v2, B2) — js/hero.js --------------------
// First visit: the hero, then (on Start) the tour. The logo reopens it any
// time; ?hero forces it. Its fluid runs only while it's open.
const hero = createHero({
  root: $("hero"),
  governor: fxq,
  shapeFor: (L) => reference?.centroid?.(L) ?? null,
  shapesReady: datasetPromise,
  startCamera: () => start(),
  cameraLive: () => state === "searching" || state === "tracking",
  debug: DEBUG,
});
if (DEBUG) window.__fx.hero = hero;
// Home (and the logo): the whole first-visit experience again — the welcome
// screen, then the tour on Start (owner, 2026-09-25: "a way to go back to the
// starting intro and page"). The tour's own mode/run handling still applies.
function goHome() {
  if (tour.isOpen()) tour.close();
  hero.open({ onStart: () => tour.open() });
}
$("homeBtn").addEventListener("click", goHome);
$("logoBtn").addEventListener("click", goHome);
if (loadPref("seen-intro") !== "1") hero.open({ onStart: () => tour.open() });
else if (new URLSearchParams(location.search).has("hero")) hero.open();
