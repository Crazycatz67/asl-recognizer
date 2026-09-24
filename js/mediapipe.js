// =============================================================================
// js/mediapipe.js — one-time loader for the MediaPipe Tasks Vision module
// =============================================================================
// WHAT: Loads the MediaPipe Tasks Vision ES module once and caches it, so
//   every other module can `await loadVision()` without re-fetching or
//   worrying about import order. Using a dynamic import keeps the version
//   string in config.js only (static `import` statements can't take a
//   computed URL).
//
// PIPELINE: support for handTracker.js (the live app) and tools/extract.js
//   (the offline dataset build) — both need the same MediaPipe build.
//
// PUBLIC API:
//   loadVision() → Promise<module>  (exports HandLandmarker, FilesetResolver, …)
//
// GOTCHA: fetches from the CDN URL in config.js VISION_BUNDLE_URL, so the
//   first call needs network (the service worker caches it for offline use
//   after that). A failed import stays cached as a rejected promise until
//   the page reloads.

import { VISION_BUNDLE_URL } from "./config.js";

let modulePromise = null;

/**
 * Import the MediaPipe Tasks Vision bundle (once; later calls share the promise).
 * @returns {Promise<any>} the ES module namespace
 */
export function loadVision() {
  if (!modulePromise) {
    modulePromise = import(VISION_BUNDLE_URL);
  }
  return modulePromise;
}
