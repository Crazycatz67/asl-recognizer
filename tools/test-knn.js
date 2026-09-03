// Offline evaluation for the kNN classifier. Stratified train/test split,
// per-letter accuracy, and a confusion matrix so we can see which letters
// get mixed up (Stage 5's job starts here).

import { loadDataset } from "../js/dataset.js";
import { createClassifier } from "../js/knn.js";
import { LETTERS } from "../js/config.js";

const KEEP = new Set(LETTERS);

const kEl = document.getElementById("k");
const kOut = document.getElementById("kOut");
const splitEl = document.getElementById("split");
const splitOut = document.getElementById("splitOut");
const runBtn = document.getElementById("run");
const statusEl = document.getElementById("status");
const accEl = document.getElementById("acc");
const perLetterEl = document.getElementById("perLetter");
const confusedEl = document.getElementById("confused");
const matrixEl = document.getElementById("matrix");

let dataset = null;

kEl.addEventListener("input", () => (kOut.textContent = kEl.value));
splitEl.addEventListener("input", () => (splitOut.textContent = splitEl.value));
runBtn.addEventListener("click", run);

// Left hands are canonicalized to right-hand geometry at build time.
//
// Group-aware split: rotation-augmented rows carry the same `g` (group id) as
// the original hand they came from. We split on groups so a test hand's rotated
// copies never leak into training. TEST = originals only (rot falsy); TRAIN =
// every row (originals + rotated copies) whose group is in the training set.
function stratifiedSplit(samples, testFrac) {
  const byLabel = new Map();
  for (const s of samples) {
    if (!byLabel.has(s.label)) byLabel.set(s.label, new Map());
    const groups = byLabel.get(s.label);
    const gid = s.g ?? s; // no group id -> treat the row as its own group
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(s);
  }

  const train = [];
  const test = [];
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

async function run() {
  runBtn.disabled = true;
  try {
    if (!dataset) {
      statusEl.textContent = "Loading ../data/dataset.json …";
      dataset = await loadDataset("../data/dataset.json");
    }

    const k = +kEl.value;
    const testFrac = +splitEl.value / 100;

    // Keep only the 24 static letters (drop J/Z/space — see config.LETTERS).
    const usable = dataset.samples
      .filter((s) => KEEP.has(s.label))
      .map((s) => ({ label: s.label, v: s.v, g: s.g, rot: s.rot }));
    const { train, test } = stratifiedSplit(usable, testFrac);
    const augN = train.filter((s) => s.rot).length;
    statusEl.textContent =
      `${usable.length} rows (24 letters) · train ${train.length} (${augN} rotated) · test ${test.length} originals · k=${k}`;

    const clf = createClassifier(train, { k });
    const classes = clf.classes;
    const idx = new Map(classes.map((c, i) => [c, i]));
    const confusion = classes.map(() => new Array(classes.length).fill(0));

    let correct = 0;
    for (const s of test) {
      const pred = clf.classify(s.v);
      confusion[idx.get(s.label)][idx.get(pred.label)]++;
      if (pred.label === s.label) correct++;
    }

    const acc = correct / test.length;
    accEl.textContent = (acc * 100).toFixed(1) + "%";

    // per-letter
    perLetterEl.innerHTML = "";
    const perLetter = [];
    classes.forEach((c, r) => {
      const row = confusion[r];
      const total = row.reduce((a, b) => a + b, 0);
      const a = total ? row[r] / total : 0;
      perLetter.push({ c, a, total });
      const span = document.createElement("span");
      span.textContent = `${c} ${(a * 100).toFixed(0)}%`;
      if (a < 0.7) span.className = "bad";
      else if (a < 0.9) span.className = "warn";
      perLetterEl.appendChild(span);
    });

    // most-confused ordered pairs
    const pairs = [];
    classes.forEach((ca, r) => {
      classes.forEach((cb, c) => {
        if (r !== c && confusion[r][c] > 0) {
          const total = confusion[r].reduce((a, b) => a + b, 0);
          pairs.push({ a: ca, b: cb, n: confusion[r][c], rate: confusion[r][c] / total });
        }
      });
    });
    pairs.sort((x, y) => y.rate - x.rate);
    confusedEl.innerHTML =
      pairs
        .slice(0, 12)
        .map((p) => `${p.a} &rarr; ${p.b} (${(p.rate * 100).toFixed(0)}%, n=${p.n})`)
        .join("<br>") || "none";

    // matrix
    renderMatrix(classes, confusion);
  } catch (err) {
    statusEl.textContent =
      err.status === 404
        ? "No ../data/dataset.json yet — run tools/extract.html first."
        : "Error: " + err.message;
  } finally {
    runBtn.disabled = false;
  }
}

function renderMatrix(classes, confusion) {
  const head =
    "<tr><th></th>" + classes.map((c) => `<th>${c}</th>`).join("") + "</tr>";
  const rows = classes
    .map((ca, r) => {
      const rowTotal = confusion[r].reduce((a, b) => a + b, 0) || 1;
      const cells = classes
        .map((cb, c) => {
          const n = confusion[r][c];
          let cls = "";
          if (r === c && n) cls = "diag";
          else if (n / rowTotal > 0.15) cls = "hot";
          return `<td class="${cls}">${n || ""}</td>`;
        })
        .join("");
      return `<tr><th>${ca}</th>${cells}</tr>`;
    })
    .join("");
  matrixEl.innerHTML = head + rows;
}

// auto-run once on load
run();
