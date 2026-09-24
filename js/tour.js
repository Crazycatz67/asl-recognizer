// =============================================================================
// js/tour.js — interactive first-run walkthrough (Stage 7a) (Browser UI)
// =============================================================================
// WHAT: A six-scene, ~60-90 s "how it works" tour that replaced the static
//   #intro popup. First-time users didn't know what to do, which hand to use,
//   that the view is a mirror, which way the palm should face, or what the
//   overlay colours mean. Each scene teaches one of those, live on the user's
//   own hand where it can, and moves on by itself when the user succeeds:
//     1 hand    show a hand in the dashed box (✓ when detected)
//     2 which   which hand you sign with (writes the Hand control) + mirror
//     3 palm    palm forward / pointing across your body / pointing down
//     4 colors  the guide's colours, lit up as each happens on your hand
//     5 hold    hold still to fill the ring
//     6 first   sign A -> "You're ready"
//   Every scene also has Next, plus Back, Skip and progress dots. Escape
//   skips. Everything works with the camera off (the live scenes just say so
//   and wait for Next). Visual-only: no step depends on sound.
//
// WHERE IT SITS: UI only. main.js owns the camera and the practice state and
//   passes them in as hooks, then calls tour.feed() once per camera frame
//   while the tour is open. The modal behaviour (focus trap, inert page,
//   Escape) comes from js/sheet.js. Nothing here touches recognition.
//
// PUBLIC API:
//   TOUR_SCENES                    the scene list (ids + which need the camera)
//   createTourMachine(count)       pure scene state machine (selftest-covered)
//   accumulateLegend(seen, stats)  pure: fold overlay.guideStats() into "seen"
//   legendComplete(seen)           pure: has the colours scene been shown enough
//   createTour(hooks) -> { open(), close(), isOpen(), feed(frame) }
//     hooks: {
//       hud,               element to put the scene-1 dashed hand box in
//       cameraState(),     "idle" | "requesting" | "loading" | "searching" | "tracking" | "error"
//       startCamera(),
//       reference(),       practice reference (centroids) or null while loading
//       hand(),            "right" | "left" | "auto" — the Hand control
//       setHand(side),
//       mirrored(),        true when the chosen hand's demos should be flipped
//       practice(letter),  switch to Practice on `letter`; false if not ready
//       onDone(how),       "done" | "skipped"
//     }
//   feed({ hasHand, guideStats, hold, rewarded, target })  once per frame
//
// PRIVACY: scene 1 carries the privacy callout the old #intro had.

import { createSheet } from "./sheet.js";
import { drawHandShape, makeFit, vectorToPixels } from "./skeleton.js";
import { createCanonicalPlayer, NEUTRAL_HAND } from "./reference.js";

export const TOUR_SCENES = [
  { id: "hand", live: true },
  { id: "which", live: false },
  { id: "palm", live: false },
  { id: "colors", live: true, letter: "B" },
  { id: "hold", live: true, letter: "B" },
  { id: "first", live: true, letter: "A" },
];

// ---- pure logic --------------------------------------------------------

// Scene index + which scenes were passed + how the tour ended. No DOM.
export function createTourMachine(count) {
  let i = 0;
  let finished = null; // null | "done" | "skipped"
  const passed = new Set();
  return {
    get index() { return i; },
    get count() { return count; },
    get finished() { return finished; },
    isLast() { return i === count - 1; },
    passed(k = i) { return passed.has(k); },
    // mark the current scene passed; true only the first time
    succeed() {
      if (finished || passed.has(i)) return false;
      passed.add(i);
      return true;
    },
    // Next on the last scene finishes the tour
    next() {
      if (finished) return i;
      if (i >= count - 1) finished = "done";
      else i++;
      return i;
    },
    back() {
      if (!finished && i > 0) i--;
      return i;
    },
    skip() {
      if (!finished) finished = "skipped";
    },
    reset() {
      i = 0;
      finished = null;
      passed.clear();
    },
  };
}

// Fold one frame of overlay.guideStats() into the set of legend states the
// user has seen on their own hand. Returns a new object; ignores frames where
// the guide wasn't drawn.
export function accumulateLegend(seen, stats) {
  const out = { ...seen };
  if (!stats?.shown) return out;
  if (stats.counts.good) out.good = true;
  if (stats.counts.close) out.close = true;
  if (stats.counts.fix) out.fix = true;
  if (stats.worstFinger) out.worst = true;
  return out;
}
// enough to have learned the idea: a good part AND an off part, both seen
export const legendComplete = (s) => !!(s && s.good && (s.close || s.fix));

