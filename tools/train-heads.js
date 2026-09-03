// Trains the small "refinement heads" that clean up kNN's weak pairs
// (M/N and D/O/C) and exports js/heads.json. Run once; re-run if the
// dataset changes. Plain JS, no deps.
//
// Each head is an ensemble of 3 one-hidden-layer MLPs (74 -> 24 -> K) over
// STANDARDISED features. At inference the head only overrides kNN when kNN
// itself predicted a label the head covers.
//
// Validation of the approach (group-aware 20% held-out, see tools/mlp-lab):
//   kNN 95.9%  ->  kNN + heads 97.1%   (M 85->92, N 84->96, D 87->97, O 90->97)

import { loadDataset } from "../js/dataset.js";
import { LETTERS } from "../js/config.js";

const log = (m) => {
  const el = document.getElementById("log");
  el.textContent += m + "\n";
  el.scrollTop = el.scrollHeight;
  console.log(m);
};
const KEEP = new Set(LETTERS);
const SEEDS = 3;
const HID = 24;
const EPOCHS = 60;
const LR0 = 0.05;
const L2 = 3e-4;
const HEADS = [
  ["M", "N"],
  ["D", "O", "C"],
];

function mlp(D, H, K) {
  const r = (n, s) => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * s;
    return a;
  };
  return { D, H, K, W1: r(D * H, Math.sqrt(2 / D)), b1: new Float64Array(H), W2: r(H * K, Math.sqrt(2 / H)), b2: new Float64Array(K) };
}
function fwd(m, x) {
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
function trainOne(m, X, Y) {
  const idx = X.map((_, i) => i);
  for (let e = 0; e < EPOCHS; e++) {
    for (let i = idx.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    const lr = LR0 * (1 - e / EPOCHS) + LR0 * 0.05;
    for (const n of idx) {
      const x = X[n], y = Y[n], { h, o } = fwd(m, x);
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
        for (let k = 0; k < m.K; k++) m.W2[j * m.K + k] -= lr * (dO[k] * hj + L2 * m.W2[j * m.K + k]);
      }
      for (let k = 0; k < m.K; k++) m.b2[k] -= lr * dO[k];
      for (let i = 0; i < m.D; i++) {
        if (x[i] === 0) continue;
        for (let j = 0; j < m.H; j++) {
          if (dH[j] === 0) continue;
          m.W1[i * m.H + j] -= lr * (dH[j] * x[i] + L2 * m.W1[i * m.H + j]);
        }
      }
      for (let j = 0; j < m.H; j++) m.b1[j] -= lr * dH[j];
    }
  }
}

const round = (a, p = 5) => Array.from(a, (x) => +x.toFixed(p));

async function run() {
  log("loading dataset (all rows, no held-out — this is the shipped model)…");
  const ds = await loadDataset("../data/dataset.json");
  const rows = ds.samples.filter((s) => KEEP.has(s.label));
  const D = rows[0].v.length;
  log(`${rows.length} rows, ${D} dims`);

  // standardise from all rows
  const mean = new Float64Array(D), std = new Float64Array(D);
  for (const s of rows) for (let i = 0; i < D; i++) mean[i] += s.v[i];
  for (let i = 0; i < D; i++) mean[i] /= rows.length;
  for (const s of rows) for (let i = 0; i < D; i++) { const d = s.v[i] - mean[i]; std[i] += d * d; }
  for (let i = 0; i < D; i++) std[i] = Math.sqrt(std[i] / rows.length) || 1;
  const norm = (v) => { const o = new Float64Array(D); for (let i = 0; i < D; i++) o[i] = (v[i] - mean[i]) / std[i]; return o; };

  const out = { dims: D, mean: round(mean), std: round(std), heads: [] };

  for (const labels of HEADS) {
    log(`\ntraining [${labels.join("/")}] — ${SEEDS} nets × ${HID} hidden`);
    const sub = rows.filter((s) => labels.includes(s.label));
    const X = sub.map((s) => norm(s.v));
    const Y = sub.map((s) => labels.indexOf(s.label));
    log(`  ${sub.length} rows`);
    const nets = [];
    for (let s = 0; s < SEEDS; s++) {
      const m = mlp(D, HID, labels.length);
      const t0 = performance.now();
      trainOne(m, X, Y);
      // quick self-check (train accuracy — sanity only)
      let ok = 0;
      for (let i = 0; i < X.length; i++) if (labels[argmax(fwd(m, X[i]).o)] === labels[Y[i]]) ok++;
      log(`  net ${s + 1}: train ${((ok / X.length) * 100).toFixed(1)}%  (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
      nets.push({ W1: round(m.W1), b1: round(m.b1), W2: round(m.W2), b2: round(m.b2) });
    }
    out.heads.push({ labels, hid: HID, nets });
  }

  const json = JSON.stringify(out);
  document.getElementById("out").value = json;
  log(`\nexported heads JSON: ${(json.length / 1024).toFixed(1)} KB — copy from the box below into js/heads.json`);
}
const argmax = (a) => { let m = 0; for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i; return m; };

run().catch((e) => log("ERROR: " + e.message + "\n" + e.stack));
