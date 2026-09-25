// =============================================================================
// js/aurora.js — calm reactive WebGL2 background (visual layer v2, B1)
// =============================================================================
// WHAT: a slow mesh-gradient "aurora" behind the whole app: 4 soft lobes
//   anchored to screen regions (top-left, top-right, thumb side, pinky side)
//   plus a floor glow, shaped by domain-warped noise. It replaces bg.js's
//   canvas-2D blobs with the SAME public API, so main.js's setMatch() call
//   sites don't change. bg.js stays as the fallback (no WebGL2 / lost context).
//
// WHAT IT REACTS TO (and what it deliberately doesn't):
//   - idle (no target/hand): a cool blue breath (--calm #38bdf8).
//   - setHand({present, span, speed}): a hand in frame wakes the field a little
//     warmer toward --amber-wash; fast motion adds a faint shimmer that settles
//     to glassy when the hand is still (rewards the stillness the classifier
//     needs).
//   - setMatch(score, bucket, regions): warmth follows the match; a correct
//     shape adds a soft green floor. A WRONG REGION shows as LOST ENERGY
//     (dimmer, slower, desaturated lobe) — never as orange/magenta, which are
//     the correction guide's colours near the hand.
//   - setIntensity(0..1): Challenge ramp cool -> electric violet -> gold (B4).
//   Warm contribution is capped at the --amber-wash ceiling (alpha <= 0.15) and
//   a dark calm zone is kept behind #viewport, so nothing competes with the
//   hand or lights the user's skin (webcam auto-exposure).
//
// BUDGET (js/fxquality.js governor): full = animated, 1/4 resolution, <= 20
//   fps; lite = time frozen (static gradient), re-rendered only while colours
//   are easing, <= 5 fps; off = the same static gradient (reduced motion).
//   Paused while the tab is hidden. No readPixels/getError in the loop; under
//   ?debug the draw's CPU ms (and GPU ms via EXT_disjoint_timer_query_webgl2
//   when the browser exposes it, polled without stalling) go to gov.cost().
//
// PUBLIC API:
//   const bg = createAurora({ governor, viewport, debug });
//   bg.setMatch(score, bucket, regions)   // same contract as bg.js
//   bg.setHand({ present, span, speed })  // per detection frame (optional)
//   bg.setIntensity(x)                    // 0..1 (optional)
//   bg.kind                               // "aurora" | "canvas2d"
//   bg.stop()

import { createBackground } from "./bg.js";