// ---- scene copy (plain, short English) -------------------------------

const PRIVACY =
  '<p class="intro-privacy">🔒 <b>Private.</b> Everything runs on your device. ' +
  "Your camera video is never recorded, saved, or sent anywhere.</p>";

const LEGEND = [
  ["good", "ck-good", "✓ Good", "this part matches"],
  ["close", "ck-close", "~ Close", "nearly right"],
  ["fix", "ck-fix", "✕ Fix", "move this part"],
  ["worst", "ck-worst", "▲ Fix first", "the finger that is most off"],
];

const ORIENTS = [
  { letter: "B", icon: "✋", name: "Palm forward", sub: "most letters" },
  { letter: "H", icon: "👉", name: "Pointing across your body", sub: "G, H" },
  { letter: "Q", icon: "👇", name: "Pointing down", sub: "P, Q" },
];

const SCENE_HTML = {
  hand: () =>
    PRIVACY +
    `<h2 class="tour-title" tabindex="-1">Show your hand</h2>
     <p>Hold one hand up, about an arm's length from the camera.
        Keep your whole hand inside the dashed box.</p>`,
  which: () =>
    `<h2 class="tour-title" tabindex="-1">Which hand do you sign with?</h2>
     <p>Use the hand you write with. Both hands work.</p>
     <div class="tour-hands" role="group" aria-label="Your signing hand">
       <button type="button" class="tour-choice" data-hand="left">Left hand</button>
       <button type="button" class="tour-choice" data-hand="right">Right hand</button>
     </div>
     <canvas class="tour-mirror-art" width="360" height="200" aria-hidden="true"></canvas>
     <p class="tour-note"><b>The camera is a mirror</b>, like a selfie.
        Raise your right hand and it shows on the right side of the screen.</p>`,
  palm: () =>
    `<h2 class="tour-title" tabindex="-1">Watch which way your palm faces</h2>
     <p>For most letters your palm faces the camera. A few letters turn the hand.
        Each letter's card tells you which way.</p>
     <div class="tour-palm">
       <canvas class="tour-palm-big" width="320" height="320" aria-hidden="true"></canvas>
       <ol class="tour-orients">
         ${ORIENTS.map(
           (o, k) =>
             `<li data-k="${k}"><canvas width="120" height="120" aria-hidden="true"></canvas>
               <span class="tour-orient-icon" aria-hidden="true">${o.icon}</span>
               <b>${o.name}</b><span class="tour-orient-sub">${o.sub}</span></li>`
         ).join("")}
       </ol>
     </div>`,
  colors: () =>
    `<h2 class="tour-title" tabindex="-1">The colors show what to fix</h2>
     <p>Make a flat hand, fingers together, palm forward. That is the letter B.
        Now bend one finger and watch it change.</p>
     <ul class="tour-legend">
       ${LEGEND.map(
         ([k, cls, name, sub]) =>
           `<li data-k="${k}"><span class="ck-sw ${cls}" aria-hidden="true"></span>
             <b>${name}</b><span>${sub}</span><span class="tour-seen" aria-hidden="true">✓</span></li>`
       ).join("")}
     </ul>
     <p class="tour-note">The faint dashed hand is the <b>target</b>: where your hand should go.
        Tap <b>● ● ● ?</b> on the camera any time to see these again.</p>`,
  hold: () =>
    `<h2 class="tour-title" tabindex="-1">Hold still to lock it in</h2>
     <p>When your shape is right, a bar fills along the bottom of the camera,
        and the ring below fills too. Keep still until it is full.
        If you move, it drains.</p>
     <div class="tour-ring-row"><span class="tour-ring" style="--p:0"><span aria-hidden="true">✋</span></span></div>
     <p class="tour-note">Try it with the B shape from the last step.</p>`,
  first: () =>
    `<h2 class="tour-title" tabindex="-1">Try your first letter: A</h2>
     <p>Palm faces the camera. Make a fist. Rest your thumb against the side
        of your index finger, pointing up. Then hold still.</p>`,
  ready: () =>
    `<h2 class="tour-title" tabindex="-1">🎉 You're ready!</h2>
     <p>Pick any letter to practice. The colors and the ▲ show you what to fix.</p>
     <ul class="tour-modes">
       <li><b>Practice</b> one letter at a time, or all 26 in an <b>A→Z run</b>.</li>
       <li><b>Challenge</b>: sign each letter before the timer runs out.</li>
       <li><b>Spell</b>: sign letter after letter to write whole words.</li>
       <li><b>Read</b>: watch a hand spell a word, then type what you saw.</li>
     </ul>
     <p class="tour-note">Tap <b>?</b> at the top any time to see this tour again.</p>`,
};

