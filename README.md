# ASL Fingerspelling Recognizer

Browser-only recognizer for static ASL fingerspelling (A–Z + J/Z motion
letters). MediaPipe `HandLandmarker` for tracking + a plain-JS kNN classifier
(with learned refinement heads for M/N and D/O/C) on normalized landmark
vectors. No backend, no build step, no framework.

Four modes: **Practice** (learn one letter, live camera feedback), **Challenge**
(a random letter + shrinking timer), **Spell** (continuous fingerspelling →
words/sentences, optionally spoken aloud), **Read** (no camera — watch a word
spelled out, type what you saw; includes a full taught-order Course). Installs
as an offline-capable PWA.

## Run locally

The camera needs a secure context. `http://localhost` counts; a bare file on
disk does not, and `file://` camera access is unreliable across browsers.

**Easiest (Windows, no installs):** double-click `start-server.cmd`. It runs a
tiny pure-PowerShell static server and opens <http://localhost:8000/index.html>.
Close the window to stop.

**Manual:** run `serve.ps1` (PowerShell) or any static server — `npx serve`,
VS Code Live Server, `python -m http.server 8000` — then open the localhost URL.

## Test on a phone

**Same Wi-Fi, no accounts:** double-click `start-phone.cmd`. It serves HTTPS on
your LAN with a self-signed cert and prints a `https://<your-ip>:8443` URL. On
the phone, open that URL, tap through the "not private" warning once, allow the
camera. Allow the Windows Firewall prompt the first time.

**Anywhere / shareable link:** drag this folder onto <https://app.netlify.com/drop>
for an instant public HTTPS URL. No install; works on any device, any network.

## Deploy

`git push` to `main` deploys to GitHub Pages (`crazycatz67.github.io/asl-recognizer`).
**Bump `VERSION` in `sw.js` on every deploy** — the service worker precaches
the whole app for offline use, and without a version bump, existing installs
keep serving the old cached shell instead of picking up new bytes.

See `asl-letter-recognition-plan.md` for the live status table, decisions log,
full backlog, and stage-by-stage history — it's the actual source of truth for
this project, updated every session. This README stays high-level.

### How recognition works

`index.html` fetches `data/dataset.json` on start; if present, recognition
turns on (skeleton-only without it). Each frame: landmarks → `js/normalize.js`
(63 coords + 11 engineered shape features, left hands folded to right) →
`js/knn.js` → `js/heads.js` (learned per-letter refinement, fixes M/N and
D/O/C) → `js/stabilizer.js` (a letter confirms only after it holds
`STABLE_FRAMES` frames) → `js/overlay.js` draws it. Spell mode's fluid
(continuous-signing) path swaps the stabilizer for `js/transition.js`
(commits a letter when the hand *settles after a move*, since real signing
speed never holds still) feeding `js/speller.js` → `js/decode.js` (trie + beam
search → words/sentences, optionally spoken via `speechSynthesis`).
Tunables live in `js/config.js`.

The reusable engine core (`normalize`, `knn`, `dataset`, `stabilizer`,
`transition`, `decode`, `speller`, `curriculum`, `spelldrill`, `reader`,
`motion`, `swipe`, `twohand`, `heads`, `refine`) is DOM-free — it runs under
plain Node as well as the browser, which is what `tools/ci-check.mjs` and
`tools/sweep-transition.mjs` rely on.

### Testing

Open **`tools/selftest.html`** on the dev server after any change — it asserts
every module's API and runs the live pipeline (164 checks). `tools/test-knn.html`
is the accuracy / confusion-matrix harness; `tools/replay-lab.html` and
`tools/sweep-transition.mjs` replay real recorded sequences through the full
pipeline (see the domain-gap note in the plan doc before trusting absolute
numbers from either). `node tools/ci-check.mjs` runs a free, dependency-free
integrity pass (syntax, service-worker cache-list consistency, dataset
well-formedness) — also runs automatically in GitHub Actions on every push.

### Rebuilding the dataset

`data/dataset.json` is built from the Kaggle `grassknoted/asl-alphabet`
images. Primary path this project used: a manifest + browser-driven
extraction pass (see the plan's revision history). `tools/extract.html` is the
manual folder-picker fallback for topping up specific weak letters. Both
produce the same `{ label, v: [74 floats] }` rows. `data/_src/` (gitignored)
holds the source images, kept for M/N/D top-ups.

## File layout

```
index.html              page shell: topbar, viewport, per-mode panels, overlays
manifest.webmanifest     PWA manifest
sw.js                    service worker: offline precache + stale-while-revalidate
start-server.cmd         double-click launcher (Windows) -> serve.ps1 + open browser
start-phone.cmd          double-click launcher for LAN HTTPS phone testing
serve.ps1                dependency-free HTTP static server (localhost, desktop)
serve-https.ps1          LAN HTTPS server w/ self-signed cert (phone, in-process TLS)
css/style.css            styling; state-driven via [data-state]/[data-mode] attributes
js/config.js             CDN URLs, model path, TARGET_FPS, all tunable thresholds
js/main.js               the state machine: camera loop + all 4 modes' UI wiring
js/camera.js             getUserMedia wrapper + camera enumeration
js/handTracker.js        HandLandmarker setup + per-frame detect()
js/mediapipe.js          one cached dynamic import of tasks-vision
js/normalize.js          shared landmark normalization (dataset build + live)
js/dataset.js            loads + validates data/dataset.json
js/knn.js                k-nearest-neighbours classifier
js/heads.js / refine.js  learned + rule-based confusion refinement (M/N, D/O/C)
js/stabilizer.js         temporal smoothing: confirm a letter only after it holds
js/transition.js         rhythm-based segmentation for continuous (fluid) signing
js/overlay.js            live-camera canvas: skeleton + per-joint correction guide
js/skeleton.js           shared 21-point hand rendering (live overlay + demos)
js/reference.js          per-letter shape scoring + the animated demo-hand player
js/motion.js             J/Z motion-letter stroke matching
js/swipe.js / twohand.js Spell-mode gestures: delete-sweep, copy/paste
js/speller.js            Spell mode's word/transcript buffer
js/decode.js             letter stream -> words/sentences (trie + beam search)
js/challenge.js          the timed speed-game mode
js/reader.js             Read mode's word pool + scoring
js/curriculum.js         Read mode's taught-order Course (tiers, unlock gating)
js/spelldrill.js         Spell mode's "practice a word" drill
js/sound.js / fx.js / bg.js   synthesized audio, particle bursts, reactive background
tools/selftest.html      component self-test — run after every change (164 checks)
tools/test-knn.html      offline accuracy + confusion matrix
tools/extract.html       manual folder-picker fallback for topping up weak letters
tools/replay-lab.html    full pipeline vs. real recorded sequences (browser)
tools/sweep-transition.mjs  transition.js threshold sweep (plain Node, free)
tools/ci-check.mjs       dependency-free integrity checks (plain Node, free)
data/dataset.json        training vectors, 74-dim, 24 static letters
data/fs_sequences.json   300 real recorded sequences (domain-gap caveat — see plan doc)
data/_src/               (gitignored) source images kept for weak-letter top-ups
.github/workflows/ci.yml runs tools/ci-check.mjs on every push/PR
```
