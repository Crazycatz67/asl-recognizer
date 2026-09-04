// Component self-test. Imports every module and asserts its public API, then
// runs the live pipeline with a synthetic camera + an injected fake hand.
// Re-run after any change: open tools/selftest.html on the dev server.

const out = document.getElementById("out");
const summary = document.getElementById("summary");
const R = [];
const ok = (name, cond, detail = "") => {
  const line = `${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`;
  R.push(line);
  const span = document.createElement("span");
  span.className = cond ? "PASS" : "FAIL";
  span.textContent = line + "\n";
  out.appendChild(span);
};

// a plausible 21-point open hand for normalize/classify tests
function mkHand() {
  const pts = [{ x: 0.5, y: 0.92, z: 0 }];
  for (let f = 0; f < 5; f++)
    for (let j = 1; j <= 4; j++)
      pts.push({ x: 0.35 + f * 0.07, y: 0.85 - j * 0.16 - f * 0.01, z: -j * 0.03 });
  return pts; // 21
}

(async () => {
  try {
    const cfg = await import("../js/config.js");
    ok("config: MEDIAPIPE_VERSION string", typeof cfg.MEDIAPIPE_VERSION === "string");
    ok("config: LETTERS = 24, no J/Z",
      cfg.LETTERS.length === 24 && !cfg.LETTERS.includes("J") && !cfg.LETTERS.includes("Z"));
    ok("config: USE_EXTENDED_FEATURES is bool", typeof cfg.USE_EXTENDED_FEATURES === "boolean", String(cfg.USE_EXTENDED_FEATURES));
    ok("config: KNN_K odd int", Number.isInteger(cfg.KNN_K) && cfg.KNN_K % 2 === 1, String(cfg.KNN_K));
    ok("config: STABLE_FRAMES / MIN_CONFIDENCE sane",
      cfg.STABLE_FRAMES > 0 && cfg.MIN_CONFIDENCE > 0 && cfg.MIN_CONFIDENCE <= 1);

    const mp = await import("../js/mediapipe.js");
    ok("mediapipe: loadVision() caches", mp.loadVision() === mp.loadVision());
    const vision = await mp.loadVision();
    ok("mediapipe: exposes HandLandmarker + DrawingUtils + FilesetResolver",
      !!vision.HandLandmarker && !!vision.DrawingUtils && !!vision.FilesetResolver);

    const nz = await import("../js/normalize.js");
    const base = nz.normalizeLandmarks(mkHand());
    ok("normalize: base length 63", base.length === 63, `got ${base.length}`);
    ok("normalize: all finite", base.every(Number.isFinite));
    ok("normalize: wrist maps to origin", Math.abs(base[0]) < 1e-6 && Math.abs(base[1]) < 1e-6);
    const ext = nz.normalizeLandmarks(mkHand(), { extended: true });
    ok("normalize: extended length 74", ext.length === 74, `got ${ext.length}`);
    ok("normalize: extended all finite", ext.every(Number.isFinite));
    const mir = nz.normalizeLandmarks(mkHand(), { mirrorX: true });
    ok("normalize: mirrorX flips x sign", Math.sign(mir[3]) === -Math.sign(base[3]) && Math.abs(base[3]) > 1e-9);
    ok("normalize: aspectOf(640x480) ≈ 1.333",
      Math.abs(nz.aspectOf({ videoWidth: 640, videoHeight: 480 }) - 4 / 3) < 1e-6);

    const eqv = (a, b, e = 1e-9) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);
    ok("normalize: rotateVector(v, 0) is identity", eqv(nz.rotateVector(ext, 0), ext));
    const r20 = nz.rotateVector(ext, 20);
    ok("normalize: rotateVector round-trips (20 then -20)", eqv(nz.rotateVector(r20, -20), ext));
    ok("normalize: rotateVector keeps length (74) & finite", r20.length === 74 && r20.every(Number.isFinite));
    ok("normalize: rotateVector preserves per-point radius",
      (() => {
        const rad = (a) => { const o = []; for (let i = 0; i < 21; i++) o.push(Math.hypot(a[i*3], a[i*3+1], a[i*3+2])); return o; };
        return eqv(rad(ext), rad(r20), 1e-9);
      })());
    ok("normalize: rotateVector leaves the 10 distance features unchanged",
      eqv(ext.slice(63, 73), r20.slice(63, 73), 1e-9));

    const cam = await import("../js/camera.js");
    ok("camera: exports present",
      ["startCamera", "stopCamera", "countCameras", "facingOf"].every((k) => typeof cam[k] === "function"));
    ok("camera: facingOf(null) → undefined, no throw",
      (() => { try { return cam.facingOf(null) === undefined; } catch { return false; } })());
    let n; try { n = await cam.countCameras(); } catch { n = "threw"; }
    ok("camera: countCameras() → number", typeof n === "number", String(n));

    const ht = await import("../js/handTracker.js");
    const tracker = await ht.createHandTracker();
    ok("handTracker: { delegate, detect, close }",
      !!tracker.detect && !!tracker.close && ["GPU", "CPU"].includes(tracker.delegate), tracker.delegate);
    const blank = await createImageBitmap(new ImageData(64, 64));
    const dres = tracker.detect(blank, performance.now());
    ok("handTracker: detect on blank → result, 0 hands",
      dres && Array.isArray(dres.landmarks) && dres.landmarks.length === 0);
    tracker.close();
    ok("handTracker: close() no throw", true);

    // ---- skeleton.js (shared drawing) ----
    const sk = await import("../js/skeleton.js");
    ok("skeleton: HAND_CONNECTIONS is 21 edges", sk.HAND_CONNECTIONS.length === 21);
    ok("skeleton: vectorToPixels -> 21 in-bounds points",
      (() => {
        const px = sk.vectorToPixels(new Array(63).fill(0).map(() => Math.random() - 0.5), 200, 200);
        return px.length === 21 && px.every(([x, y]) => x >= 0 && x <= 200 && y >= 0 && y <= 200 && Number.isFinite(x));
      })());

    const ov = await import("../js/overlay.js");
    const cnv = document.createElement("canvas");
    const overlay = ov.createOverlay(cnv);
    overlay.resizeToVideo({ videoWidth: 320, videoHeight: 240 });
    ok("overlay: resizeToVideo sizes the canvas", cnv.width === 320 && cnv.height === 240);
    let threw = false;
    let guideRet;
    try {
      const liveHand = mkHand();
      overlay.clear();
      overlay.drawHands([liveHand]);
      overlay.drawHands([]);
      guideRet = overlay.drawGuide(liveHand, new Array(74).fill(0.1), {
        aspect: 4 / 3, mirror: false, align: 12,
      });
      overlay.drawGuide(liveHand, null); // null target -> no-op
      overlay.drawGuide([], new Array(74).fill(0.1)); // no hand -> no-op
    } catch (e) { threw = e.message; }
    ok("overlay: draw methods (drawHands + drawGuide) no throw", threw === false, threw || "");
    ok("overlay: drawGuide returns null or a worst-joint {part}",
      guideRet === null || (typeof guideRet === "object" && typeof guideRet.part === "string"),
      JSON.stringify(guideRet));
    ok("overlay: drawMotionGuide (J/Z swoosh) doesn't throw",
      (() => {
        try {
          const lh = mkHand();
          overlay.drawMotionGuide(lh, "J", { mirror: true });
          overlay.drawMotionGuide(lh, "Z", { mirror: false });
          overlay.drawMotionGuide([], "J");
          overlay.drawMotionGuide(lh, "B"); // non-motion -> skeleton only
          return true;
        } catch { return false; }
      })());

    const dsm = await import("../js/dataset.js");
    const ds = await dsm.loadDataset("../data/dataset.json?" + Date.now());
    ok("dataset: loads; vectorLength reported", Number.isInteger(ds.vectorLength), `len ${ds.vectorLength}`);
    ok("dataset: > 3000 samples, ≥ 24 labels",
      ds.samples.length > 3000 && ds.labels.length >= 24, `${ds.samples.length} / ${ds.labels.length}`);
    ok("dataset: every v matches vectorLength", ds.samples.every((s) => s.v.length === ds.vectorLength));
    let status; try { await dsm.loadDataset("../data/nope.json"); status = "no throw"; } catch (e) { status = e.status; }
    ok("dataset: missing file → err.status 404", status === 404, String(status));

    const knn = await import("../js/knn.js");
    const keep = new Set(cfg.LETTERS);
    const train = ds.samples.filter((s) => keep.has(s.label)).map((s) => ({ label: s.label, v: s.v }));
    const clf = knn.createClassifier(train, { k: cfg.KNN_K });
    ok("knn: { classify, classes, size, dims }",
      !!clf.classify && clf.dims === ds.vectorLength && clf.classes.length === 24,
      `dims ${clf.dims}, ${clf.classes.length} classes`);
    ok("knn: classes sorted & equal to LETTERS",
      clf.classes.join("") === [...cfg.LETTERS].sort().join(""));
    const p = clf.classify(train[0].v);
    ok("knn: classify → {label,votes,confidence,distance}",
      p && clf.classes.includes(p.label) && p.votes >= 1 && p.votes <= cfg.KNN_K &&
      p.confidence > 0 && p.confidence <= 1 && p.distance >= 0, JSON.stringify(p));
    ok("knn: wrong-length vector → null", clf.classify([1, 2, 3]) === null);
    ok("knn: classify exposes runnerUp + margin", "runnerUp" in p && typeof p.margin === "number");
    ok("knn: empty sample set → throws",
      (() => { try { knn.createClassifier([]); return false; } catch { return true; } })());

    // ---- refine.js (tie-breaker) ----
    const refm2 = await import("../js/refine.js");
    const refiner = refm2.createRefiner(train);
    ok("refine: D↔O rule learned (separation ≥ 0.75)",
      refiner.rules.some((r) => r.pair.includes("D") && r.pair.includes("O") && r.sepAcc >= 0.75),
      "rules: " + refiner.rules.map((r) => `${r.pair.join("↔")}@${r.sepAcc.toFixed(2)}`).join(", "));
    ok("refine: NO M↔N rule (not separable)",
      !refiner.rules.some((r) => r.pair.includes("M") && r.pair.includes("N")));
    ok("refine: passes through a confident prediction unchanged",
      (() => { const q = { label: "A", runnerUp: "B", margin: 4 }; return refiner.refine(q, train[0].v) === q; })());
    ok("refine: only touches D/O when they're the thin top-2",
      (() => {
        const q = { label: "D", runnerUp: "O", margin: 1, votes: 3, confidence: 0.6, distance: 0.1 };
        const out = refiner.refine(q, train.find((s) => s.label === "O").v);
        return out.label === "O" && out.refinedBy;
      })());

    // ---- heads.js (learned M/N + D/O/C refinement) ----
    const headsMod = await import("../js/heads.js");
    const head = await headsMod.loadRefiner("../js/heads.json?" + Date.now());
    ok("heads: loadRefiner returns a refiner covering M/N/D/O/C",
      head && head.covers.includes("M") && head.covers.includes("N") &&
      head.covers.includes("D") && head.covers.includes("O"),
      head ? head.covers.join("") : "null");
    ok("heads: passes a non-covered label straight through",
      head.refine(train[0].v, "A") === "A");
    ok("heads: fixes an M/N mix — real N samples the head calls N when kNN said M",
      (() => {
        const ns = ds.samples.filter((s) => s.label === "N" && !s.rot).slice(0, 40);
        let asN = 0;
        for (const s of ns) if (head.refine(s.v, "M") === "N") asN++;
        return asN / ns.length >= 0.75; // head recovers the N-ness of most Ns
      })());
    ok("heads: a real D the head keeps as D even when kNN guessed O",
      (() => {
        const dss = ds.samples.filter((s) => s.label === "D" && !s.rot).slice(0, 30);
        let asD = 0;
        for (const s of dss) if (head.refine(s.v, "O") === "D") asD++;
        return asD / dss.length >= 0.7;
      })());
    ok("heads: createRefiner tolerates junk", headsMod.createRefiner({}) === null);

    const st = await import("../js/stabilizer.js");
    const stab = st.createStabilizer({ stableFrames: cfg.STABLE_FRAMES, minConfidence: cfg.MIN_CONFIDENCE });
    let confAt = -1;
    for (let i = 0; i < cfg.STABLE_FRAMES; i++) {
      const c = stab.push({ label: "M", confidence: 1 });
      if (c === "M" && confAt < 0) confAt = i;
    }
    ok("stabilizer: confirms at exactly STABLE_FRAMES", confAt === cfg.STABLE_FRAMES - 1,
      `frame ${confAt + 1}/${cfg.STABLE_FRAMES}`);
    stab.push({ label: "N", confidence: 0.3 });
    ok("stabilizer: low-confidence keeps last confirmed", stab.current === "M");
    stab.reset();
    ok("stabilizer: reset() clears", stab.current === null && stab.candidate === null);

    // ---- reference.js (practice mode) ----
    const refm = await import("../js/reference.js");
    const ref = refm.buildReference(train, cfg.LETTERS);
    ok("reference: letters == 24 present classes", ref.letters.length === clf.classes.length);
    const cN = ref.centroid("N");
    ok("reference: centroid('N') is a vlen vector", Array.isArray(cN) && cN.length === ds.vectorLength && cN.every(Number.isFinite));
    ok("reference: centroid scores ~1 against itself",
      (() => { const s = ref.score(cN, "N"); return s.score > 0.95 && s.bucket === "correct"; })(),
      JSON.stringify(ref.score(cN, "N")));
    ok("reference: 'correct' is reachable by a real training sample",
      (() => {
        const nSample = train.find((s) => s.label === "N" && !s.rot);
        return ref.score(nSample.v, "N").bucket !== "off"; // a typical N should not read as "off"
      })());
    ok("reference: a different letter's centroid scores lower for N",
      ref.score(ref.centroid("A"), "N").score < ref.score(cN, "N").score);
    ok("reference: unknown target -> safe zero", ref.score(cN, "ZZ").score === 0);
    // regression: skeleton fully green (x/y within tolerance) + heavy z noise
    // must still read "correct" — z is a noisy MediaPipe guess and used to
    // stall the meter at "close" even with a perfect on-screen match.
    ok("reference: x/y-matched hand with noisy z still scores 'correct'",
      (() => {
        const c = ref.centroid("B"), tol = ref.tolerance("B"), v = c.slice();
        for (let j = 0; j < 21; j++) {
          v[j * 3] += (j % 2 ? 1 : -1) * tol * 0.6;
          v[j * 3 + 1] += (j % 3 ? 1 : -1) * tol * 0.6;
          v[j * 3 + 2] += (j % 2 ? 1 : -1) * 0.25; // way outside any tolerance
        }
        return ref.score(v, "B").bucket === "correct";
      })());
    ok("reference: tolerance('N') is a small positive number",
      (() => { const t = ref.tolerance("N"); return t > 0 && t < 0.3; })(), String(ref.tolerance("N")));
    ok("reference: a readable-but-imperfect hand scores 'correct' (~1.4x tol)",
      (() => {
        const c = ref.centroid("C"), tol = ref.tolerance("C"), v = c.slice();
        for (let j = 0; j < 21; j++) {
          v[j * 3] += (j % 2 ? 1 : -1) * tol * 1.0;
          v[j * 3 + 1] += (j % 3 ? 1 : -1) * tol * 1.0; // ~1.4x tol per joint
        }
        return ref.score(v, "C").bucket === "correct";
      })());
    ok("reference: a clearly-wrong finger still fails (several x tol)",
      (() => {
        const c = ref.centroid("C"), tol = ref.tolerance("C"), v = c.slice();
        v[8 * 3] += tol * 4; v[8 * 3 + 1] += tol * 4; // index tip way off
        return ref.score(v, "C").bucket !== "correct";
      })());
    ok("reference: alignDeg detects a small tilt and stays clamped",
      (() => {
        const tilted = ref.centroid("B").slice();
        const a = (15 * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
        for (let j = 0; j < 21; j++) {
          const x = tilted[j * 3], y = tilted[j * 3 + 1];
          tilted[j * 3] = x * cs - y * sn;
          tilted[j * 3 + 1] = x * sn + y * cs;
        }
        const deg = ref.alignDeg(tilted, "B");
        return Math.abs(deg) <= 22 && Math.abs(deg) > 5;
      })(), String(ref.alignDeg(cN, "N")));
    ok("reference: a mildly tilted centroid still scores 'correct' (tilt forgiven)",
      (() => {
        const tilted = ref.centroid("B").slice();
        const a = (14 * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
        for (let j = 0; j < 21; j++) {
          const x = tilted[j * 3], y = tilted[j * 3 + 1];
          tilted[j * 3] = x * cs - y * sn;
          tilted[j * 3 + 1] = x * sn + y * cs;
        }
        return ref.score(tilted, "B").bucket === "correct";
      })());
    ok("reference: the MIRROR of a letter's own shape still scores 'correct'",
      (() => {
        const mv = ref.centroid("R").slice(); // R is clearly not mirror-symmetric
        for (let j = 0; j < 21; j++) mv[j * 3] = -mv[j * 3];
        const s = ref.score(mv, "R");
        return s.bucket === "correct" && s.mirrored === true;
      })(), JSON.stringify(ref.score((() => { const m = ref.centroid("R").slice(); for (let j = 0; j < 21; j++) m[j * 3] = -m[j * 3]; return m; })(), "R")));
    ok("reference: orient() reports {mirrored, deg}",
      (() => {
        const o = ref.orient(cN, "N");
        return typeof o.mirrored === "boolean" && typeof o.deg === "number";
      })());
    // the hand-orientation chain the on-camera guide depends on: a canonical
    // (right-hand-normalised) shape must resolve un-mirrored; its x-flip must
    // resolve mirrored; a small tilt must come back as a same-sign correction.
    ok("reference: orient() distinguishes canonical vs mirrored vs tilted (G/H/P)",
      ["G", "H", "P"].every((L) => {
        const c = ref.centroid(L);
        const oC = ref.orient(c, L);
        const m = c.slice(); for (let j = 0; j < 21; j++) m[j * 3] = -m[j * 3];
        const oM = ref.orient(m, L);
        const t = c.slice();
        const a = (12 * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
        for (let j = 0; j < 21; j++) {
          const x = t[j * 3], y = t[j * 3 + 1];
          t[j * 3] = x * cs - y * sn; t[j * 3 + 1] = x * sn + y * cs;
        }
        const oT = ref.orient(t, L);
        return oC.mirrored === false && oM.mirrored === true &&
          oT.mirrored === false && Math.round(oT.deg) === -12;
      }));
    ok("reference: hint() on the centroid says it's right",
      /hold it steady/i.test(ref.hint(cN, "N")), JSON.stringify(ref.hint(cN, "N")));
    ok("reference: hint() on a wrong hand gives an instruction",
      (() => {
        const h = ref.hint(ref.centroid("A"), "N");
        return typeof h === "string" && h.length > 4 && !/hold it steady/i.test(h);
      })(), JSON.stringify(ref.hint(ref.centroid("A"), "N")));
    ok("reference: drawCanonical renders without throwing",
      (() => {
        try {
          const c = document.createElement("canvas");
          c.width = 200; c.height = 200;
          refm.drawCanonical(c, cN);
          refm.drawCanonical(c, null); // no-op
          return true;
        } catch { return false; }
      })());
    ok("reference: describe() returns a sentence for every letter",
      ref.letters.every((L) => {
        const d = ref.describe(L);
        return typeof d === "string" && d.length > 25;
      }));
    ok("reference: createCanonicalPlayer setTarget/redraw/stop don't throw",
      (() => {
        try {
          const c = document.createElement("canvas");
          c.width = 160; c.height = 160;
          const p = refm.createCanonicalPlayer(c);
          p.setTarget(cN);
          p.redraw();
          p.setTarget(null);
          p.stop();
          return typeof p.setTarget === "function";
        } catch (e) { return false; }
      })());

    // ---- sound.js + fx.js (juice) ----
    const snd = (await import("../js/sound.js")).createSound();
    ok("sound: createSound exposes the API",
      typeof snd.resume === "function" && typeof snd.success === "function" &&
      typeof snd.setMuted === "function" && typeof snd.muted === "boolean" &&
      typeof snd.charge === "function");
    ok("sound: mute round-trips", (() => { const was = snd.muted; snd.setMuted(!was); const ok = snd.muted === !was; snd.setMuted(was); return ok; })());
    ok("sound: calls are safe with no audio unlocked",
      (() => { try { snd.select(); snd.lock(); snd.charge(0.5); snd.charge(0); snd.success(); return true; } catch { return false; } })());

    // ---- motion.js (J / Z tracing) ----
    const motMod = await import("../js/motion.js");
    ok("motion: STROKE has J + Z polylines", Array.isArray(motMod.STROKE.J) && Array.isArray(motMod.STROKE.Z));
    // build a fake hand: pinky tip and index tip at wrist-relative positions
    // (units ~span). Everything else fixed so span + finger geometry are stable.
    const fakeHand = (pinkyRel, indexRel) => {
      const S = 0.1, wx = 0.5, wy = 0.55;
      const lm = [];
      for (let i = 0; i < 21; i++) lm.push({ x: wx, y: wy - 0.03, z: 0 });
      lm[0] = { x: wx, y: wy, z: 0 };
      lm[5] = { x: wx - 0.04, y: wy - 0.09, z: 0 };
      lm[9] = { x: wx, y: wy - 0.10, z: 0 };
      lm[13] = { x: wx + 0.04, y: wy - 0.09, z: 0 };
      lm[17] = { x: wx + 0.06, y: wy - 0.07, z: 0 };
      lm[20] = { x: wx + pinkyRel[0] * S, y: wy + pinkyRel[1] * S, z: 0 };
      lm[8] = { x: wx + indexRel[0] * S, y: wy + indexRel[1] * S, z: 0 };
      return lm;
    };
    ok("motion: a J-shaped pinky path fires 'J'", (() => {
      const mm = motMod.createMotionMatcher();
      const idxCurl = [-0.4, -0.3]; // index near its MCP -> not "up"
      // pinky (extended) sweeps: up -> down -> hook back
      const path = [
        [0.2, -2.4], [0.8, -1.6], [1.6, -0.6], [2.0, 0.6],
        [1.8, 1.6], [2.0, 2.1], [0.6, 2.0], [-0.6, 1.7],
      ];
      let out = null;
      path.forEach((p, i) => { mm.push(fakeHand(p, idxCurl), i * 90); out = mm.match(i * 90) || out; });
      return out === "J";
    })());
    ok("motion: a zigzag index path fires 'Z'", (() => {
      const mm = motMod.createMotionMatcher();
      const pinkyCurl = [0.3, -0.3];
      // index (extended) zigzags: right -> down-left -> right
      const path = [
        [-2.2, -2.0], [-0.7, -2.0], [0.9, -2.0], [2.2, -2.0],
        [0.7, -0.9], [-0.9, 0.0], [-2.2, 0.1],
        [-0.7, 0.1], [0.9, 0.1], [2.2, 0.1],
      ];
      let out = null;
      path.forEach((p, i) => { mm.push(fakeHand(pinkyCurl, p), i * 90); out = mm.match(i * 90) || out; });
      return out === "Z";
    })());
    ok("motion: a still hand fires nothing", (() => {
      const mm = motMod.createMotionMatcher();
      for (let i = 0; i < 16; i++) mm.push(fakeHand([0.2, -2.4], [-0.4, -0.3]), i * 90);
      return mm.match(16 * 90) === null;
    })());
    ok("motion: push(null) / reset() don't throw",
      (() => { try { const mm = motMod.createMotionMatcher(); mm.push(null, 0); mm.reset(); return mm.match(1) === null; } catch { return false; } })());

    // ---- challenge.js (speed game) ----
    const gameMod = await import("../js/challenge.js");
    ok("challenge: study -> go -> play -> win, then 3 misses -> over", (() => {
      try {
        const g = gameMod.createChallenge({ letters: ["A", "B", "C"] });
        g.start(0);
        let t = 0;
        let s = g.update(t, null);
        if (s.phase !== "study" || s.event !== "letter" || s.lives !== 3) return false;
        // advance until we're in "play", stepping big
        const toPlay = () => {
          for (let i = 0; i < 8 && g.phase !== "play"; i++) s = g.update((t += 3000), null);
        };
        toPlay();
        if (s.phase !== "play") return false;
        s = g.update((t += 100), s.letter); // sign the right letter -> win
        if (s.event !== "win" || s.score <= 0 || s.streak !== 1) return false;
        // three timeouts drain the lives
        for (let life = 2; life >= 0; life--) {
          toPlay();
          s = g.update((t += 90000), null); // timeout
          if (life > 0 && (s.event !== "miss" || s.lives !== life)) return false;
        }
        return s.phase === "over" && s.event === "over" && s.lives === 0
          && s.best === s.score && typeof s.missedLetter === "string";
      } catch (e) { return false; }
    })());
    ok("challenge: skip() spends a life and jumps ahead", (() => {
      try {
        const g = gameMod.createChallenge({ letters: ["A", "B", "C"] });
        g.start(0);
        g.update(0, null); g.update(5000, null); g.update(6000, null); // -> play
        g.skip();
        const s = g.update(6100, null);
        return s.event === "miss" && s.lives === 2 && s.phase === "miss";
      } catch (e) { return false; }
    })());
    ok("challenge: a wrong recognised letter never advances the round",
      (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B"] });
        g.start(0);
        let s = g.update(0, null);
        const wrong = s.letter === "A" ? "B" : "A";
        g.update(5000, null); g.update(6000, null); // -> play
        for (let k = 0; k < 20; k++) s = g.update(6000 + k * 50, wrong);
        return s.phase === "play" && s.score === 0;
      })());
    ok("challenge: stop() ends it and update() returns null",
      (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B"] });
        g.start(0); g.stop();
        return g.active === false && g.update(1, "A") === null;
      })());

    // ---- speller.js (continuous fingerspelling -> text) ----
    const spMod = await import("../js/speller.js");
    // hold a letter = many frames of {holding:true}; a gap = frames of not-holding
    const hold = (sp, L, t0, frames = 4) => {
      let t = t0, r;
      for (let i = 0; i < frames; i++) r = sp.feed({ holding: true, letter: L, handPresent: true, moved: false, now: t += 40 });
      return { r, t };
    };
    const gap = (sp, t0, ms) => {
      let t = t0;
      const end = t0 + ms;
      while (t < end) sp.feed({ holding: false, letter: null, handPresent: true, moved: false, now: t += 40 });
      return t;
    };
    ok("speller: distinct letters spell a word (CAT)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "C", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "A", t));
      t = gap(sp, t, 120); ({ t } = hold(sp, "T", t));
      return sp.text === "CAT";
    })());
    ok("speller: a held letter commits once, not every frame", (() => {
      const sp = spMod.createSpeller();
      hold(sp, "E", 0, 30);
      return sp.text === "E";
    })());
    ok("speller: a doubled letter needs a real gap (BOOK)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "B", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "O", t));
      // no real gap -> the second O must NOT register
      ({ t } = hold(sp, "O", t));
      const oneO = sp.text === "BO";
      // now a clear gap, then O again -> BOO
      t = gap(sp, t, 500); ({ t } = hold(sp, "O", t));
      t = gap(sp, t, 120); ({ t } = hold(sp, "K", t));
      return oneO && sp.text === "BOOK";
    })());
    ok("speller: a long pause inserts one space (not two)", (() => {
      const sp = spMod.createSpeller();
      let u = hold(sp, "H", 0).t;
      u = gap(sp, u, 120); u = hold(sp, "I", u).t;
      u = gap(sp, u, 1500); // long pause -> a space
      u = gap(sp, u, 1500); // still just one space
      u = hold(sp, "U", u).t;
      return sp.text === "HI U";
    })());
    ok("speller: J/Z strokes append and can repeat (JAZZ)", (() => {
      const sp = spMod.createSpeller();
      let t = 40;
      sp.feed({ holding: false, letter: null, stroke: "J", handPresent: true, moved: false, now: t }); t += 200;
      ({ t } = hold(sp, "A", t)); t = gap(sp, t, 120);
      sp.feed({ holding: false, letter: null, stroke: "Z", handPresent: true, moved: false, now: t }); t += 200;
      sp.feed({ holding: false, letter: null, stroke: "Z", handPresent: true, moved: false, now: t });
      return sp.text === "JAZZ";
    })());
    ok("speller: backspace / clear / manual space", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "A", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "B", t));
      sp.backspace();
      const afterBack = sp.text === "A";
      sp.space();
      const afterSpace = sp.text === "A ";
      sp.clear();
      return afterBack && afterSpace && sp.text === "";
    })());

    const fx = (await import("../js/fx.js")).createFx();
    ok("fx: createFx returns burst + flash",
      typeof fx.burst === "function" && typeof fx.flash === "function");
    ok("fx: burst + flash don't throw",
      (() => { try { fx.burst(100, 100); fx.flash("#22c55e"); return true; } catch { return false; } })());

    const bg = (await import("../js/bg.js")).createBackground();
    ok("bg: createBackground returns setMatch + stop",
      typeof bg.setMatch === "function" && typeof bg.stop === "function");
    ok("bg: setMatch tolerates all inputs (incl. regions)",
      (() => { try { bg.setMatch(0.3, "off", { top: 0.8, left: 0.1, right: 0.4 }); bg.setMatch(0.7, "close"); bg.setMatch(1, "correct", {}); bg.setMatch(null, null); return true; } catch { return false; } })());
    ok("reference: regionErrors -> {top,left,right} in 0..1",
      (() => {
        const r = ref.regionErrors(ref.centroid("A"), "N"); // wrong shape
        const on = ref.regionErrors(cN, "N"); // on target
        const ok0 = ["top", "left", "right"].every((k) => r[k] >= 0 && r[k] <= 1 && on[k] >= 0 && on[k] <= 1);
        const onTarget = on.top + on.left + on.right < r.top + r.left + r.right; // wrong hand should score higher
        return ok0 && onTarget;
      })());
    ok("bg: mounts a canvas behind content (z-index -1)",
      (() => { const c = [...document.querySelectorAll("canvas")].find((x) => x.style.zIndex === "-1"); return !!c; })());
    bg.stop();

    // ---- config practice knobs ----
    ok("config: REFERENCE_IMG builds a path", cfg.REFERENCE_IMG("N") === "assets/reference/N.jpg");

    // ---- integration ----
    const liveVec = nz.normalizeLandmarks(mkHand(), { extended: cfg.USE_EXTENDED_FEATURES, aspect: 4 / 3 });
    ok("integration: live-shaped vector classifies to a real letter",
      (() => { const q = clf.classify(liveVec); return q && clf.classes.includes(q.label); })());
    ok("integration: reference.score works on a live-shaped vector",
      (() => { const s = ref.score(liveVec, "A"); return s.score >= 0 && s.score <= 1 && ["off","close","correct"].includes(s.bucket); })());
  } catch (e) {
    const span = document.createElement("span");
    span.className = "FATAL";
    span.textContent = "FATAL: " + (e.stack || e);
    out.appendChild(span);
    R.push("FATAL");
  }

  const fails = R.filter((l) => l.startsWith("FAIL") || l.startsWith("FATAL")).length;
  summary.textContent = `${R.length} checks — ${fails === 0 ? "ALL PASS ✅" : fails + " FAILING ❌"}`;
  summary.style.color = fails === 0 ? "#22c55e" : "#f87171";
})();