const SUCCESS_MSG = {
  hand: "✓ Hand found!",
  which: "✓ Saved. You can change it later with the Hand buttons under the camera.",
  colors: "✓ You've seen the colors on your own hand.",
  hold: "✓ Locked in!",
  first: "✓ That's A!",
};

const AUTO_ADVANCE_MS = 1300;
const HAND_FRAMES = 8; // frames of a steady hand before scene 1 counts it

// ---- the DOM tour -------------------------------------------------------

export function createTour(hooks) {
  const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const reduce = () => !!reduceQuery?.matches;

  const el = document.createElement("div");
  el.className = "tour";
  el.id = "tour";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "How it works");
  el.innerHTML = `
    <div class="tour-card">
      <div class="tour-top">
        <span class="tour-step"></span>
        <span class="tour-dots" aria-hidden="true">${TOUR_SCENES.map(() => "<i></i>").join("")}</span>
        <button type="button" class="tour-skip">Skip tour</button>
      </div>
      <div class="tour-body"></div>
      <div class="tour-cam" hidden>
        <span class="tour-cam-text"></span>
        <button type="button" class="tour-cam-btn">Turn on camera</button>
      </div>
      <p class="tour-status" role="status" aria-live="polite"></p>
      <div class="tour-nav">
        <button type="button" class="tour-back">Back</button>
        <button type="button" class="cta tour-next">Next</button>
      </div>
    </div>`;
  document.body.appendChild(el);

  const q = (s) => el.querySelector(s);
  const stepEl = q(".tour-step");
  const dots = [...q(".tour-dots").children];
  const body = q(".tour-body");
  const camRow = q(".tour-cam");
  const camText = q(".tour-cam-text");
  const camBtn = q(".tour-cam-btn");
  const statusEl = q(".tour-status");
  const backBtn = q(".tour-back");
  const nextBtn = q(".tour-next");

  // scene 1's dashed "put your hand here" box, over the camera
  const frame = document.createElement("div");
  frame.className = "tour-frame";
  frame.hidden = true;
  frame.innerHTML = '<span class="tour-frame-tick" aria-hidden="true">✓</span>';
  hooks.hud?.appendChild(frame);

  const m = createTourMachine(TOUR_SCENES.length);
  let ready = false; // the final "You're ready" card is showing
  let advanceTimer = 0;
  let tickTimer = 0;
  let cycleTimer = 0;
  let player = null;
  let handFrames = 0;
  let seen = {};
  let lastRewarded = false;
  let lastStatus = "";

  const sheet = createSheet(el, {
    modal: true,
    backdrop: false,
    onClose: () => {
      // closing from the "You're ready" card (Escape too) counts as finished
      if (!m.finished) ready ? m.next() : m.skip();
      teardownScene();
      clearInterval(tickTimer);
      tickTimer = 0;
      frame.hidden = true;
      el.hidden = true;
      hooks.onDone?.(m.finished);
    },
  });

  const scene = () => TOUR_SCENES[m.index];

  function setStatus(text) {
    if (text === lastStatus) return;
    lastStatus = text;
    statusEl.textContent = text;
  }

  function teardownScene() {
    clearTimeout(advanceTimer);
    advanceTimer = 0;
    clearInterval(cycleTimer);
    cycleTimer = 0;
    player?.setTarget(null);
    player?.stop();
    player = null;
  }

  function render() {
    teardownScene();
    const s = scene();
    const n = m.index + 1;
    stepEl.textContent = ready ? "All done" : `Step ${n} of ${m.count}`;
    dots.forEach((d, k) => {
      d.className = k < m.index || ready ? "done" : k === m.index ? "on" : "";
    });
    body.innerHTML = ready ? SCENE_HTML.ready() : SCENE_HTML[s.id]();
    backBtn.hidden = m.index === 0 || ready;
    nextBtn.textContent = ready ? "Start practicing" : m.isLast() ? "Finish" : "Next";
    q(".tour-skip").hidden = ready;
    lastStatus = null;
    setStatus("");
    handFrames = 0;
    seen = {};
    lastRewarded = true; // a reward must START inside this scene to count
    frame.hidden = ready || s.id !== "hand";
    frame.classList.remove("found");

    if (!ready) {
      if (s.letter) {
        const ok = hooks.practice?.(s.letter);
        if (!ok) setStatus("Still loading the letters. Tap Next to keep going.");
      }
      if (s.id === "which") setupWhich();
      if (s.id === "palm") setupPalm();
      if (m.passed()) setStatus(SUCCESS_MSG[s.id] || "");
    }
    tick();
    // move focus to the new scene's heading so screen readers read it and
    // keyboard users start from the top of the new content
    q(".tour-title")?.focus({ preventScroll: true });
  }

  // camera row + scene-1 box, polled while open (the camera loop may not be
  // running at all when the camera is off)
  function tick() {
    const s = scene();
    const cam = hooks.cameraState?.() || "idle";
    const live = cam === "searching" || cam === "tracking";
    const needsCam = !ready && s.live;
    camRow.hidden = !needsCam || live;
    if (needsCam && !live) {
      const busy = cam === "requesting" || cam === "loading";
      camText.textContent = busy
        ? "Starting the camera…"
        : cam === "error"
        ? "The camera didn't start. You can still tap Next."
        : "Your camera is off. Turn it on to try this, or tap Next.";
      camBtn.hidden = busy;
      camBtn.textContent = cam === "error" ? "Try again" : "Turn on camera";
    }
    if (!ready && s.id === "hand" && live && !m.passed()) {
      setStatus(cam === "tracking" ? "Hand seen… hold it there." : "Looking for your hand…");
    }
  }

  function succeed() {
    const s = scene();
    if (!m.succeed()) return;
    setStatus(SUCCESS_MSG[s.id] || "✓");
    if (s.id === "hand") frame.classList.add("found");
    if (s.id === "which") return; // let them read the mirror note, then Next
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(() => {
      advanceTimer = 0;
      goNext();
    }, AUTO_ADVANCE_MS);
  }

  function goNext() {
    if (ready) {
      m.next(); // finishes
      sheet.close();
      return;
    }
    if (m.isLast()) {
      ready = true;
      render();
      return;
    }
    m.next();
    render();
  }

  // ---- scene 2: which hand + mirror ----
  function setupWhich() {
    const art = body.querySelector(".tour-mirror-art");
    const pick = hooks.hand?.();
    const draw = (side) => drawMirrorArt(art, side);
    for (const b of body.querySelectorAll(".tour-choice")) {
      const on = b.dataset.hand === pick;
      b.setAttribute("aria-pressed", String(on));
      b.addEventListener("click", () => {
        hooks.setHand?.(b.dataset.hand);
        for (const o of body.querySelectorAll(".tour-choice"))
          o.setAttribute("aria-pressed", String(o === b));
        draw(b.dataset.hand);
        m.passed() ? setStatus(SUCCESS_MSG.which) : succeed();
      });
    }
    draw(pick === "left" || pick === "right" ? pick : null);
  }

  // ---- scene 3: palm orientation ----
  function setupPalm() {
    const ref = hooks.reference?.();
    const mirror = !!hooks.mirrored?.();
    const wrap = body.querySelector(".tour-palm");
    wrap.classList.toggle("mirror", mirror);
    const items = [...body.querySelectorAll(".tour-orients li")];
    // the "across your body" pointer must match the (possibly flipped) drawing
    const across = items[1]?.querySelector(".tour-orient-icon");
    if (across) across.textContent = mirror ? "👈" : "👉";
    const vecOf = (o) => (ref ? ref.centroid(o.letter) : null);
    items.forEach((li, k) => {
      const c = li.querySelector("canvas");
      const v = vecOf(ORIENTS[k]);
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      if (v) drawHandShape(ctx, vectorToPixels(v, c.width, c.height, { pad: 0.14 }));
      else drawFallback(ctx, c.width, c.height, k);
    });
    const big = body.querySelector(".tour-palm-big");
    let k = 0;
    const show = () => {
      items.forEach((li, j) => li.classList.toggle("on", j === k));
      const v = vecOf(ORIENTS[k]);
      if (v) {
        player ||= createCanonicalPlayer(big);
        player.setTarget(v);
      } else {
        const ctx = big.getContext("2d");
        ctx.clearRect(0, 0, big.width, big.height);
        drawFallback(ctx, big.width, big.height, k);
      }
    };
    show();
    // reduced motion: one still frame (forward) plus the static strip
    if (!reduce()) {
      cycleTimer = setInterval(() => {
        k = (k + 1) % ORIENTS.length;
        show();
      }, 3000);
    }
  }

  // ---- wiring ----
  nextBtn.addEventListener("click", goNext);
  backBtn.addEventListener("click", () => {
    if (ready || m.index === 0) return;
    m.back();
    render();
  });
  q(".tour-skip").addEventListener("click", () => {
    m.skip();
    sheet.close();
  });
  camBtn.addEventListener("click", () => hooks.startCamera?.());

  return {
    open() {
      if (sheet.isOpen()) return;
      m.reset();
      ready = false;
      el.hidden = false;
      sheet.open();
      render();
      clearInterval(tickTimer);
      tickTimer = setInterval(tick, 250);
    },
    close() {
      sheet.close();
    },
    isOpen() {
      return sheet.isOpen();
    },
    // once per camera frame while open
    feed({ hasHand, guideStats, hold = 0, rewarded = false, target = null } = {}) {
      if (!sheet.isOpen() || ready) return;
      const s = scene();
      const rose = rewarded && !lastRewarded;
      lastRewarded = rewarded;
      if (s.id === "hand") {
        handFrames = hasHand ? handFrames + 1 : 0;
        if (handFrames >= HAND_FRAMES) succeed();
      } else if (s.id === "colors") {
        const before = JSON.stringify(seen);
        seen = accumulateLegend(seen, guideStats);
        if (JSON.stringify(seen) !== before) {
          for (const li of body.querySelectorAll(".tour-legend li"))
            li.classList.toggle("seen", !!seen[li.dataset.k]);
          if (!m.passed()) {
            const names = LEGEND.filter(([k]) => seen[k]).map(([, , n]) => n.replace(/^\S+ /, ""));
            setStatus(`Seen so far: ${names.join(", ")}`);
          }
        }
        if (legendComplete(seen)) succeed();
      } else if (s.id === "hold") {
        body.querySelector(".tour-ring")?.style.setProperty("--p", String(Math.max(0, Math.min(1, hold))));
        if (rose) succeed();
      } else if (s.id === "first") {
        if (rose && target === "A") succeed();
      }
    },
  };
}

