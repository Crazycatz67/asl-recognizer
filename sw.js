// Service worker — makes the app installable and usable offline (backlog B8).
//
// Strategy:
//   • navigations      -> network first, fall back to the cached index.html
//   • same-origin GET  -> cache first, then network (and cache the result)
//   • MediaPipe CDN    -> cache first (the wasm bundle + the hand-landmarker
//                         model are big and immutable; grab them on first use)
//
// BUMP `VERSION` on every deploy so old caches are cleared. Paths are relative
// so this works both at "/" (dev) and "/asl-recognizer/" (GitHub Pages).

const VERSION = "v42";
const SHELL = `asl-shell-${VERSION}`;
const RUNTIME = `asl-runtime-${VERSION}`;
const MP = `asl-mediapipe-${VERSION}`;
const KEEP = new Set([SHELL, RUNTIME, MP]);

// Small, must-succeed: the app won't boot without these.
const CORE = [
  "./",
  "./index.html",
  "./about.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/bg.js", "./js/camera.js", "./js/challenge.js", "./js/config.js",
  "./js/curriculum.js", "./js/dataset.js", "./js/decode.js", "./js/fx.js",
  "./js/handTracker.js", "./js/heads.js", "./js/heads.json", "./js/knn.js",
  "./js/main.js", "./js/mediapipe.js", "./js/motion.js", "./js/normalize.js",
  "./js/overlay.js", "./js/reader.js", "./js/reference.js", "./js/refine.js",
  "./js/skeleton.js", "./js/sound.js", "./js/spelldrill.js", "./js/speller.js",
  "./js/stabilizer.js", "./js/swipe.js", "./js/transition.js", "./js/twohand.js",
  "./icons/icon-192.png", "./icons/icon-512.png",
  "./icons/icon-maskable-512.png", "./icons/apple-touch-icon.png",
];

// Larger, best-effort: nice to have offline, but don't fail the install for them.
const EXTRA = [
  "./data/dataset.json",
  "./data/practice-words.json",
  "./data/curriculum.json",
  "./data/confusion.json",
  "./data/words25k.txt",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((L) => `./assets/reference/${L}.jpg`),
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(SHELL);
      await c.addAll(CORE);
      await Promise.allSettled(EXTRA.map((u) => c.add(u)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

const MP_HOSTS = new Set(["cdn.jsdelivr.net", "storage.googleapis.com"]);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isMP = MP_HOSTS.has(url.hostname);
  if (!sameOrigin && !isMP) return; // let anything else hit the network normally

  // App navigations: fresh HTML when online; offline -> the cached page itself
  // (about.html stays about.html), and only then index.html as a last resort.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).catch(async () =>
        (await caches.match(req, { ignoreSearch: true })) ||
        (await caches.match("./index.html", { ignoreSearch: true }))
      )
    );
    return;
  }

  // MediaPipe CDN assets are immutable (version is in the URL) -> pure cache-first.
  if (isMP) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res && (res.ok || res.type === "opaque")) {
              const copy = res.clone();
              caches.open(MP).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // Same-origin -> stale-while-revalidate: serve the cached copy now, refresh it
  // in the background so the next load has the new bytes. Falls back to cache
  // when offline; only misses if it was never cached and we're offline.
  e.respondWith(
    (async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })()
  );
});
