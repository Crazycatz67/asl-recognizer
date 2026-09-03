// Offline (one-time) dataset extraction, run entirely in the browser.
//
// Walks a chosen dataset folder, runs HandLandmarker in IMAGE mode over a
// subsample of each label's images, normalizes with the SAME function live
// inference uses, and downloads dataset.json.

import { loadVision } from "../js/mediapipe.js";
import {
  WASM_BASE_URL,
  HAND_MODEL_URL,
  MEDIAPIPE_VERSION,
  USE_EXTENDED_FEATURES,
} from "../js/config.js";
import { normalizeLandmarks, aspectOf } from "../js/normalize.js";

const dirInput = document.getElementById("dir");
const perLabelInput = document.getElementById("perLabel");
const runBtn = document.getElementById("run");
const bar = document.getElementById("bar");
const logEl = document.getElementById("log");
const outEl = document.getElementById("out");

const IMAGE_RE = /\.(jpe?g|png|bmp|webp)$/i;
const KEYWORDS = new Set(["space", "del", "nothing"]);

let grouped = null; // Map<label, File[]>

function log(msg) {
  logEl.value += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
}

// Folder name -> label. Single A–Z letters are uppercased; the three keyword
// folders are kept lowercase; anything else is ignored.
function labelFromFolder(folder) {
  const f = folder.trim();
  if (/^[A-Za-z]$/.test(f)) return f.toUpperCase();
  if (KEYWORDS.has(f.toLowerCase())) return f.toLowerCase();
  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

dirInput.addEventListener("change", () => {
  grouped = new Map();
  for (const file of dirInput.files) {
    if (!IMAGE_RE.test(file.name)) continue;
    const parts = file.webkitRelativePath.split("/");
    const label = labelFromFolder(parts[parts.length - 2] ?? "");
    if (!label) continue;
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label).push(file);
  }

  logEl.value = "";
  if (grouped.size === 0) {
    log("No labelled image folders found in that selection.");
    runBtn.disabled = true;
    return;
  }
  const summary = [...grouped.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v.length}`)
    .join("  ");
  log(`Found ${grouped.size} labels — ${summary}`);
  runBtn.disabled = false;
});

async function createImageDetector() {
  const { HandLandmarker, FilesetResolver } = await loadVision();
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  const build = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "IMAGE",
      numHands: 1,
    });
  try {
    return { detector: await build("GPU"), delegate: "GPU" };
  } catch (err) {
    log("GPU delegate unavailable, using CPU (slower).");
    return { detector: await build("CPU"), delegate: "CPU" };
  }
}

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  dirInput.disabled = true;
  outEl.innerHTML = "";

  const perLabel = Math.max(10, Number(perLabelInput.value) || 300);
  log(`\nLoading HandLandmarker…`);
  const { detector, delegate } = await createImageDetector();
  log(`Ready (${delegate}). Extracting up to ${perLabel} images per label.\n`);

  // Build the work list: a capped, shuffled subsample per label.
  const work = [];
  for (const [label, files] of grouped) {
    const picked = shuffle(files.slice()).slice(0, perLabel);
    for (const file of picked) work.push({ label, file });
  }
  bar.max = work.length;
  bar.value = 0;

  const samples = [];
  const labelCounts = {};
  const missCounts = {};
  const started = performance.now();

  for (let i = 0; i < work.length; i++) {
    const { label, file } = work[i];
    try {
      const bmp = await createImageBitmap(file);
      const result = detector.detect(bmp);
      bmp.close();

      if (result.landmarks && result.landmarks.length > 0) {
        const hand = result.handedness?.[0]?.[0]?.categoryName ?? "Unknown";
        // Must match the primary build: canonicalize left hands to right,
        // and append the engineered features when they're enabled.
        const v = normalizeLandmarks(result.landmarks[0], {
          aspect: aspectOf(bmp),
          mirrorX: hand === "Left",
          extended: USE_EXTENDED_FEATURES,
        });
        samples.push({
          label,
          v: v.map((n) => Math.round(n * 1e5) / 1e5),
        });
        labelCounts[label] = (labelCounts[label] || 0) + 1;
      } else {
        missCounts[label] = (missCounts[label] || 0) + 1;
      }
    } catch (err) {
      missCounts[label] = (missCounts[label] || 0) + 1;
    }

    if (i % 25 === 0 || i === work.length - 1) {
      bar.value = i + 1;
      await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
    }
    if (i > 0 && i % 500 === 0) {
      log(`  …${i}/${work.length} processed, ${samples.length} kept`);
    }
  }

  detector.close?.();

  const secs = ((performance.now() - started) / 1000).toFixed(1);
  log(`\nDone in ${secs}s. Kept ${samples.length} samples.`);
  log("Per label (kept / no-hand):");
  for (const label of Object.keys(labelCounts).concat(Object.keys(missCounts))
    .filter((v, idx, a) => a.indexOf(v) === idx)
    .sort()) {
    log(`  ${label.padEnd(8)} ${String(labelCounts[label] || 0).padStart(4)} / ${missCounts[label] || 0}`);
  }

  const payload = {
    created: new Date().toISOString(),
    mediapipeVersion: MEDIAPIPE_VERSION,
    normalization:
      "wrist-centered, aspect-corrected, hand-size scaled; left hands canonicalized to right",
    extendedFeatures: USE_EXTENDED_FEATURES,
    vectorLength: samples[0]?.v.length ?? (USE_EXTENDED_FEATURES ? 74 : 63),
    count: samples.length,
    labelCounts,
    samples,
  };

  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const sizeMB = (blob.size / 1e6).toFixed(1);
  outEl.innerHTML =
    `<p><a class="download" href="${url}" download="dataset.json">` +
    `Download dataset.json (${sizeMB} MB)</a> — then save it to ` +
    `<code>data/dataset.json</code>.</p>`;

  runBtn.disabled = false;
  dirInput.disabled = false;
});