// ---- drawings --------------------------------------------------------

// Scene 2: a "screen" with a person in the middle and the chosen hand raised
// on the same side it will appear on screen (the view is mirrored). null side
// = both hands faint.
function drawMirrorArt(canvas, side) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0b1220";
  ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
  ctx.lineWidth = 2;
  roundRect(ctx, 1, 1, w - 2, h - 2, 14);
  ctx.fill();
  ctx.stroke();
  // head + shoulders
  ctx.fillStyle = "#334155";
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.42, h * 0.15, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 1.02, w * 0.2, h * 0.36, 0, Math.PI, 0);
  ctx.fill();
  for (const s of ["left", "right"]) {
    const on = side === s;
    const box = { x: s === "right" ? w * 0.7 : w * 0.06, y: h * 0.1, w: w * 0.24, h: h * 0.62 };
    // a right hand in the mirrored view: thumb toward the middle of the screen
    const fit = makeFit(NEUTRAL_HAND, box.w, box.h, { pad: 0.08, mirror: s === "right", anchorAt: [0.5, 0.95] });
    const pts = NEUTRAL_HAND.map((p) => {
      const [x, y] = fit(p);
      return [x + box.x, y + box.y];
    });
    drawHandShape(ctx, pts, { alpha: on ? 1 : side ? 0.12 : 0.3, nails: on });
    ctx.fillStyle = on ? "#f8fafc" : "rgba(148, 163, 184, 0.6)";
    ctx.font = `${on ? 800 : 600} ${Math.round(h * 0.085)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(s === "right" ? "your right" : "your left", box.x + box.w / 2, h * 0.9);
  }
}

// no dataset yet: the neutral hand rotated to stand in for each orientation
function drawFallback(ctx, w, h, k) {
  const ang = [0, -Math.PI / 2, Math.PI][k] || 0;
  const c = Math.cos(ang), s = Math.sin(ang);
  const rot = NEUTRAL_HAND.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const fit = makeFit(rot, w, h, { pad: 0.16, anchorAt: [0.5, 0.5], anchorIdx: 9 });
  drawHandShape(ctx, rot.map(fit));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
