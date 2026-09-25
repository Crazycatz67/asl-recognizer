// =============================================================================
// js/perfreport.js — on-device performance report (?perf) for phone testing
// =============================================================================
// WHAT: the owner tests on a MacBook but the app must run smoothly on phones
//   (iPhone + Android, Chrome). Open the app with ?perf on the phone, use it
//   normally, then tap "Copy report" and paste the one line back — detection
//   fps percentiles, frame stalls, how long effects spent at each quality
//   level, and the device/camera facts that explain them.
//
// summarize() is PURE (tested in Node); mountPerfPanel() is the tiny DOM part.
//
// PUBLIC API:
//   const pr = createPerfReport({ now });
//   pr.sample(fps, t)          // detection fps, ~2x/s (main.js tickDetStats)
//   pr.stall(gapMs, t)         // an animation-frame gap > 50 ms (main.js loop)
//   pr.level(level, t)         // effects governor level changed
//   pr.summary(info) -> {...}  // numbers so far (info: device/camera facts)
//   pr.text(info) -> string    // one pasteable line
//   pr.reset(t)
//   mountPerfPanel(pr, getInfo) -> { el }   // fixed panel: live line + Copy + Reset
//   summarize(samples, stalls, levels, t0, t1)   (pure)

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : null);

/** Pure: fps percentiles, stall stats, seconds at each effects level. */
export function summarize(samples, stalls, levels, t0, t1) {
  const f = samples.map((s) => s.fps).filter(Number.isFinite).sort((a, b) => a - b);
  const secs = { full: 0, lite: 0, off: 0 };
  for (let i = 0; i < levels.length; i++) {
    const a = levels[i], end = i + 1 < levels.length ? levels[i + 1].t : t1;
    if (a.level in secs) secs[a.level] += Math.max(0, end - a.t) / 1000;
  }
  const g = stalls.map((s) => s.gap);
  return {
    seconds: Math.round(Math.max(0, t1 - t0) / 1000),
    fps: { p50: pct(f, 0.5), p10: pct(f, 0.1), min: f.length ? f[0] : null, n: f.length },
    stalls: { n: g.length, perMin: t1 > t0 ? +((g.length * 60000) / (t1 - t0)).toFixed(1) : 0, worstMs: g.length ? Math.round(Math.max(...g)) : 0 },
    effects: Object.fromEntries(Object.entries(secs).map(([k, v]) => [k, Math.round(v)])),
  };
}

export function createPerfReport({ now = () => performance.now() } = {}) {
  let t0 = now(), samples = [], stalls = [], levels = [];
  return {
    sample(fps, t = now()) { samples.push({ t, fps }); if (samples.length > 4000) samples.shift(); },
    stall(gap, t = now()) { if (gap > 50 && gap < 1000) { stalls.push({ t, gap }); if (stalls.length > 2000) stalls.shift(); } },
    level(level, t = now()) { if (levels.at(-1)?.level !== level) levels.push({ t, level }); },
    summary(info = {}) { return { ...summarize(samples, stalls, levels, t0, now()), ...info }; },
    text(info = {}) {
      const s = this.summary(info);
      return `ASL perf · ${s.seconds}s · det fps p50 ${s.fps.p50 ?? "—"} p10 ${s.fps.p10 ?? "—"} min ${s.fps.min ?? "—"}` +
        ` · stalls ${s.stalls.n} (${s.stalls.perMin}/min, worst ${s.stalls.worstMs}ms)` +
        ` · fx full ${s.effects.full}s lite ${s.effects.lite}s off ${s.effects.off}s` +
        Object.entries(info).map(([k, v]) => ` · ${k} ${v}`).join("");
    },
    reset(t = now()) { const last = levels.at(-1); t0 = t; samples = []; stalls = []; levels = last ? [{ t, level: last.level }] : []; },
  };
}

/** Device + browser facts that explain the numbers (read once per copy). */
export function deviceInfo(extra = {}) {
  const n = navigator, ua = n.userAgent || "";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : "other";
  const br = /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "other";
  return {
    device: `${os} ${br}`,
    dpr: +(window.devicePixelRatio || 1).toFixed(2),
    cores: n.hardwareConcurrency || "?",
    mem: n.deviceMemory ? `${n.deviceMemory}GB` : "?",
    screen: `${screen.width}x${screen.height}`,
    view: `${innerWidth}x${innerHeight}`,
    touch: matchMedia("(pointer: coarse)").matches ? "yes" : "no",
    ...extra,
  };
}

export function mountPerfPanel(pr, getInfo = () => ({})) {
  const el = document.createElement("div");
  el.className = "perf-panel";
  el.innerHTML = `<div class="perf-line" aria-live="off"></div><div class="perf-btns"><button type="button" data-a="copy">Copy report</button><button type="button" data-a="reset">Reset</button></div>`;
  document.body.appendChild(el);
  const line = el.querySelector(".perf-line");
  const paint = () => {
    const s = pr.summary();
    line.textContent = `det fps ${s.fps.p50 ?? "—"} (p10 ${s.fps.p10 ?? "—"}) · stalls ${s.stalls.n} · ${s.seconds}s`;
  };
  setInterval(paint, 1000);
  paint();
  el.addEventListener("click", async (e) => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "reset") { pr.reset(); paint(); return; }
    if (a !== "copy") return;
    const txt = pr.text(deviceInfo(getInfo()));
    let ok = false;
    try { await navigator.clipboard.writeText(txt); ok = true; } catch {}
    if (!ok) {
      // fallback (older iOS / insecure contexts): show it selected to copy by hand
      const ta = document.createElement("textarea");
      ta.value = txt; ta.readOnly = true; ta.className = "perf-copy";
      el.appendChild(ta); ta.select();
      setTimeout(() => ta.remove(), 15000);
    }
    const b = e.target.closest("button");
    b.textContent = ok ? "Copied ✓" : "Select + copy ↓";
    setTimeout(() => { b.textContent = "Copy report"; }, 2000);
  });
  return { el };
}
