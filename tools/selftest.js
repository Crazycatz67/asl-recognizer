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
    ok("skeleton: drawHandShape renders a solid hand without throwing", (() => {
      const c = document.createElement("canvas");
      c.width = c.height = 200;
      const ctx = c.getContext("2d");
      const px = sk.vectorToPixels(new Array(63).fill(0).map(() => Math.random() - 0.5), 200, 200);
      try {
        sk.drawHandShape(ctx, px);
        sk.drawHandShape(ctx, px, { alpha: 0.2, nails: false });
        sk.drawHandShape(ctx, null); // no-op, no throw
        // it drew *something* — at least one non-transparent pixel
        const data = ctx.getImageData(0, 0, 200, 200).data;
        let painted = false;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) { painted = true; break; }
        return painted;
      } catch { return false; }
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
    // Stage 7c: colour-blind-safer ramp + redundant (non-colour) encoding
    ok("overlay: guideState splits good / close / fix at tol and mid-band",
      ov.guideState(0.05, 0.06, 0.36) === "good" &&
      ov.guideState(0.06, 0.06, 0.36) === "good" &&
      ov.guideState(0.10, 0.06, 0.36) === "close" &&
      ov.guideState(0.30, 0.06, 0.36) === "fix" &&
      ov.guideState(9, 0.06, 0.36) === "fix");
    ok("overlay: errRGB is orange at the low end, magenta at the high end, never green/red",
      (() => {
        const lo = ov.errRGB(0), hi = ov.errRGB(1), mid = ov.errRGB(0.5);
        const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
        const noGreen = [lo, mid, hi].every((c) => !(c[1] > c[0] && c[1] > c[2]));
        return same(lo, ov.GUIDE_RGB.close) && same(hi, ov.GUIDE_RGB.fix) &&
          same(ov.errRGB(-3), lo) && same(ov.errRGB(7), hi) && noGreen;
      })());
    ok("overlay: each guide state has a distinct glyph (✓ ~ ✕)",
      new Set(["good", "close", "fix"].map((k) => ov.GUIDE_GLYPH[k])).size === 3);
    ok("overlay: guideStats() reports 5 fingertip states + counts after drawGuide, null after a no-op",
      (() => {
        overlay.drawGuide(mkHand(), new Array(74).fill(0.1), { aspect: 4 / 3, reveal: 1 });
        const s = overlay.guideStats();
        const good = s && s.tips.length === 5 &&
          s.tips.every((t) => ["good", "close", "fix"].includes(t)) &&
          s.counts.good + s.counts.close + s.counts.fix === 5 && s.shown === true;
        overlay.drawGuide(mkHand(), null);
        return good && overlay.guideStats() === null;
      })());
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
    {
      // wrong handedness mirrors the vector: classifyEitherHand must recover
      // the letter, and must not change the answer on correctly-oriented input
      const nzm = await import("../js/normalize.js");
      const sample = train.filter((_, i) => i % 25 === 0);
      let plainMir = 0, eitherMir = 0, agree = 0;
      for (const s of sample) {
        const mv = nzm.mirrorVector(s.v);
        if (clf.classify(mv)?.label === s.label) plainMir++;
        if (knn.classifyEitherHand(clf, mv, nzm.mirrorVector).pred?.label === s.label) eitherMir++;
        if (knn.classifyEitherHand(clf, s.v, nzm.mirrorVector).pred?.label === clf.classify(s.v)?.label) agree++;
      }
      ok("knn: classifyEitherHand recovers mirrored (wrong-handedness) input without changing normal input",
        eitherMir / sample.length > 0.95 && eitherMir > plainMir && agree === sample.length,
        `mirrored: plain ${plainMir}/${sample.length} -> either ${eitherMir}/${sample.length}; unchanged ${agree}/${sample.length}`);
    }
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
    // 2026-09-24: the live guide must agree with the scorer about a TILTED
    // hand. reference.score() rotates the live hand by +deg; the guide draws
    // the letter in the live frame, so it must rotate the target by -deg
    // (unless the target is mirrored). The old +deg drew the ghost 2x the
    // tilt off, so a hand the meter called matched still showed red tips.
    // 2026-09-24: ONE per-joint verdict (js/jointstate.js) drives the colours
    // on the hand AND whether the sign counts — with room for user error.
    {
      const L = "B", aspect = 4 / 3, c = ref.centroid(L);
      const toLm = (v) => Array.from({ length: 21 }, (_, i) => ({ x: 0.5 + (v[i * 3] * 0.2) / aspect, y: 0.55 + v[i * 3 + 1] * 0.2, z: v[i * 3 + 2] * 0.2 }));
      const nudge = (joints, amt) => { const v = c.slice(); for (const j of joints) v[j * 3] += amt; return v; };
      const scoreOf = (v) => ref.score(nz.normalizeLandmarks(toLm(v), { extended: cfg.USE_EXTENDED_FEATURES, aspect }), L);
      ok("jointstate: overlay colours == scorer's per-joint states (colours can't disagree with the verdict)", (() => {
        const v = nudge([8, 12], 0.35);
        const lm = toLm(v);
        const m = ref.score(nz.normalizeLandmarks(lm, { extended: cfg.USE_EXTENDED_FEATURES, aspect }), L);
        overlay.drawGuide(lm, c, { aspect, tol: m.tol, errors: m.errors, reveal: 1 });
        const g = overlay.guideStats()?.joints;
        return g && g.good === m.counts.good && g.close === m.counts.close && g.fix === m.counts.fix;
      })());
      ok("jointstate: a few joints slightly off still counts (room for user error)", (() => {
        const m = scoreOf(nudge([4, 8], 0.4));
        return m.bucket === "correct" && m.counts.close >= 1 && m.counts.fix === 0;
      })());
      ok("jointstate: one clearly wrong finger (a magenta joint) does not count", (() => {
        const m = scoreOf(nudge([8], 0.9));
        return m.counts.fix >= 1 && m.bucket !== "correct";
      })());
      ok("jointstate: a look-alike's shape doesn't count as the target (N's shape scored as M)", (() => {
        const m = ref.score(ref.centroid("N"), "M");
        return m.bucket !== "correct" && m.confusedWith === "N";
      })());
    }
    ok("overlay+reference: a hand tilted to exactly match a letter draws every joint 'good' (guide rotation sign)", (() => {
      const L = "L", aspect = 4 / 3, c = ref.centroid(L);
      const results = [];
      for (const deg of [14, -14]) {
        const t = (-deg * Math.PI) / 180, cs = Math.cos(t), sn = Math.sin(t);
        const lm = [];
        for (let i = 0; i < 21; i++) {
          const x = c[i * 3], y = c[i * 3 + 1];
          lm.push({ x: 0.5 + ((x * cs - y * sn) * 0.2) / aspect, y: 0.55 + (x * sn + y * cs) * 0.2, z: c[i * 3 + 2] * 0.2 });
        }
        const vec = nz.normalizeLandmarks(lm, { extended: cfg.USE_EXTENDED_FEATURES, aspect });
        const o = ref.orient(vec, L);
        const draw = (align) => {
          overlay.drawGuide(lm, c, { aspect, mirror: o.mirrored, tol: ref.matchTolerance(L), align, reveal: 1 });
          return overlay.guideStats()?.joints?.good ?? -1;
        };
        const fixed = draw(o.mirrored ? o.deg : -o.deg), old = draw(o.deg);
        results.push({ deg: o.deg, mirrored: o.mirrored, fixed, old });
      }
      return results.every((r) => Math.abs(r.deg) > 5 && r.fixed === 21 && r.old < 21) ? true : (console.log(results), false);
    })());
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
    // regression: the live guide overlay colours a joint green using
    // matchTolerance(), NOT tolerance() — they must agree with score()'s own
    // "correct" cutoff (1.8x tolerance) or the guide flags joints yellow that
    // the meter already calls correct (real bug from user QA).
    ok("reference: matchTolerance('N') is tolerance('N') widened by score()'s own correct-cutoff factor",
      (() => {
        const t = ref.tolerance("N"), m = ref.matchTolerance("N");
        return m > t && Math.abs(m - t * 2.6) < 1e-9; // MATCH_TOL_MULT (2.6 since 2026-09-24)
      })(), `tolerance=${ref.tolerance("N")} matchTolerance=${ref.matchTolerance("N")}`);
    ok("reference: a joint just inside matchTolerance scores 'correct' AND would be drawn green",
      (() => {
        const c = ref.centroid("B"), mt = ref.matchTolerance("B"), v = c.slice();
        // push exactly one joint (index tip) to 95% of matchTolerance, on one axis
        // only, so its OWN error stays under matchTolerance (what the overlay
        // checks per-joint) while the shape still counts as correct overall.
        v[8 * 3] += mt * 0.95;
        const s = ref.score(v, "B");
        const jointErr = Math.hypot(v[8 * 3] - c[8 * 3], v[8 * 3 + 1] - c[8 * 3 + 1]);
        return s.bucket === "correct" && jointErr <= mt;
      })());
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
    // Stage 7e: every description leads with orientation, and never says the
    // ambiguous "sideways"
    ok("reference: all 26 LETTER_GUIDE entries lead with palm/finger direction, no 'sideways'",
      (() => {
        const { LETTER_GUIDE } = refm;
        const keys = Object.keys(LETTER_GUIDE);
        const bad = keys.filter((L) =>
          !/^(Palm faces|Fingers point|Start with)/.test(LETTER_GUIDE[L]) || /sideways/i.test(LETTER_GUIDE[L]));
        return keys.length === 26 && bad.length === 0;
      })());
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
    ok("reference: createCanonicalPlayer setWord (S2e) doesn't throw — plain run, a doubled letter, empty/null", () => {
      try {
        const c = document.createElement("canvas");
        c.width = 160; c.height = 160;
        const p = refm.createCanonicalPlayer(c);
        // "CAT" — a plain coarticulated run
        p.setWord(
          ["C", "A", "T"].map((L) => ({ letter: L, vec: ref.centroid(L) })),
          { holdMs: 500 }
        );
        p.redraw();
        // "BOO" — a doubled letter (O-O) mid-run needs the wrist-bounce path,
        // not a bone-space blend toward an identical pose
        p.setWord(["B", "O", "O"].map((L) => ({ letter: L, vec: ref.centroid(L) })));
        p.setWord([]); // empty clears cleanly, same as setTarget(null)
        p.setWord(null);
        p.stop();
        return true;
      } catch (e) { return false; }
    });
    ok("reference: createCanonicalPlayer pause/resume/seek/wordInfo (S3 transport)", () => {
      try {
        const c = document.createElement("canvas");
        c.width = 160; c.height = 160;
        const p = refm.createCanonicalPlayer(c);
        // no word playing yet — every transport call should be a safe no-op
        p.pause(); p.resume(); p.seek(100);
        const noInfo = p.wordInfo() === null && p.isPaused() === false;

        p.setWord(
          ["C", "A", "T"].map((L) => ({ letter: L, vec: ref.centroid(L) })),
          { holdMs: 500 }
        );
        const info = p.wordInfo();
        const infoOk = info && info.totalMs === 1500 && info.letterStarts.length === 3 &&
          info.letterStarts.every((ms, i) => i === 0 || ms > info.letterStarts[i - 1]);

        p.pause();
        const pausedOk = p.isPaused() === true;
        p.seek(750); // scrub while paused — should repaint without unpausing
        const stillPaused = p.isPaused() === true;
        p.resume();
        const resumedOk = p.isPaused() === false;
        p.seek(2000); // past the end — should clamp, not throw
        const elapsedOk = p.elapsedMs() <= 1500 + 1; // clamped to totalMs, not 2000
        p.stop();
        return noInfo && infoOk && pausedOk && stillPaused && resumedOk && elapsedOk;
      } catch (e) { return false; }
    });

    // ---- sound.js + fx.js (juice) ----
    const snd = (await import("../js/sound.js")).createSound();
    ok("sound: createSound exposes the API",
      typeof snd.resume === "function" && typeof snd.success === "function" &&
      typeof snd.setMuted === "function" && typeof snd.muted === "boolean" &&
      typeof snd.charge === "function");
    ok("sound: mute round-trips", (() => { const was = snd.muted; snd.setMuted(!was); const ok = snd.muted === !was; snd.setMuted(was); return ok; })());
    ok("sound: calls are safe with no audio unlocked",
      (() => { try { snd.select(); snd.lock(); snd.charge(0.5); snd.charge(0); snd.success(); return true; } catch { return false; } })());

    ok("sound: varied cues accept their new optional args (and still work bare)",
      (() => { try {
        snd.success({ step: 3, tier: "first" }); snd.success({ tier: "mastery" }); snd.success({ mode: "drill", step: 2 });
        snd.lock(2); snd.lock(); snd.word(); snd.correct(4); snd.correct(); snd.hit(3); snd.hit();
        return true; } catch { return false; } })());

    // ---- juice.js (reward variation helpers, pure) ----
    const juice = await import("../js/juice.js");
    ok("juice: createPicker never repeats back-to-back and uses every variant", (() => {
      const p = juice.createPicker(3); let prev = -1; const seen = new Set();
      for (let i = 0; i < 300; i++) { const v = p(); if (v === prev || v < 0 || v > 2) return false; prev = v; seen.add(v); }
      return seen.size === 3 && juice.createPicker(1)() === 0;
    })());
    ok("juice: scaleStep walks C-major pentatonic across octaves",
      [-1, 0, 1, 4, 5, 7].map((k) => juice.scaleStep(k)).join() === "-3,0,2,9,12,16");
    ok("juice: rewardTier first / letter / mastery",
      juice.rewardTier(0, 1) === "first" && juice.rewardTier(1, 2) === "letter" &&
      juice.rewardTier(2, 3) === "mastery" && juice.rewardTier(5, 6) === "letter" && juice.rewardTier(0, 1, 1) === "mastery");
    ok("juice: nextRun extends inside the window, restarts outside it",
      juice.nextRun(3, 0, 1000) === 4 && juice.nextRun(3, 0, 60000) === 1 && juice.nextRun(0, null, 10) === 1);
    ok("juice: climb caps, celebrationPlan scales with tier + run and stays bounded", (() => {
      const a = juice.celebrationPlan("letter", 1), b = juice.celebrationPlan("letter", 5);
      const f = juice.celebrationPlan("first", 1), m = juice.celebrationPlan("mastery", 50);
      return juice.climb(1) === 0 && juice.climb(99) === 4 && b.particles > a.particles &&
        f.particles > a.particles && f.moment === "first" && m.moment === "mastery" &&
        m.particles <= 72 && m.rings <= 3 && a.moment === null;
    })());
    ok("juice: glowLevel 0 below x2, capped at 3",
      juice.glowLevel(0) === 0 && juice.glowLevel(1) === 0 && juice.glowLevel(2) === 1 && juice.glowLevel(4) === 3 && juice.glowLevel(10) === 3);

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
    // J/Z strokes on a synthetic hand (tools/synth-hand.js): real strokes fire
    // once; the live-QA false positives (tilting / relaxing an I, a straight
    // drop, a wave, one wag, far-away jitter) fire nothing
    {
      const synth = await import("./synth-hand.js");
      for (const sc of synth.motionScenarios()) {
        for (const aspect of [1, 16 / 9]) {
          const hits = synth.runScenario(motMod.createMotionMatcher, sc, aspect);
          ok(`motion: ${sc.name} @${aspect === 1 ? "1:1" : "16:9"} -> ${sc.expect || "nothing"}`,
            JSON.stringify(hits) === JSON.stringify(sc.expect ? [sc.expect] : []), JSON.stringify(hits));
        }
      }
    }
    ok("motion: a still hand fires nothing", (() => {
      const mm = motMod.createMotionMatcher();
      for (let i = 0; i < 16; i++) mm.push(fakeHand([0.2, -2.4], [-0.4, -0.3]), i * 90);
      return mm.match(16 * 90) === null;
    })());
    ok("motion: push(null) / reset() don't throw",
      (() => { try { const mm = motMod.createMotionMatcher(); mm.push(null, 0); mm.reset(); return mm.match(1) === null; } catch { return false; } })());

    // ---- swipe.js (spell-mode "wipe to delete") ----
    const swMod = await import("../js/swipe.js");
    // a spread-open "5" hand at wrist (wx,wy)
    const openHand = (wx, wy) => {
      const lm = Array.from({ length: 21 }, () => ({ x: wx, y: wy, z: 0 }));
      lm[0] = { x: wx, y: wy, z: 0 };
      lm[5] = { x: wx - 0.06, y: wy - 0.10, z: 0 };
      lm[9] = { x: wx - 0.02, y: wy - 0.12, z: 0 };
      lm[13] = { x: wx + 0.02, y: wy - 0.12, z: 0 };
      lm[17] = { x: wx + 0.06, y: wy - 0.10, z: 0 };
      lm[8] = { x: wx - 0.14, y: wy - 0.26, z: 0 };
      lm[12] = { x: wx - 0.04, y: wy - 0.32, z: 0 };
      lm[16] = { x: wx + 0.06, y: wy - 0.30, z: 0 };
      lm[20] = { x: wx + 0.15, y: wy - 0.22, z: 0 };
      return lm;
    };
    // a fist at (wx,wy) — tips sit on top of their MCPs
    const fistHand = (wx, wy) => {
      const lm = openHand(wx, wy);
      lm[8] = { ...lm[5] }; lm[12] = { ...lm[9] };
      lm[16] = { ...lm[13] }; lm[20] = { ...lm[17] };
      return lm;
    };
    ok("swipe: a fast open sideways sweep fires 'delete'", (() => {
      const sw = swMod.createSwipeMatcher();
      let out = null;
      [0.30, 0.38, 0.46, 0.54, 0.62].forEach((wx, i) => {
        sw.push(openHand(wx, 0.6), i * 40);
        out = sw.match(i * 40) || out;
      });
      return out === "delete";
    })());
    ok("swipe: a moderately-open hand (not fully fanned) still fires", (() => {
      // tips closer together than openHand — fingers apart but not maximally
      const looseOpen = (wx, wy) => {
        const lm = openHand(wx, wy);
        lm[8] = { x: wx - 0.08, y: wy - 0.27, z: 0 };
        lm[12] = { x: wx - 0.03, y: wy - 0.31, z: 0 };
        lm[16] = { x: wx + 0.02, y: wy - 0.30, z: 0 };
        lm[20] = { x: wx + 0.08, y: wy - 0.24, z: 0 };
        return lm;
      };
      const sw = swMod.createSwipeMatcher();
      let out = null;
      [0.32, 0.40, 0.48, 0.56, 0.64, 0.70].forEach((wx, i) => {
        sw.push(looseOpen(wx, 0.6), i * 40);
        out = sw.match(i * 40) || out;
      });
      return out === "delete";
    })());
    ok("swipe: a slow open drift does nothing", (() => {
      const sw = swMod.createSwipeMatcher();
      let out = null;
      for (let i = 0; i < 12; i++) {
        sw.push(openHand(0.30 + i * 0.004, 0.6), i * 40);
        out = sw.match(i * 40) || out;
      }
      return out === null;
    })());
    ok("swipe: a fast VERTICAL move does nothing", (() => {
      const sw = swMod.createSwipeMatcher();
      let out = null;
      [0.20, 0.30, 0.40, 0.50, 0.60].forEach((wy, i) => {
        sw.push(openHand(0.5, wy), i * 40);
        out = sw.match(i * 40) || out;
      });
      return out === null;
    })());
    ok("swipe: a fist sweeping fast does nothing (not open)", (() => {
      const sw = swMod.createSwipeMatcher();
      let out = null;
      [0.30, 0.40, 0.50, 0.60, 0.70].forEach((wx, i) => {
        sw.push(fistHand(wx, 0.6), i * 40);
        out = sw.match(i * 40) || out;
      });
      return out === null;
    })());
    ok("swipe: fires once, then a cooldown", (() => {
      const sw = swMod.createSwipeMatcher();
      let hits = 0;
      for (let i = 0; i < 14; i++) {
        // keep sweeping back and forth fast the whole time
        const wx = 0.30 + 0.32 * (i % 2);
        sw.push(openHand(wx, 0.6), i * 40);
        if (sw.match(i * 40) === "delete") hits++;
      }
      return hits === 1;
    })());
    ok("swipe: a sweep straight out of a held closed letter fires first time (live QA: needed repeats)", (() => {
      const sw = swMod.createSwipeMatcher();
      let out = null, t = 0;
      for (let i = 0; i < 8; i++) { sw.push(fistHand(0.30, 0.6), t); out = sw.match(t) || out; t += 40; } // holding a letter
      [0.30, 0.40, 0.50, 0.60, 0.70].forEach((wx) => { sw.push(openHand(wx, 0.6), t); out = sw.match(t) || out; t += 40; });
      return out === "delete";
    })());
    ok("swipe: push(null) / reset() don't throw",
      (() => { try { const sw = swMod.createSwipeMatcher(); sw.push(null, 0); sw.reset(); return sw.match(1) === null; } catch { return false; } })());

    // ---- twohand.js (spell-mode copy / paste) ----
    const thMod = await import("../js/twohand.js");
    const lerp = (a, b, t) => a + (b - a) * t;
    const runTwoHand = (axFrom, axTo, bxFrom, bxTo, handFn = openHand, n = 9) => {
      const th = thMod.createTwoHandMatcher();
      let out = null;
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        th.push([handFn(lerp(axFrom, axTo, t), 0.55), handFn(lerp(bxFrom, bxTo, t), 0.55)], i * 40);
        out = th.match(i * 40) || out;
      }
      return out;
    };
    ok("twohand: two open hands coming together -> 'copy'",
      runTwoHand(0.22, 0.46, 0.80, 0.56) === "copy");
    ok("twohand: two open hands pulling apart -> 'paste'",
      runTwoHand(0.46, 0.20, 0.56, 0.82) === "paste");
    ok("twohand: one hand only -> nothing", (() => {
      const th = thMod.createTwoHandMatcher();
      let out = null;
      for (let i = 0; i < 9; i++) { th.push([openHand(0.3 + i * 0.03, 0.55)], i * 40); out = th.match(i * 40) || out; }
      return out === null;
    })());
    ok("twohand: a fist + an open hand coming together -> nothing",
      runTwoHand(0.22, 0.46, 0.80, 0.56, (wx, wy) => (wx < 0.5 ? fistHand(wx, wy) : openHand(wx, wy))) === null);
    ok("twohand: two open hands held at a fixed gap -> nothing",
      runTwoHand(0.30, 0.30, 0.70, 0.70) === null);
    ok("twohand: still fires 'copy' if a hand track drops as they meet", (() => {
      const th = thMod.createTwoHandMatcher();
      let out = null;
      // 6 frames: two open hands closing from ~5 spans to ~1.4
      [[0.20, 0.80], [0.24, 0.76], [0.29, 0.71], [0.34, 0.66], [0.39, 0.61], [0.43, 0.57]].forEach(([ax, bx], i) => {
        th.push([openHand(ax, 0.55), openHand(bx, 0.55)], i * 40);
        out = th.match(i * 40) || out;
      });
      // then the hands merge — only one is tracked for a few frames
      for (let i = 6; i < 10; i++) {
        th.push([openHand(0.5, 0.55)], i * 40);
        out = th.match(i * 40) || out;
      }
      return out === "copy";
    })());
    ok("twohand: one paste, then one hand dropped, doesn't re-paste every cooldown (QA repro)", (() => {
      const th = thMod.createTwoHandMatcher();
      let hits = 0, t = 0;
      for (let i = 0; i < 9; i++) { const k = i / 8; th.push([openHand(lerp(0.46, 0.20, k), 0.55), openHand(lerp(0.56, 0.82, k), 0.55)], t); if (th.match(t)) hits++; t += 40; }
      for (let i = 0; i < 125; i++) { th.push([openHand(0.3, 0.55)], t); if (th.match(t)) hits++; t += 40; } // ~5 s, one hand
      return hits === 1;
    })());
    ok("twohand: fires once, then a cooldown", (() => {
      const th = thMod.createTwoHandMatcher();
      let hits = 0;
      for (let i = 0; i < 24; i++) {
        // oscillate together/apart continuously
        const phase = Math.sin(i * 0.6);
        const ax = 0.5 - 0.2 - 0.08 * phase;
        const bx = 0.5 + 0.2 + 0.08 * phase;
        // sweep fully together every ~8 frames
        const together = i % 8 >= 4;
        th.push([openHand(together ? 0.45 : ax, 0.55), openHand(together ? 0.55 : bx, 0.55)], i * 40);
        if (th.match(i * 40)) hits++;
      }
      return hits <= 2; // at most one per cooldown window over ~960 ms
    })());
    ok("twohand: push(null) / reset() don't throw",
      (() => { try { const th = thMod.createTwoHandMatcher(); th.push(null, 0); th.push([], 40); th.reset(); return th.match(1) === null; } catch { return false; } })());

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

    // Challenge v2 (combo, fair drain, near-miss grace, words, difficulty)
    {
      try { localStorage.removeItem("asl-challenge-best-hard"); localStorage.removeItem("asl-challenge-stats-hard"); } catch {}
      const toPlay = (g, t) => { let s; for (let i = 0; i < 8 && g.phase !== "play"; i++) s = g.update((t.v += 3000), null); return s; };
      ok("challenge v2: combo multiplier climbs x1 -> x2 at 3 in a row, and scales the points", (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B", "C"] });
        g.start(0); const t = { v: 0 }; g.update(0, null);
        const gains = [], mults = []; let up = 0;
        for (let k = 0; k < 3; k++) {
          const s0 = toPlay(g, t);
          const s = g.update((t.v += 10), s0.target);
          gains.push(s.lastGain); mults.push(s.mult); if (s.comboUp) up++;
          g.update((t.v += 1000), null); // past the "won" beat
        }
        return mults.join() === "1,1,2" && up === 1 && gains[2] >= 2 * 20;
      })());
      ok("challenge v2: holding a WRONG shape drains the clock (costs time, not a life)", (() => {
        const mk = () => { const g = gameMod.createChallenge({ letters: ["A", "B"] }); g.start(0); g.update(0, null); return g; };
        const run = (wrongFor) => {
          const g = mk(); const t = { v: 0 }; const s0 = toPlay(g, t);
          const wrong = s0.target === "A" ? "B" : "A";
          let s = s0, drained = false;
          for (let k = 0; k * 50 < 3000; k++) { s = g.update((t.v += 50), k * 50 < wrongFor ? wrong : null); drained ||= s.draining; }
          return { frac: s.remainingFrac, drained, lives: s.lives, phase: s.phase };
        };
        const clean = run(0), wrong = run(2500);
        return wrong.drained && !clean.drained && wrong.frac < clean.frac - 0.2 && wrong.lives === 3 && wrong.phase === "play";
      })());
      ok("challenge v2: cycling through different wrong shapes still drains (can't dodge it)", (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B", "C", "D", "E"] }); g.start(0); g.update(0, null);
        const t = { v: 0 }; const s0 = toPlay(g, t);
        const wrongs = ["A", "B", "C", "D", "E"].filter((c) => c !== s0.target);
        let drained = false;
        for (let k = 0; k < 40; k++) drained ||= g.update((t.v += 50), wrongs[(k >> 2) % wrongs.length]).draining;
        return drained;
      })());
      ok("challenge v2: no hand (null) never drains; 'near' at time-out earns one grace extension", (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B"] }); g.start(0); g.update(0, null);
        const t = { v: 0 }; toPlay(g, t);
        let s = g.update((t.v += 7000), null, { near: true }); // time's up, but close
        const graced = s.phase === "play" && s.lives === 3;
        s = g.update((t.v += 1100), null, { near: true }); // grace used up
        return graced && s.event === "miss" && s.lives === 2;
      })());
      ok("challenge v2: a word round needs every letter in order; the just-landed letter isn't 'wrong'", (() => {
        const g = gameMod.createChallenge({ letters: ["C", "A", "T", "X"], words: ["cat"], rng: () => 0 });
        g.start(0); const t = { v: 0 }; g.update(0, null);
        let s;
        for (let r = 0; r < 30; r++) { // play letter rounds until a word round comes up
          s = toPlay(g, t);
          if (s.target.length > 1) break;
          g.update((t.v += 10), s.target); g.update((t.v += 1000), null);
        }
        if (s.target !== "CAT") return false;
        s = g.update((t.v += 50), "C");
        const p1 = s.partHit && s.progress === 1;
        let drained = false;
        for (let k = 0; k < 30; k++) drained ||= g.update((t.v += 50), "C").draining; // still reading C
        s = g.update((t.v += 50), "A"); s = g.update((t.v += 50), "T");
        return p1 && !drained && s.event === "win";
      })());
      ok("challenge v2: hard = short study; the run's summary + per-difficulty best persist", (() => {
        const g = gameMod.createChallenge({ letters: ["A", "B"] });
        g.start(0, "hard"); let s = g.update(0, null);
        const shortStudy = g.update(1000, null).phase !== "study";
        const t = { v: 1000 };
        toPlay(g, t); s = g.update((t.v += 10), g.needed); g.update((t.v += 1000), null);
        for (let life = 3; life > 0; life--) { toPlay(g, t); s = g.update((t.v += 90000), null); }
        return shortStudy && s.event === "over" && s.newBest && s.summary.difficulty === "hard" &&
          s.summary.wins === 1 && s.summary.misses === 3 && g.savedStats("hard").best === s.score;
      })());
      try { localStorage.removeItem("asl-challenge-best-hard"); localStorage.removeItem("asl-challenge-stats-hard"); } catch {}
    }

    // ---- leaderboard.js + versus.js (two-player Challenge, 2026-09-25) ----
    {
      const lbMod = await import("../js/leaderboard.js");
      const vsMod = await import("../js/versus.js");
      const mem = { m: {}, getItem(k) { return this.m[k] ?? null; }, setItem(k, v) { this.m[k] = v; } };
      ok("leaderboard: ranks best-first, keeps top N, drops a score that doesn't place, cleans initials", (() => {
        const lb = lbMod.createLeaderboard({ storage: mem, max: 3 });
        const r1 = lb.add("b", { name: "ab1c", score: 50 }), r2 = lb.add("b", { name: "zz", score: 90 });
        const r3 = lb.add("b", { name: "q", score: 10 }), r4 = lb.add("b", { name: "w", score: 5 });
        const top = lb.top("b").map((r) => r.name + r.score).join(",");
        return r1 === 1 && r2 === 1 && r3 === 3 && r4 === 0 && top === "ZZ90,ABC50,Q10" && !lb.qualifies("b", 4);
      })());
      const vrun = (mode, steps) => {
        const v = vsMod.createVersus({ letters: ["A", "B", "C"], mode, rng: () => 0 });
        v.start(0); let t = 0, s = v.update(0, [null, null]); const ev = [];
        for (const [dt, seen] of steps) { t += dt; s = v.update(t, seen); if (s.event) ev.push(s.event + (s.event === "win" ? s.roundWinner : "")); }
        return { ev, s };
      };
      ok("versus race: whoever signs the target first wins the round", (() => {
        const { ev, s } = vrun("race", [[3000, [null, null]], [600, [null, null]], [100, [null, "A"]], [100, ["A", null]]]);
        return ev.includes("win1") && s.players[1].wins === 1 && s.players[0].wins === 0;
      })());
      ok("versus race: holding a wrong shape 0.8s locks that player out of the round", (() => {
        const { s } = vrun("race", [[3000, [null, null]], [600, [null, null]], [100, ["B", null]], [450, ["B", null]], [450, ["B", null]], [100, ["A", null]]]);
        return s.phase === "play" && s.players[0].locked && s.players[0].wins === 0;
      })());
      ok("versus turns: players alternate; only the current player's letter counts; misses cost lives; game ends when both are out", (() => {
        const turn = (seen) => [[3000, [null, null]], [600, [null, null]], [100, seen], [1000, [null, null]]];
        let { ev, s } = vrun("turns", [...turn(["A", "A"]), [3000, [null, null]], [600, [null, null]], [100, ["B", null]]]);
        const alternated = s.current === 1 && s.players[0].score > 0 && s.players[1].score === 0 && s.phase === "play"; // P1's "B" ignored on P2's turn
        const v = vsMod.createVersus({ letters: ["A", "B"], mode: "turns", rng: () => 0 });
        v.start(0); let t = 0, last; for (let i = 0; i < 400 && (!last || !last.over); i++) { t += 500; last = v.update(t, [null, null]); }
        return alternated && last.over && last.players.every((p) => p.lives === 0) && last.gameWinner === -1;
      })());
    }

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
    const bigGap = (sp, t0) => gap(sp, t0, 2300); // > acceptMs -> commit the word
    ok("speller: letters go to the pending word, a pause commits it (CAT)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "C", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "A", t));
      t = gap(sp, t, 120); ({ t } = hold(sp, "T", t));
      const inBuffer = sp.pending === "CAT" && sp.text === "";
      t = bigGap(sp, t);
      return inBuffer && sp.text === "CAT" && sp.pending === "";
    })());
    ok("speller: a held letter is added once, not every frame", (() => {
      const sp = spMod.createSpeller();
      hold(sp, "E", 0, 30);
      return sp.pending === "E";
    })());
    ok("speller: a doubled letter needs a real gap (BOOK)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "B", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "O", t));
      ({ t } = hold(sp, "O", t)); // no gap -> second O ignored
      const oneO = sp.pending === "BO";
      t = gap(sp, t, 750); ({ t } = hold(sp, "O", t)); // clear gap (> gapMs) -> BOO
      t = gap(sp, t, 120); ({ t } = hold(sp, "K", t));
      return oneO && sp.pending === "BOOK";
    })());
    ok("speller: a pause commits the word once (not twice)", (() => {
      const sp = spMod.createSpeller();
      let u = hold(sp, "H", 0).t;
      u = gap(sp, u, 120); u = hold(sp, "I", u).t;
      u = bigGap(sp, u); // commit "HI"
      u = bigGap(sp, u); // nothing pending -> no change, no extra space
      u = hold(sp, "U", u).t;
      return sp.text === "HI" && sp.pending === "U" && sp.display === "HI U";
    })());
    ok("speller: a held letter doesn't re-commit after a brief classifier dip (live QA: letters every second)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "A", 0, 10);
      for (let i = 0; i < 6; i++) { t = gap(sp, t, 360); ({ t } = hold(sp, "A", t, 8)); } // ~1/3 s dips
      return sp.pending === "A";
    })());
    ok("speller: a learner-pace pause between letters doesn't commit the word (no word cue per letter)", (() => {
      const sp = spMod.createSpeller();
      let { t, r } = hold(sp, "C", 0);
      let words = 0;
      for (const L of "AT") {
        const end = t + 1300;
        while (t < end) { r = sp.feed({ holding: false, letter: null, handPresent: true, moved: false, now: t += 40 }); if (r.event === "word") words++; }
        ({ t } = hold(sp, L, t));
      }
      return words === 0 && sp.pending === "CAT";
    })());
    ok("speller: J/Z strokes append and can repeat (JAZZ)", (() => {
      const sp = spMod.createSpeller();
      let t = 40;
      sp.feed({ holding: false, letter: null, stroke: "J", moved: false, now: t }); t += 200;
      ({ t } = hold(sp, "A", t)); t = gap(sp, t, 120);
      sp.feed({ holding: false, letter: null, stroke: "Z", moved: false, now: t }); t += 200;
      sp.feed({ holding: false, letter: null, stroke: "Z", moved: false, now: t });
      return sp.pending === "JAZZ";
    })());
    ok("speller: a J stroke right after a held I replaces it (J, not IJ)", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "H", 0); t = gap(sp, t, 120);
      ({ t } = hold(sp, "I", t)); // start shape committed as a letter
      sp.feed({ holding: false, letter: null, stroke: "J", moved: false, now: t + 500 });
      return sp.pending === "HJ" && sp.raw.map((r) => r.letter).join("") === "HJ";
    })());
    ok("speller: fluid mode — a J stroke right after addLetter('I') replaces it (LAB-040)", (() => {
      const sp = spMod.createSpeller();
      sp.addLetter("H", 0.9, 1000); sp.addLetter("I", 0.9, 1500);
      sp.feed({ holding: false, letter: null, stroke: "J", moved: false, now: 2000 });
      return sp.pending === "HJ";
    })());
    ok("speller: swipe (clearPending) throws away the half-formed word", (() => {
      const sp = spMod.createSpeller();
      let u = hold(sp, "H", 0).t;
      u = gap(sp, u, 120); u = hold(sp, "I", u).t;
      u = bigGap(sp, u); // "HI" committed
      u = hold(sp, "X", u).t; u = gap(sp, u, 120); u = hold(sp, "Q", u).t; // junk pending "XQ"
      const wiped = sp.clearPending();
      return wiped && sp.text === "HI" && sp.pending === "" && sp.display === "HI";
    })());
    ok("speller: insert() pastes after committing the current word", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "H", 0);
      t = gap(sp, t, 120); ({ t } = hold(sp, "I", t)); // pending "HI"
      sp.insert(" THERE");
      return sp.text === "HI THERE" && sp.pending === "";
    })());
    ok("speller: backspace hits the pending word first, then the transcript", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "A", 0);
      t = bigGap(sp, t); // "A" committed
      ({ t } = hold(sp, "B", t)); // pending "B"
      sp.backspace(); const afterB1 = sp.pending === "" && sp.text === "A";
      sp.backspace(); const afterB2 = sp.text === "";
      return afterB1 && afterB2;
    })());
    ok("speller: manual space commits the word + a separator", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "H", 0); t = gap(sp, t, 120); ({ t } = hold(sp, "I", t));
      sp.space();
      return sp.text === "HI " && sp.pending === "";
    })());
    ok("speller: clear() wipes both the word and the transcript", (() => {
      const sp = spMod.createSpeller();
      let { t } = hold(sp, "A", 0); t = bigGap(sp, t); ({ t } = hold(sp, "B", t));
      sp.clear();
      return sp.text === "" && sp.pending === "" && sp.display === "";
    })());
    ok("speller: addLetter() feeds the pending word + the raw stream (fluid mode)", (() => {
      const sp = spMod.createSpeller();
      sp.addLetter("H", 0.8); sp.addLetter("I", 0.7);
      return sp.pending === "HI" &&
        sp.raw.map((r) => r.letter).join("") === "HI" &&
        sp.raw[0].conf === 0.8;
    })());
    ok("speller: at the char cap, add returns 'full' instead of silently dropping the letter", (() => {
      const sp = spMod.createSpeller({ maxLen: 2 });
      const first = sp.addLetter("H"); // fills the 2-char cap
      const second = sp.addLetter("I");
      const third = sp.addLetter("X"); // no room left
      return first === "letter" && second === "letter" && third === "full" &&
        sp.pending === "HI"; // the blocked letter never got appended
    })());
    ok("speller: raw[] tracks backspace / clearPending / clear", (() => {
      const sp = spMod.createSpeller();
      "CAT".split("").forEach((L) => sp.addLetter(L, 0.9));
      sp.backspace();                       // -> "CA"
      const afterBack = sp.raw.length === 2;
      sp.space();                           // commit "CA", rawWordStart moves
      sp.addLetter("D", 0.9); sp.addLetter("X", 0.9);
      sp.clearPending();                    // drop "DX"
      const afterCP = sp.raw.length === 2 && sp.pending === "";
      sp.clear();
      return afterBack && afterCP && sp.raw.length === 0;
    })());

    // ---- decode.js (Stage 8 lexicon decoder) ----
    const dcMod = await import("../js/decode.js");
    const lexTxt = "the 100\nquick 40\nbrown 30\nfox 20\nwhat 90\nare 80\nyou 85\ndoing 25\n" +
      "where 70\nis 95\nbathroom 8\nhow 60\nmuch 50\ndoes 45\nthis 88\ncost 22\ni 99\nam 55\n" +
      "learning 12\nsign 30\nlanguage 15\ncan 65\nhelp 28\nme 75\nplease 26";
    const lex = dcMod.buildLexicon(lexTxt);
    const dc = dcMod.createDecoder(lex);
    ok("decode: buildLexicon returns a sized trie", lex.size === 25 && typeof lex.logp === "function");
    ok("decode: segment() splits a clean run",
      dc.segment("whatareyoudoing").join(" ") === "what are you doing");
    ok("decode: decode() is exact on a clean letter string",
      dc.decode("whereisthebathroom").text === "where is the bathroom");
    ok("decode: confusion-aware — recovers M<->N / D<->O style swaps", (() => {
      // "wemt" -> "what" (m->a? no) ; use a real near-miss: "whar" -> "what" (r->t not listed)
      // "wnat are you" : n->h is not a pair; test the built-in default matrix instead
      const d2 = dcMod.createDecoder(dcMod.buildLexicon(
        "what 90\nare 80\nyou 85\ndoing 25\nmine 30\nnine 28\nmind 20"));
      // "mird" with a D-confusion should prefer a real word over the raw string
      const r = d2.decode([{ letter: "m", conf: .6 }, { letter: "i", conf: .8 },
        { letter: "n", conf: .55 }, { letter: "d", conf: .7 }]);
      return r.text === "mind" || r.text === "mine";
    })());
    ok("decode: a garbage run still returns a string, never throws", (() => {
      try {
        const r = dc.decode("zzqxjkbbbwptmns");
        return typeof r.text === "string" && Array.isArray(r.words);
      } catch { return false; }
    })());
    ok("decode: segment() is the standalone OOV fallback (names)",
      dc.segment("siobhan").length >= 1); // no throw, returns some split
    ok("decode: empty / junk input is safe",
      dc.decode("").text === "" && dc.decode([]).text === "");
    ok("decode: digit runs pass through verbatim (phone/address)", (() => {
      const d = (L) => ({ letter: L, conf: 0.9 });
      const r = dc.decode([d("c"), d("a"), d("l"), { letter: "", conf: 0 }, d("l"),
        { letter: "", conf: 0 }, d("4"), d("0"), d("7")]);
      return r.words.includes("407"); // "call" beamed, "407" verbatim
    })());
    ok("decode: mergeConfusion blends measured over the floor", (() => {
      const merged = dcMod.mergeConfusion({ m: { n: 0.9 }, z: { s: 0.3 } });
      return merged.m.n === 0.9 && merged.z.s === 0.3 &&
        merged.d && typeof merged.d.o === "number"; // floor kept where measured is silent
    })());

    // ---- transition.js (rhythm-based letter segmentation) ----
    const trMod = await import("../js/transition.js");
    const trHand = (wx, wy) => {
      const lm = [{ x: wx, y: wy, z: 0 }];
      for (let f = 0; f < 5; f++) for (let j = 1; j <= 4; j++)
        lm.push({ x: wx - 0.06 + f * 0.03, y: wy - 0.03 - j * 0.045, z: 0 });
      return lm;
    };
    const trRun = (script) => {
      const tr = trMod.createTransitionMatcher();
      let t = 0, wx = 0.5; const emitted = [];
      for (const seg of script) for (let i = 0; i < seg.frames; i++) {
        wx += seg.move ? 0.032 : (Math.random() - 0.5) * 0.003;
        t += 33;
        tr.push(trHand(wx, 0.6), seg.letter ? { label: seg.letter, confidence: 0.8 } : null, t);
        const e = tr.read(); if (e) emitted.push(e.letter);
      }
      return emitted;
    };
    // (the hand is in view briefly before the first letter — since 2026-09-24
    // motion is "unknown = moving" until the window fills, so a hand that
    // appears already in a shape doesn't commit it on arrival)
    ok("transition: a hand that flashes into view already shaped commits nothing",
      trRun([{ letter: "B", frames: 3 }]).length === 0);
    ok("transition: C-A-T settles to three letters",
      trRun([{ frames: 4 }, { letter: "C", frames: 7 }, { frames: 4, move: true },
             { letter: "A", frames: 7 }, { frames: 4, move: true },
             { letter: "T", frames: 7 }]).join("") === "CAT");
    ok("transition: a doubled letter survives (move between the two B's)",
      trRun([{ letter: "B", frames: 8 }, { frames: 4, move: true },
             { letter: "B", frames: 8 }]).join("") === "BB");
    ok("transition: a long still hold commits once, not repeatedly",
      trRun([{ letter: "B", frames: 30 }]).join("") === "B");
    ok("transition: constant fast motion commits nothing",
      trRun([{ letter: "B", frames: 30, move: true }]).length === 0);
    ok("transition: low-confidence hold commits nothing", (() => {
      const tr = trMod.createTransitionMatcher();
      let t = 0; const e = [];
      for (let i = 0; i < 20; i++) { t += 33; tr.push(trHand(0.5, 0.6), { label: "M", confidence: 0.3 }, t); if (tr.read()) e.push(1); }
      return e.length === 0;
    })());
    ok("transition: push(null) / reset() don't throw",
      (() => { try { const tr = trMod.createTransitionMatcher(); tr.push(null, null, 0); tr.reset(); return tr.read() === null; } catch { return false; } })());

    // ---- fluid pipeline: transition -> speller.addLetter -> decode (the Spell
    // mode "fluid + speak" wiring, end to end, with a clean prediction stream
    // that simulates a good webcam) ----
    {
      const stillHand = (wx) => { const lm = [{ x: wx, y: 0.6, z: 0 }];
        for (let f = 0; f < 5; f++) for (let j = 1; j <= 4; j++)
          lm.push({ x: wx - 0.06 + f * 0.03, y: 0.57 - j * 0.045, z: 0 }); return lm; };
      const runFluid = (word, lexWords) => {
        const tr = trMod.createTransitionMatcher();
        const sp = spMod.createSpeller();
        const dec = dcMod.createDecoder(dcMod.buildLexicon(lexWords));
        let t = 0, wx = 0.5;
        const feed = (label, conf, n, move) => {
          for (let i = 0; i < n; i++) {
            wx += move ? 0.032 : (Math.random() - 0.5) * 0.003;
            t += 33;
            tr.push(stillHand(wx), label ? { label, confidence: conf } : null, t);
            const e = tr.read();
            if (e) sp.addLetter(e.letter, e.conf);
            sp.feed({ holding: false, letter: null, handPresent: true, moved: false, now: t });
          }
        };
        for (let k = 0; k < word.length; k++) {
          if (k > 0) feed(null, 0.2, 4, true); // transition between letters
          feed(word[k], 0.9, 8, false); // hold the letter
        }
        feed(null, 0.2, 70, false); // long pause (~2.3 s > speller acceptMs) -> commit the word
        return { raw: sp.raw.map((r) => r.letter).join(""), text: sp.text.trim(), decoded: dec.decode(sp.raw).text };
      };
      const r1 = runFluid("HELLO", "hello 90\nworld 80\nhell 5\nhe 40");
      ok("fluid: transition -> speller -> raw stream reconstructs the word",
        r1.raw === "HELLO", JSON.stringify(r1));
      ok("fluid: a pause commits the word to the transcript", r1.text === "HELLO");
      ok("fluid: the decoder produces the word", r1.decoded === "hello");
      const r2 = runFluid("CAT", "cat 90\ncar 40");
      ok("fluid: no-double word round-trips (CAT)", r2.raw === "CAT" && r2.decoded === "cat");
    }

    ok("decode: blank-separated committed letters keep real doubles (fluid mode: HELLO not 'held')", (() => {
      const d2 = dcMod.createDecoder(dcMod.buildLexicon("held 90\nhello 60\ncode 80\ncoffee 40\nsee 50\nse 5"));
      const B = { letter: "", conf: 0 };
      const dec = (w) => d2.decode([...w].flatMap((l) => [{ letter: l, conf: 0.85 }, B])).text;
      return dec("HELLO") === "hello" && dec("COFFEE") === "coffee" && dec("SEE") === "see";
    })());

    // ---- reader.js (receptive practice) ----
    const rdMod = await import("../js/reader.js");
    const bank = { short: ["cat", "dog"], names: ["sarah", "james"], _note: "x" };
    ok("reader: next() returns a word from the pool", (() => {
      const r = rdMod.createReader(bank);
      const w = r.next();
      return ["cat", "dog", "sarah", "james"].includes(w) && r.current === w;
    })());
    ok("reader: check() scores a correct guess + builds a streak", (() => {
      const r = rdMod.createReader({ short: ["cat"] });
      r.next(); // "cat"
      const a = r.check("CAT ").ok === true && r.score >= 1;
      r.next(); const b = r.check("cat").ok === true && r.streak === 2;
      return a && b;
    })());
    ok("reader: a wrong guess resets the streak, reveal() breaks it too", (() => {
      const r = rdMod.createReader({ short: ["cat"] });
      r.next(); r.check("cat"); r.next(); r.check("cat"); // streak 2
      r.next(); const wrong = r.check("dog").ok === false && r.streak === 0;
      r.next(); r.check("cat"); const rev = (r.reveal() === "cat" && r.streak === 0);
      return wrong && rev;
    })());
    ok("reader: check() reports a positional diff + known confusables (S3)", (() => {
      const confusion = { n: { m: 0.13 }, o: { d: 0.07 } };
      const r = rdMod.createReader({ short: ["name"] }, { confusion });
      r.next(); // "name"
      const res = r.check("mame"); // n<->m at position 0 — a real confusable pair
      const diffOk = res.ok === false && res.diff.length === 1 &&
        res.diff[0].i === 0 && res.diff[0].expected === "n" && res.diff[0].got === "m";
      const confOk = res.confusables.length === 1 && res.confusables[0].expected === "n" &&
        res.confusables[0].got === "m" && res.confusables[0].weight > 0;
      r.next(); r.check("name"); r.next();
      const res2 = r.check("zzzz"); // no known confusable pairs at all
      return diffOk && confOk && res2.confusables.length === 0 && res2.diff.length > 0;
    })());
    ok("reader: setConfusion() wires in confusion data that arrives after construction (S3)", (() => {
      // main.js builds the reader before data/confusion.json is guaranteed
      // to have loaded (it races a much bigger fetch) — setConfusion must
      // let the SAME reader instance start reporting confusables once it
      // does arrive, not require re-creating it.
      const r = rdMod.createReader({ short: ["name"] }); // no confusion yet
      r.next();
      const before = r.check("mame");
      r.next(); r.check("name"); r.next();
      r.setConfusion({ n: { m: 0.13 } });
      const after = r.check("mame");
      return before.confusables.length === 0 && after.confusables.length === 1 &&
        after.confusables[0].expected === "n" && after.confusables[0].got === "m";
    })());
    ok("reader: toggleCategory never empties the pool", (() => {
      const r = rdMod.createReader(bank);
      r.toggleCategory("short"); r.toggleCategory("names");
      return r.activeCategories.length >= 1 && r.poolSize >= 1;
    })());
    ok("reader: next() avoids repeats until the pool is exhausted", (() => {
      const r = rdMod.createReader({ short: ["a", "b", "c"] });
      const seen = new Set();
      for (let i = 0; i < 3; i++) seen.add(r.next());
      return seen.size === 3;
    })());
    ok("reader: next(list) picks from a caller-supplied list", (() => {
      const r = rdMod.createReader(bank);
      const seen = new Set();
      for (let i = 0; i < 4; i++) seen.add(r.next(["JAZZ", "zone"]));
      return [...seen].every((w) => ["jazz", "zone"].includes(w)) && seen.size === 2;
    })());

    // ---- curriculum.js (teaching-order lessons, progress gating) ----
    const cuMod = await import("../js/curriculum.js");
    const cuJson = {
      unlockThreshold: 2,
      tiers: [
        { name: "T1", blurb: "b1", letters: "ABC", words: ["cab", "abc"] },
        { name: "T2", blurb: "b2", letters: "DE", words: ["dead", "bead"] },
        { name: "T3", blurb: "b3", letters: "FG", words: ["fig"] },
      ],
    };
    ok("curriculum: starts with only the first tier unlocked", (() => {
      const c = cuMod.createCourse(cuJson);
      const v = c.view();
      return c.unlocked === 1 && v[0].locked === false && v[1].locked === true && c.tier.name === "T1";
    })());
    ok("curriculum: words() are the active tier's words", (() => {
      const c = cuMod.createCourse(cuJson);
      return JSON.stringify(c.words()) === JSON.stringify(["cab", "abc"]);
    })());
    ok("curriculum: N correct answers on the frontier unlock the next tier", (() => {
      const c = cuMod.createCourse(cuJson);
      const a = c.record(true).unlocked === false; // 1/2
      const r = c.record(true); // 2/2 -> promote
      return a && r.unlocked === true && r.tierName === "T2" && c.unlocked === 2;
    })());
    ok("curriculum: wrong answers don't advance progress", (() => {
      const c = cuMod.createCourse(cuJson);
      c.record(false); c.record(false);
      return c.progress().done === 0 && c.unlocked === 1;
    })());
    ok("curriculum: select() only moves to an unlocked tier", (() => {
      const c = cuMod.createCourse(cuJson);
      const blocked = c.select(1) === false && c.activeIndex === 0;
      c.record(true); c.record(true); // unlock T2
      return blocked && c.select(1) === true && c.tier.name === "T2";
    })());
    ok("curriculum: state() round-trips through createCourse", (() => {
      const c1 = cuMod.createCourse(cuJson);
      c1.record(true); c1.record(true); c1.select(1); c1.record(true); // unlock T2, move in, 1/2
      const c2 = cuMod.createCourse(cuJson, c1.state());
      return c2.unlocked === 2 && c2.activeIndex === 1 && c2.progress().done === 1;
    })());
    ok("curriculum: taughtLetters() spans the active tier and earlier", (() => {
      const c = cuMod.createCourse(cuJson);
      c.record(true); c.record(true); c.select(1);
      return c.taughtLetters().join("") === "ABCDE";
    })());
    ok("curriculum: promotion only from the frontier, and only once", (() => {
      const c = cuMod.createCourse(cuJson);
      c.record(true); c.record(true); // -> T2 unlocked, active still 0
      const again = c.record(true); // more correct on tier 0, already not frontier
      return again.unlocked === false && c.unlocked === 2;
    })());
    ok("curriculum: last tier finished -> complete", (() => {
      const c = cuMod.createCourse(cuJson);
      c.record(true); c.record(true); c.select(1);
      c.record(true); c.record(true); c.select(2);
      c.record(true); c.record(true);
      return c.complete === true;
    })());

    // ---- spelldrill.js (Spell-mode "spell this word" targets) ----
    const sdMod = await import("../js/spelldrill.js");
    ok("spelldrill: next() returns a normalized word from the pool", (() => {
      const d = sdMod.createSpellDrill(["Brown", "seven!", "  fox "]);
      const w = d.next();
      return ["brown", "seven", "fox"].includes(w) && d.target === w && d.size === 3;
    })());
    ok("spelldrill: match() reports the matched prefix length", (() => {
      const d = sdMod.createSpellDrill(["brown"]);
      d.next(); // "brown"
      const a = d.match("bro");
      const b = d.match("brown");
      return a.n === 3 && a.ok === false && a.bad === false && b.ok === true;
    })());
    ok("spelldrill: match() flags a diverged attempt as bad", (() => {
      const d = sdMod.createSpellDrill(["brown"]);
      d.next();
      const m = d.match("brxx");
      return m.n === 2 && m.bad === true && m.ok === false;
    })());
    ok("spelldrill: submit() scores an exact match + builds a streak", (() => {
      const d = sdMod.createSpellDrill(["fox", "cat"]);
      d.next();
      const first = d.submit(d.target) === true && d.done === 1 && d.score >= 1;
      d.next();
      const second = d.submit(d.target) === true && d.streak === 2;
      return first && second;
    })());
    ok("spelldrill: a wrong submit breaks the streak, not the score", (() => {
      const d = sdMod.createSpellDrill(["fox"]);
      d.next(); d.submit(d.target); // streak 1
      const s0 = d.score;
      d.next(); const wrong = d.submit("zzz") === false && d.streak === 0 && d.score === s0;
      return wrong;
    })());
    ok("spelldrill: setWords() swaps the pool and clears the target if gone", (() => {
      const d = sdMod.createSpellDrill(["fox"]);
      d.next(); // "fox"
      d.setWords(["apple", "grape"]);
      return d.size === 2 && d.target === null;
    })());
    ok("spelldrill: next() avoids repeats until the pool is exhausted", (() => {
      const d = sdMod.createSpellDrill(["a", "b", "c"]);
      const seen = new Set();
      for (let i = 0; i < 3; i++) seen.add(d.next());
      return seen.size === 3;
    })());
    ok("spelldrill: empty pool -> next() is null, match() safe", (() => {
      const d = sdMod.createSpellDrill([]);
      return d.next() === null && d.match("x").ok === false && d.submit("x") === false;
    })());

    const fx = (await import("../js/fx.js")).createFx();
    ok("fx: createFx returns burst + flash",
      typeof fx.burst === "function" && typeof fx.flash === "function");
    ok("fx: burst + flash don't throw",
      (() => { try { fx.burst(100, 100); fx.flash("#22c55e"); return true; } catch { return false; } })());
    ok("fx: ring / rain / moment exist and don't throw (moment is click-through + aria-hidden)", (() => {
      try {
        fx.burst(100, 100, { count: 12, stars: true, colors: ["#fff"] });
        fx.ring(120, 120, { rings: 3 }); fx.rain({ count: 10 }); fx.moment("First A!", { x: 50, y: 50, tone: "first" });
        const m = document.querySelector(".fx-moment");
        return !!m && getComputedStyle(m).pointerEvents === "none" && m.getAttribute("aria-hidden") === "true";
      } catch { return false; }
    })());

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

    // ---- sheet.js (S4b — shared bottom-sheet/dialog controller) ----
    const sheetMod = await import("../js/sheet.js");
    ok("sheet: non-modal open/close/toggle track isOpen + openClass + hidden", (() => {
      const el = document.createElement("div");
      el.hidden = true;
      document.body.appendChild(el);
      const s = sheetMod.createSheet(el, { modal: false });
      const beforeOpen = s.isOpen() === false && el.hidden === true;
      s.open();
      const afterOpen = s.isOpen() === true && el.hidden === false && el.classList.contains("sheet-open");
      s.toggle();
      const afterToggleClose = s.isOpen() === false;
      s.close(); // already closed — should be a safe no-op
      const stillClosed = s.isOpen() === false;
      s.destroy();
      el.remove();
      return beforeOpen && afterOpen && afterToggleClose && stillClosed;
    })());
    ok("sheet: modal inerts every OTHER top-level child, never the one containing the sheet, however deeply nested", (() => {
      const root = document.createElement("div");
      const sib1 = document.createElement("div");
      const container = document.createElement("div");
      const wrapper = document.createElement("div"); // extra nesting between container and the sheet el
      const sheetEl = document.createElement("div");
      const btnInside = document.createElement("button");
      btnInside.textContent = "inside";
      const sib2 = document.createElement("div");
      sheetEl.appendChild(btnInside);
      wrapper.appendChild(sheetEl);
      container.appendChild(wrapper);
      root.append(sib1, container, sib2);
      document.body.appendChild(root);
      sheetEl.hidden = true;

      const outsideBtn = document.createElement("button");
      outsideBtn.textContent = "trigger";
      document.body.appendChild(outsideBtn);
      outsideBtn.focus();
      const focusedTriggerBefore = document.activeElement === outsideBtn;

      const s = sheetMod.createSheet(sheetEl, { modal: true, inertRoot: root });
      s.open();
      const inertedRight = sib1.inert === true && sib2.inert === true && container.inert !== true;
      const focusMovedIn = sheetEl.contains(document.activeElement);

      // Escape closes a modal sheet
      sheetEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      const closedByEscape = s.isOpen() === false;
      const uninertedAfterClose = sib1.inert !== true && sib2.inert !== true;
      const focusRestored = document.activeElement === outsideBtn;

      s.destroy();
      root.remove();
      outsideBtn.remove();
      return focusedTriggerBefore && inertedRight && focusMovedIn && closedByEscape && uninertedAfterClose && focusRestored;
    })());
    ok("sheet: modal auto-creates a backdrop; clicking it closes the sheet", (() => {
      const parent = document.createElement("div");
      const el = document.createElement("div");
      el.hidden = true;
      parent.appendChild(el);
      document.body.appendChild(parent);
      const s = sheetMod.createSheet(el, { modal: true });
      s.open();
      const backdrop = parent.querySelector(".sheet-backdrop");
      const backdropShown = !!backdrop && backdrop.hidden === false;
      backdrop.click();
      const closedByBackdrop = s.isOpen() === false;
      s.destroy();
      parent.remove();
      return backdropShown && closedByBackdrop;
    })());

    // ---- tour.js (Stage 7a — first-run walkthrough) ----
    const tourMod = await import("../js/tour.js");
    ok("tour: 6 scenes, hand first, first letter A last", (() => {
      const ids = tourMod.TOUR_SCENES.map((s) => s.id);
      return ids.length === 6 && ids[0] === "hand" && ids.at(-1) === "first" &&
        tourMod.TOUR_SCENES.at(-1).letter === "A" && new Set(ids).size === 6;
    })());
    ok("tour: machine steps forward/back, clamps at 0, finishes 'done' on the last Next", (() => {
      const t = tourMod.createTourMachine(3);
      const a = t.index === 0 && t.back() === 0 && t.next() === 1 && t.next() === 2 && t.isLast();
      const b = t.back() === 1 && t.next() === 2 && t.finished === null;
      t.next();
      const c = t.finished === "done" && t.next() === 2 && t.back() === 2; // frozen once finished
      return a && b && c;
    })());
    ok("tour: succeed() counts once per scene; skip() ends 'skipped'; reset() clears", (() => {
      const t = tourMod.createTourMachine(3);
      const first = t.succeed(), again = t.succeed();
      const passed0 = t.passed(0) && !t.passed(1);
      t.skip();
      const skipped = t.finished === "skipped" && t.succeed() === false;
      t.next(); // no-op once finished
      const frozen = t.index === 0;
      t.reset();
      return first && !again && passed0 && skipped && frozen && t.finished === null && !t.passed(0);
    })());
    ok("tour: legend accumulates good/close/fix/worst from guideStats and needs good + an off state", (() => {
      const st = (g, c, f, w) => ({ shown: true, counts: { good: g, close: c, fix: f }, worstFinger: w });
      let s = {};
      s = tourMod.accumulateLegend(s, st(5, 0, 0, null));
      const onlyGood = s.good && !s.close && !tourMod.legendComplete(s);
      s = tourMod.accumulateLegend(s, { shown: false, counts: { good: 0, close: 0, fix: 5 } }); // guide not drawn
      const ignored = !s.fix;
      s = tourMod.accumulateLegend(s, st(3, 0, 2, "ring"));
      return onlyGood && ignored && s.fix && s.worst && s.good && tourMod.legendComplete(s) &&
        tourMod.accumulateLegend(s, null) !== s && !tourMod.legendComplete(null);
    })());

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