const VERT = `#version 300 es
void main() {
  // one full-screen triangle, no vertex buffer
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCool;      // idle / calm hue
uniform vec3 uWarm;      // amber stop
uniform vec3 uHot;       // intensity ramp colour (electric -> gold)
uniform float uWarmth;   // 0..1 hand presence + match
uniform float uGreen;    // 0..1 correct-shape floor glow
uniform vec3 uRegion;    // top, left, right error 0..1 (higher = more wrong)
uniform float uEnergy;   // 0..1 overall
uniform float uIntensity;// 0..1 Challenge
uniform float uShimmer;  // 0..1 hand motion
uniform vec4 uHole;      // calm zone rect in uv (x0, y0, x1, y1), y down
uniform float uAlpha;    // global ceiling
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
float lobe(vec2 uv, vec2 c, float r) { vec2 d = uv - c; return exp(-dot(d, d) / (r * r)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  uv.y = 1.0 - uv.y;                       // y down, like the DOM
  float asp = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * asp, uv.y) * 1.6;
  float t = uTime;

  // domain warp: two nested fbm lookups, slow drift
  vec2 q = vec2(fbm(p + vec2(0.0, t * 0.05)), fbm(p + vec2(5.2, 1.3) - t * 0.04));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.06), fbm(p + 3.0 * q + vec2(8.3, 2.8)));
  float field = fbm(p + 3.5 * r + uShimmer * 0.6 * sin(t * 3.0 + p.yx * 9.0));
  vec2 w = (r - 0.5) * 0.12;               // lobes wobble with the warp

  // region-anchored lobes; a wrong region loses energy (dim, not a new hue)
  float eTop = 1.0 - 0.75 * uRegion.x;
  float eL = 1.0 - 0.75 * uRegion.y;
  float eR = 1.0 - 0.75 * uRegion.z;
  float lTop = (lobe(uv + w, vec2(0.28, 0.12), 0.34) + lobe(uv - w, vec2(0.72, 0.12), 0.34)) * eTop;
  float lL = lobe(uv + w.yx, vec2(0.06, 0.55), 0.32) * eL;
  float lR = lobe(uv - w.yx, vec2(0.94, 0.55), 0.32) * eR;
  float lFloor = lobe(uv + w, vec2(0.5, 1.02), 0.42);

  // colour: cool base, warmed toward amber (ceiling via uWarmth), Challenge ramp
  vec3 base = mix(uCool, uWarm, clamp(uWarmth, 0.0, 1.0) * 0.55);
  base = mix(base, uHot, uIntensity * 0.8);
  float sat = 0.55 + 0.45 * uEnergy;
  vec3 grey = vec3(dot(base, vec3(0.299, 0.587, 0.114)));
  vec3 cTop = mix(grey, base, sat * eTop);
  vec3 cL = mix(grey, base, sat * eL);
  vec3 cR = mix(grey, base, sat * eR);
  vec3 cFloor = mix(base, vec3(0.133, 0.773, 0.369), uGreen * 0.7); // #22c55e

  vec3 col = cTop * lTop + cL * lL + cR * lR + cFloor * lFloor * (0.7 + 0.5 * uGreen);
  float m = smoothstep(0.25, 0.85, field);
  col *= (0.35 + 0.9 * m) * (0.45 + 0.55 * uEnergy);

  // calm dark zone behind the camera frame (soft-edged)
  vec2 hc = (uHole.xy + uHole.zw) * 0.5, hs = (uHole.zw - uHole.xy) * 0.5 + 0.04;
  vec2 hd = max(abs(uv - hc) - hs, 0.0);
  float hole = smoothstep(0.0, 0.14, length(hd * vec2(asp, 1.0)));
  col *= mix(0.25, 1.0, hole);

  float a = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0) * uAlpha;
  outColor = vec4(col * uAlpha, a);        // premultiplied
}`;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const COOL = hex("#38bdf8"); // --calm
const AMBER = hex("#fbbf24"); // --amber-400 (capped to --amber-wash by uWarmth/uAlpha)
const ELECTRIC = hex("#a78bfa"); // --fx-electric
const GOLD = hex("#ffc861"); // --fx-gold
const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function createAurora({ governor = null, viewport = null, debug = false } = {}) {
  const cv = document.createElement("canvas");
  cv.className = "fx-aurora";
  cv.setAttribute("aria-hidden", "true");
  Object.assign(cv.style, {
    position: "fixed", inset: "0", width: "100%", height: "100%", zIndex: "-1", pointerEvents: "none",
  });
  let gl = null;
  try {
    gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  } catch {}
  let prog = null;
  if (gl) prog = buildProgram(gl);
  if (!gl || !prog) return fallback();
  document.body.prepend(cv);

  const U = {};
  for (const n of ["uRes", "uTime", "uCool", "uWarm", "uHot", "uWarmth", "uGreen", "uRegion", "uEnergy", "uIntensity", "uShimmer", "uHole", "uAlpha"])
    U[n] = gl.getUniformLocation(prog, n);
  gl.useProgram(prog);
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.BLEND);

  let W = 0, H = 0;
  const resize = () => {
    W = Math.max(64, Math.ceil(window.innerWidth / 4));
    H = Math.max(64, Math.ceil(window.innerHeight / 4));
    cv.width = W;
    cv.height = H;
    dirty = true;
  };
  window.addEventListener("resize", resize);

  // eased state (cur) chases targets (want)
  const want = { warmth: 0, green: 0, energy: 0.45, top: 0, left: 0, right: 0, intensity: 0, shimmer: 0 };
  const cur = { ...want };
  let idle = true;
  let hand = { present: false, speed: 0 };
  let hole = [0.3, 0.2, 0.7, 0.8];
  let holeAt = 0;
  let dirty = true;
  let lost = false;
  let level = governor?.level ?? "full";
  let simTime = 0; // advances only on "full"
  let last = performance.now();
  let lastDraw = 0;
  let raf = 0;
  let fb = null; // bg.js fallback after a lost context
  resize();

  // optional GPU timer (debug only; results are polled, never waited on)
  const tq = debug ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
  let pendingQ = null;

  function measureHole(now) {
    if (!viewport || now - holeAt < 500) return;
    holeAt = now;
    const r = viewport.getBoundingClientRect();
    const iw = window.innerWidth || 1, ih = window.innerHeight || 1;
    const nh = r.width > 0 && !viewport.closest("[hidden]")
      ? [r.left / iw, r.top / ih, r.right / iw, r.bottom / ih]
      : [0.5, 0.5, 0.5, 0.5]; // no camera on screen: no calm zone needed
    if (nh.some((v, i) => Math.abs(v - hole[i]) > 0.002)) { hole = nh; dirty = true; }
  }

  function targets(t) {
    if (idle) {
      // cool breath; a present hand wakes it a little warmer
      want.warmth = hand.present ? 0.28 : 0;
      want.energy = 0.42 + (level === "full" ? 0.1 * Math.sin(t * 0.55) : 0) + (hand.present ? 0.12 : 0);
      want.green = 0;
      want.top = want.left = want.right = 0;
    }
    want.shimmer = hand.present ? Math.min(1, hand.speed / 1.5) : 0;
  }

  function ease(dt) {
    const k = 1 - Math.pow(0.02, dt); // ~ 0.25 s time constant
    let moved = 0;
    for (const key in want) {
      const d = want[key] - cur[key];
      cur[key] += d * k;
      moved = Math.max(moved, Math.abs(d));
    }
    return moved > 0.004;
  }

  function draw() {
    const c0 = performance.now();
    if (pendingQ && tq) {
      if (gl.getQueryParameter(pendingQ, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) governor?.cost("aurora gpu", gl.getQueryParameter(pendingQ, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(pendingQ);
        pendingQ = null;
      }
    }
    let q = null;
    if (tq && !pendingQ) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
    const ramp = cur.intensity < 0.5 ? lerp3(COOL, ELECTRIC, cur.intensity * 2) : lerp3(ELECTRIC, GOLD, (cur.intensity - 0.5) * 2);
    gl.viewport(0, 0, W, H);
    gl.uniform2f(U.uRes, W, H);
    gl.uniform1f(U.uTime, simTime);
    gl.uniform3fv(U.uCool, COOL);
    gl.uniform3fv(U.uWarm, AMBER);
    gl.uniform3fv(U.uHot, ramp);
    gl.uniform1f(U.uWarmth, cur.warmth);
    gl.uniform1f(U.uGreen, cur.green);
    gl.uniform3f(U.uRegion, cur.top, cur.left, cur.right);
    gl.uniform1f(U.uEnergy, Math.max(0, Math.min(1, cur.energy)));
    gl.uniform1f(U.uIntensity, cur.intensity);
    gl.uniform1f(U.uShimmer, level === "full" ? cur.shimmer : 0);
    gl.uniform4fv(U.uHole, hole);
    gl.uniform1f(U.uAlpha, 0.34);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); pendingQ = q; }
    governor?.cost("aurora", performance.now() - c0);
  }

  function frame(now) {
    raf = 0;
    if (lost || document.visibilityState === "hidden") return; // resumed by visibilitychange
    schedule();
    const minGap = level === "full" ? 50 : 200; // <= 20 fps full, <= 5 fps static
    if (now - lastDraw < minGap - 2) return;
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    targets(t);
    measureHole(now);
    const moving = ease(dt);
    if (level === "full") simTime += dt;
    else if (!moving && !dirty) return; // static: nothing changed, skip the GPU entirely
    dirty = false;
    lastDraw = now;
    draw();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

  const onVis = () => { if (document.visibilityState === "visible") { last = performance.now(); dirty = true; schedule(); } };
  document.addEventListener("visibilitychange", onVis);
  const unsub = governor?.subscribe((l) => { level = l; dirty = true; schedule(); });
  if (debug && tq) governor?.cost("aurora gpu", 0);

  cv.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    lost = true;
    cancelAnimationFrame(raf);
    raf = 0;
    cv.remove();
    fb = createBackground(); // keep an ambient background either way
  });

  schedule();

  const api = {
    kind: "aurora",
    // ?debug only: tools for measuring the effect in isolation (no camera
    // needed). NOT used by the frame loop — bench() forces a sync readback
    // on purpose so the GPU work is inside the timing.
    ...(debug ? {
      renderAt(seconds, patch = {}) {
        Object.assign(want, patch); Object.assign(cur, want);
        simTime = seconds; draw();
      },
      bench(frames = 60) {
        const px = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) { simTime += 0.05; draw(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        return { msPerFrame: (performance.now() - t0) / frames, w: W, h: H };
      },
    } : {}),
    setMatch(score, bucket, regions) {
      if (fb) return fb.setMatch(score, bucket, regions);
      if (score == null || bucket == null) { idle = true; return; }
      idle = false;
      const s = Math.max(0, Math.min(1, score));
      want.warmth = 0.3 + 0.5 * s; // capped to --amber-wash by the shader mix + uAlpha
      want.green = bucket === "correct" ? 1 : 0;
      want.energy = bucket === "off" ? 0.5 : bucket === "close" ? 0.7 : 0.9;
      want.top = regions?.top ?? 0;
      want.left = regions?.left ?? 0;
      want.right = regions?.right ?? 0;
    },
    setHand(h) {
      hand = { present: !!h?.present, speed: Number(h?.speed) || 0 };
    },
    setIntensity(x) {
      want.intensity = Math.max(0, Math.min(1, Number(x) || 0));
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
      unsub?.();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", resize);
      cv.remove();
      fb?.stop();
      governor?.clearCost("aurora");
    },
  };
  return api;

  function fallback() {
    const b = createBackground();
    return { kind: "canvas2d", setMatch: b.setMatch, setHand() {}, setIntensity() {}, stop: b.stop };
  }
}

function buildProgram(gl) {
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("aurora shader:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, VERT), f = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn("aurora link:", gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}
