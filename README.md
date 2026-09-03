# ASL Fingerspelling Recognizer

Browser-only recognizer for static ASL fingerspelling (A–Z). MediaPipe
`HandLandmarker` for tracking + a plain-JS kNN classifier on normalized
landmark vectors. No backend, no build step.

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

Push the folder to GitHub Pages or drop it on Netlify. Both serve HTTPS, which
real phones/laptops require for camera access.

See `asl-letter-recognition-plan.md` for the live status table, decisions log,
and stage detail. Short version:

| Stage | Status |
|-------|--------|
| 1 Camera + 21-point skeleton | ✅ done, confirmed live |
| 2 Training data (`data/dataset.json`) | ✅ done — 6321 samples, 74-dim, from Kaggle `grassknoted/asl-alphabet` |
| 3 kNN `classify(vector) → letter` | ✅ done — **95.7%** offline (24 letters, held-out); `tools/test-knn.html` |
| 4 Live inference + letter overlay + stability | code done; needs a real-webcam confirm |
| 5 Per-letter + confusion + skin-tone detection check | offline half done; live half pending |
| Practice / reference page | next |
| 6 Words + J/Z (stretch) | — |

### How recognition works

`index.html` fetches `data/dataset.json` on start; if present, recognition turns
on (skeleton-only without it). Each frame: landmarks → `js/normalize.js` (63
coords + 11 shape features, left hands folded to right) → `js/knn.js` → 
`js/stabilizer.js` (a letter shows only after it holds `STABLE_FRAMES` frames) →
`js/overlay.js` draws it. Tunables live in `js/config.js` — check `k` offline in
`tools/test-knn.html` before trusting the live view.

The reusable core (`normalize.js`, `knn.js`, `dataset.js`, `stabilizer.js`) is
UI-free so other pages can consume it directly.

### Testing

Open **`tools/selftest.html`** on the dev server after any change — it asserts
every module's API and runs the live pipeline (35 checks). `tools/test-knn.html`
is the accuracy / confusion-matrix harness.

### Rebuilding the dataset

`data/dataset.json` is built from the Kaggle `grassknoted/asl-alphabet` images.
Primary path this project used: a manifest + browser-driven extraction pass
(see the plan's revision history). `tools/extract.html` is the manual
folder-picker fallback for topping up specific weak letters. Both produce the
same `{ label, v: [74 floats] }` rows. `data/_src/` (gitignored) holds the
source images, kept for M/N/D top-ups; delete once the dataset is finalised.

## File layout

```
index.html          page shell: viewport, HUD pill, curtain/CTA, controls
start-server.cmd    double-click launcher (Windows) -> serve.ps1 + open browser
start-phone.cmd     double-click launcher for LAN HTTPS phone testing
serve.ps1           dependency-free HTTP static server (localhost, desktop)
serve-https.ps1     LAN HTTPS server w/ self-signed cert (phone, in-process TLS)
css/style.css       styling; state-driven via [data-state] on .viewport
js/config.js        CDN URLs, model path, TARGET_FPS, hysteresis constants
js/mediapipe.js     one cached dynamic import of tasks-vision
js/camera.js        getUserMedia wrapper + camera enumeration helpers
js/handTracker.js   HandLandmarker setup + per-frame detect() (VIDEO mode)
js/normalize.js     shared landmark normalization (extraction + live)
js/overlay.js       canvas drawing: skeleton + big confirmed letter
js/dataset.js       loads + validates data/dataset.json
js/knn.js           k-nearest-neighbours classifier (packed Float32Array)
js/stabilizer.js    temporal smoothing: confirm a letter only after it holds
js/main.js          state machine + camera→landmarks→classify→overlay loop
tools/selftest.html component self-test — run after every change (35 checks)
tools/test-knn.html Stage 3/5 — offline accuracy + confusion matrix
tools/extract.html  manual folder-picker fallback for topping up weak letters
data/dataset.json   6321 landmark vectors, 74-dim, 24 letters + J/Z/space
data/_src/          (gitignored) source images kept for weak-letter top-ups
```
