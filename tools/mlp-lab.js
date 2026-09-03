// Experiment: a small learned "head" for kNN's weak pairs (M/N, D/O/C).
// Plain JS, no deps. This is a lab — nothing ships unless it clearly wins.
//
// Group-aware split identical to tools/test-knn.js (test = originals only).

import { loadDataset } from "../js/dataset.js";
import { createClassifier } from "../js/knn.js";
import { LETTERS } from "../js/config.js";

const log = (m) => {
  const el = document.getElementById("log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
  console.log(m);
};
const KEEP = new Set(LETTERS);
const argmax = (a) => { let m = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; };

function stratifiedSplit(samples, testFrac) {
  const byLabel = new Map();
  for (const s of samples) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, new Map());
    const groups = byLabel.get(s.label);
    const gid = s.g ?? s;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(s);
  }
  const train = [], test = [];
  for (const groups of byLabel.values()) {
    const ids = [...groups.keys()];
    let seed = 12345 + ids.length;
    for (let i = ids.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const cut = Math.max(1, Math.round(ids.length * testFrac));
    for (let i = 0; i < ids.length; i++) {
      const rows = groups.get(ids[i]);
      if (i < cut) test.push(...rows.filter((r) => !r.rot));
      else train.push(...rows);
    }
  }
  return { train, test };
}

// ---- linear head: softmax(W x + b), plain SGD + cross-entropy --------
function linHead(D, K) {
  return { D, K, W: new Float64Array(D * K), b: new Float64Array(K) };
}
function linFwd(m, x) {
  const o = new Float64Array(m.K);
  let mx = -1e30;
  for (let k = 0; k < m.K; k++) {
    let s = m.b[k];
    for (let i = 0; i < m.D; i++) s += x[i] * m.W[i * m.K + k];
    o[k] = s;
    if (s > mx) mx = s;
  }
  let sum = 0;
  for (let k = 0; k < m.K; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k]; }
  for (let k = 0; k < m.K; k++) o[k] /= sum;
  return o;
}
function linTrain(m, X, Y, { epochs, lr0, l2 }) {
  const idx = X.map((_, i) => i);
  for (let e = 0; e < epochs; e++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const lr = lr0 * (1 - e / epochs) + lr0 * 0.05;
    for (const n of idx) {
      const x = X[n], y = Y[n], o = linFwd(m, x);
      for (let k = 0; k < m.K; k++) {
        const g = o[k] - (k === y ? 1 : 0);
        m.b[k] -= lr * g;
        if (g === 0) continue;
        for (let i = 0; i < m.D; i++) {
          if (x[i] === 0) continue;
          m.W[i * m.K + k] -= lr * (g * x[i] + l2 * m.W[i * m.K + k]);
        }
      }
    }
  }
}

// ---- 1-hidden MLP: softmax(W2 relu(W1 x + b1) + b2) -----------------
function mlpHead(D, H, K) {
  const r = (n, s) => { const a = new Float64Array(n); for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * s; return a; };
  return { D, H, K, W1: r(D * H, Math.sqrt(2 / D)), b1: new Float64Array(H), W2: r(H * K, Math.sqrt(2 / H)), b2: new Float64Array(K) };
}
function mlpFwd(m, x) {
  const h = new Float64Array(m.H);
  for (let j = 0; j < m.H; j++) {
    let s = m.b1[j];
    for (let i = 0; i < m.D; i++) s += x[i] * m.W1[i * m.H + j];
    h[j] = s > 0 ? s : 0;
  }
  const o = new Float64Array(m.K);
  let mx = -1e30;
  for (let k = 0; k < m.K; k++) {
    let s = m.b2[k];
    for (let j = 0; j < m.H; j++) s += h[j] * m.W2[j * m.K + k];
    o[k] = s;
    if (s > mx) mx = s;
  }
  let sum = 0;
  for (let k = 0; k < m.K; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k]; }
  for (let k = 0; k < m.K; k++) o[k] /= sum;
  return { h, o };
}
function mlpTrain(m, X, Y, { epochs, lr0, l2 }) {
  const idx = X.map((_, i) => i);
  for (let e = 0; e < epochs; e++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const lr = lr0 * (1 - e / epochs) + lr0 * 0.05;
    for (const n of idx) {
      const x = X[n], y = Y[n], { h, o } = mlpFwd(m, x);
      const dO = new Float64Array(m.K);
      for (let k = 0; k < m.K; k++) dO[k] = o[k] - (k === y ? 1 : 0);
      const dH = new Float64Array(m.H);
      for (let j = 0; j < m.H; j++) {
        if (h[j] <= 0) continue;
        let s = 0;
        for (let k = 0; k < m.K; k++) s += dO[k] * m.W2[j * m.K + k];
        dH[j] = s;
      }
      for (let j = 0; j < m.H; j++) {
        const hj = h[j];
        for (let k = 0; k < m.K; k++) m.W2[j * m.K + k] -= lr * (dO[k] * hj + l2 * m.W2[j * m.K + k]);
      }
      for (let k = 0; k < m.K; k++) m.b2[k] -= lr * dO[k];
      for (let i = 0; i < m.D; i++) {
        if (x[i] === 0) continue;
        for (let j = 0; j < m.H; j++) {
          if (dH[j] === 0) continue;
          m.W1[i * m.H + j] -= lr * (dH[j] * x[i] + l2 * m.W1[i * m.H + j]);
        }
      }
      for (let j = 0; j < m.H; j++) m.b1[j] -= lr * dH[j];
    }
  }
}

