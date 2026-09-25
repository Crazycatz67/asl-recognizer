// =============================================================================
// js/fxquality.js — effects budget + quality governor (visual layer v2, B0)
// =============================================================================
// WHY: MediaPipe's GPU delegate shares the GPU with every visual effect. Hand
//   detection must stay ~30/s or recognition gets worse, so every effect asks
//   this governor how much it may do: "full" | "lite" | "off".
//
// RULES (auto):
//   - prefers-reduced-motion          -> off (effects show static equivalents)
//   - tab hidden                      -> off (effects pause)
//   - no WebGL2                       -> lite at most
//   - Race (two hands tracked)        -> lite at most (heaviest detection load)
//   - camera on and >= 3 frame stalls (> 50 ms between frames) within 5 s
//     -> lite too ("degraded"): the fps average hides short spikes, which
//     are what the owner felt as lag (2026-09-25); reportJank() from loop().
//   - camera on and detection fps < 26 for 3 s -> lite ("degraded"); it
//     recovers after 10 s of healthy (>= 26) fps. fps reports only count
//     while the camera is on; turning the camera off clears the timers but
//     keeps a degraded verdict (the machine was too slow a moment ago).
//   - manual override "lite" / "off" caps the result; "auto" (default) and
//     "full" don't cap (full still obeys reduced motion / hidden / Race /
//     no-WebGL2 — the owner can't force the GPU past what detection needs).
//
// PURE: the state machine takes `now` explicitly, so selftest/ci-check drive
//   it with a fake clock. The only DOM bit is mountFxDebug() (?debug readout).
//
// PUBLIC API:
//   const gov = createGovernor({ override, reducedMotion, webgl2, hidden, mode });
//   gov.level                      -> "full" | "lite" | "off"
//   gov.set({ override?, reducedMotion?, webgl2?, hidden?, mode? }, now?)
//   gov.reportFps(fps, cameraOn, now)   // call ~2x/s from the detection loop
//   gov.subscribe(fn) -> unsubscribe   // fn(level, prevLevel) on every change
//   gov.cost(name, ms)             // effects report their per-frame ms (EMA)
//   gov.costs()                    -> { name: emaMs }
//   gov.state()                    -> debugging snapshot
//   OVERRIDES, LOW_FPS, DROP_MS, RESTORE_MS

export const OVERRIDES = ["auto", "full", "lite", "off"];
export const LOW_FPS = 26;
export const DROP_MS = 3000;
export const RESTORE_MS = 10000;
export const JANK_MS = 50; // a frame gap longer than this is a stall
export const JANK_COUNT = 3; // this many stalls ...
export const JANK_WINDOW_MS = 5000; // ... within this window -> lite

const RANK = { off: 0, lite: 1, full: 2 };
const cap = (a, b) => (RANK[a] <= RANK[b] ? a : b);

export function createGovernor({
  override = "auto",
  reducedMotion = false,
  webgl2 = true,
  hidden = false,
  mode = null,
} = {}) {
  const env = { override: OVERRIDES.includes(override) ? override : "auto", reducedMotion, webgl2, hidden, mode };
  let degraded = false;
  let lowSince = null; // when fps first dipped below LOW_FPS (camera on)
  let okSince = null; // when fps first came back >= LOW_FPS while degraded
  let lastFps = null;
  let jank = []; // recent stall timestamps
  let lastJank = -Infinity;
  let level = compute();
  const subs = new Set();
  const costs = new Map();

  function compute() {
    if (env.override === "off" || env.reducedMotion || env.hidden) return "off";
    let l = "full";
    if (env.override === "lite") l = "lite";
    if (!env.webgl2) l = cap(l, "lite");
    if (env.mode === "race") l = cap(l, "lite");
    if (degraded) l = cap(l, "lite");
    return l;
  }
  function publish() {
    const next = compute();
    if (next === level) return;
    const prev = level;
    level = next;
    for (const fn of subs) {
      try { fn(level, prev); } catch (e) { console.error(e); }
    }
  }

  return {
    get level() { return level; },
    set(patch = {}) {
      if ("override" in patch) env.override = OVERRIDES.includes(patch.override) ? patch.override : "auto";
      for (const k of ["reducedMotion", "webgl2", "hidden", "mode"]) if (k in patch) env[k] = patch[k];
      publish();
    },
    reportFps(fps, cameraOn, now) {
      lastFps = fps;
      if (!cameraOn || !Number.isFinite(fps)) {
        lowSince = okSince = null;
        return level;
      }
      if (fps < LOW_FPS) {
        okSince = null;
        if (lowSince == null) lowSince = now;
        if (!degraded && now - lowSince >= DROP_MS) degraded = true;
      } else {
        lowSince = null;
        if (degraded) {
          if (okSince == null) okSince = now;
          // recover only after RESTORE_MS of healthy fps AND no stalls
          if (now - okSince >= RESTORE_MS && now - lastJank >= RESTORE_MS) { degraded = false; okSince = null; }
        }
      }
      publish();
      return level;
    },
    // one frame gap (ms) from the camera loop; stalls push effects to lite
    reportJank(gapMs, now) {
      if (!(gapMs > JANK_MS) || gapMs > 1000) return level; // >1 s = tab/camera pause, not jank
      lastJank = now;
      jank = jank.filter((t) => now - t < JANK_WINDOW_MS);
      jank.push(now);
      if (!degraded && jank.length >= JANK_COUNT) { degraded = true; okSince = null; publish(); }
      return level;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    cost(name, ms) {
      if (!Number.isFinite(ms)) return;
      const prev = costs.get(name);
      costs.set(name, prev == null ? ms : prev * 0.9 + ms * 0.1);
    },
    clearCost(name) { costs.delete(name); },
    costs() { return Object.fromEntries(costs); },
    state() { return { level, degraded, lastFps, ...env }; },
  };
}

/** True when the browser can create a WebGL2 context (checked once, cheap). */
export function hasWebGL2() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ok = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

/**
 * ?debug readout: effect ms per frame + detection fps + the governor level.
 * Returns { setFps(n) } — main.js feeds the detection fps it already counts.
 */
export function mountFxDebug(gov) {
  const el = document.createElement("div");
  el.className = "fx-debug";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  let fps = null;
  const paint = () => {
    const s = gov.state();
    const c = Object.entries(gov.costs())
      .map(([k, v]) => `${k} ${v.toFixed(2)}ms`)
      .join(" · ");
    el.textContent =
      `fx ${s.level}${s.degraded ? " (degraded)" : ""} [${s.override}]` +
      ` · det ${fps == null ? "—" : fps + " fps"}` + (c ? ` · ${c}` : "");
  };
  paint();
  setInterval(paint, 500);
  return { setFps(n) { fps = n; } };
}
