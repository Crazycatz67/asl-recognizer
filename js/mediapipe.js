// Loads the MediaPipe Tasks Vision ES module once and caches it, so every
// other module can `await loadVision()` without re-fetching or worrying about
// import order. Using a dynamic import keeps the version string in config.js
// only (static `import` statements can't take a computed URL).

import { VISION_BUNDLE_URL } from "./config.js";

let modulePromise = null;

export function loadVision() {
  if (!modulePromise) {
    modulePromise = import(VISION_BUNDLE_URL);
  }
  return modulePromise;
}