async function run() {
  log("loading dataset…");
  const ds = await loadDataset("../data/dataset.json");
  const usable = ds.samples
    .filter((s) => KEEP.has(s.label))
    .map((s) => ({ label: s.label, v: s.v, g: s.g, rot: s.rot }));
  const { train, test } = stratifiedSplit(usable, 0.2);
  log(`train ${train.length} · test ${test.length} originals`);

  const classes = [...LETTERS];
  const cIdx = new Map(classes.map((c, i) => [c, i]));

  const D = train[0].v.length;
  const mean = new Float64Array(D), std = new Float64Array(D);
  for (const s of train) for (let i = 0; i < D; i++) mean[i] += s.v[i];
  for (let i = 0; i < D; i++) mean[i] /= train.length;
  for (const s of train) for (let i = 0; i < D; i++) { const d = s.v[i] - mean[i]; std[i] += d * d; }
  for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / train.length) || 1;
  const norm = (v) => { const o = new Float64Array(D); for (let i = 0; i < D; i++) o[i] = (v[i] - mean[i]) / std[i]; return o; };

  const Xtr = train.map((s) => norm(s.v));
  const Xte = test.map((s) => norm(s.v));
  const Yte = test.map((s) => cIdx.get(s.label));

  const perLetter = (predFn) => {
    const hit = {}, tot = {};
    for (const c of classes) { hit[c] = 0; tot[c] = 0; }
    let ok = 0;
    for (let i = 0; i < Xte.length; i++) {
      tot[classes[Yte[i]]]++;
      if (predFn(i) === Yte[i]) { ok++; hit[classes[Yte[i]]]++; }
    }
    return { acc: ok / Xte.length, hit, tot };
  };
  const pct = (h, t) => ((h / t) * 100).toFixed(0);

  log("\n== baseline kNN (k=5) ==");
  const knn = createClassifier(train, { k: 5 });
  const knnPred = test.map((s) => cIdx.get(knn.classify(s.v).label));
  const kb = perLetter((i) => knnPred[i]);
  log(`overall ${(kb.acc * 100).toFixed(1)}%   M ${pct(kb.hit.M, kb.tot.M)}  N ${pct(kb.hit.N, kb.tot.N)}  D ${pct(kb.hit.D, kb.tot.D)}  O ${pct(kb.hit.O, kb.tot.O)}`);

  // ---- focused heads, averaged over seeds ----
  function buildHead(labels, kind, seeds = 3) {
    const trIdx = [];
    for (let i = 0; i < train.length; i++) if (labels.includes(train[i].label)) trIdx.push(i);
    const X = trIdx.map((i) => Xtr[i]);
    const Y = trIdx.map((i) => labels.indexOf(train[i].label));
    const nets = [];
    for (let s = 0; s < seeds; s++) {
      const m = kind === "lin" ? linHead(D, labels.length) : mlpHead(D, 24, labels.length);
      (kind === "lin" ? linTrain : mlpTrain)(m, X, Y, { epochs: 60, lr0: 0.05, l2: 3e-4 });
      nets.push(m);
    }
    const fwd = kind === "lin" ? (m, x) => linFwd(m, x) : (m, x) => mlpFwd(m, x).o;
    const predict = (x) => {
      const acc = new Float64Array(labels.length);
      for (const m of nets) { const o = fwd(m, x); for (let k = 0; k < labels.length; k++) acc[k] += o[k]; }
      return labels[argmax(acc)];
    };
    // own-pair held-out
    let ok = 0, n = 0;
    for (let i = 0; i < test.length; i++) {
      if (!labels.includes(test[i].label)) continue;
      n++;
      if (predict(Xte[i]) === test[i].label) ok++;
    }
    const bytes = nets.reduce((a, m) => a + (m.W ? m.W.length : m.W1.length + m.W2.length) * 4, 0);
    log(`  [${labels.join("/")}] ${kind} x${seeds}: own held-out ${((ok / n) * 100).toFixed(1)}% (${ok}/${n}) · ~${(bytes / 1024).toFixed(1)}KB`);
    return predict;
  }

  for (const kind of ["lin", "mlp"]) {
    log(`\n== two-stage: kNN + ${kind} heads ==`);
    const mn = buildHead(["M", "N"], kind);
    const doc = buildHead(["D", "O", "C"], kind);
    const combined = test.map((s, i) => {
      const p = knn.classify(s.v).label;
      if (p === "M" || p === "N") return cIdx.get(mn(Xte[i]));
      if (p === "D" || p === "O" || p === "C") return cIdx.get(doc(Xte[i]));
      return cIdx.get(p);
    });
    const tb = perLetter((i) => combined[i]);
    log(`  overall ${(tb.acc * 100).toFixed(1)}%  (kNN ${(kb.acc * 100).toFixed(1)}%)`);
    for (const c of ["M", "N", "D", "O", "C"])
      log(`    ${c}: ${pct(kb.hit[c], kb.tot[c])}% -> ${pct(tb.hit[c], tb.tot[c])}%`);
  }

  log("\ndone.");
}

run().catch((e) => log("ERROR: " + e.message + "\n" + e.stack));
