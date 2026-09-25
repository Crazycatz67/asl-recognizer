// =============================================================================
// js/challengefx.js — adaptive Challenge visuals (visual layer v2, B4)
// =============================================================================
// WHAT: one 0..1 INTENSITY from the Challenge snapshot — combo (x1..x4),
//   streak, word length and difficulty — shared by every Challenge effect so
//   the look "matches the streaks and effects occurring, even the word
//   difficulty" (owner):
//   - aurora ramp cool -> electric violet -> gold (bg.setIntensity)
//   - a camera-frame aura (.ch-aura): 1-4 px, hue along the same ramp,
//     brightening on a hit; while the clock DRAINS it turns --drain magenta
//     and pulses 0.6 -> 1.4 Hz as time runs out (hard cap < 3 Hz — photo-
//     safety), the visual twin of the ticking sound
//   - the timer bar gets a notched stripe pattern while draining (shape, not
//     only colour)
//   - hit bursts scale with intensity (capped by the governor)
//   - kinetic banner: data-diff / --fx-intensity on #chBanner let CSS weight
//     the letters; the letter just landed in a word round pops + drops an
//     ember (CSS)
//   - the combo chip shimmers gold at x4
//   Race (versus snapshot): the aurora splits into P1 / P2 halves with the
//   seam leaning toward the trailing player (bg.setSplit) and a lead star on
//   the leader's HUD card.
//
// BUDGET: uniforms + a few CSS custom properties per snapshot; writes only on
//   change. "off" (reduced motion): static aura, no pulse (CSS), no bursts.
//
// PUBLIC API:
//   challengeIntensity({ mult, streak, len, difficulty }) -> 0..1   (pure)
//   drainHz(remainingFrac) -> Hz (0.6..1.4, never >= 3)             (pure)
//   burstCount(base, intensity, level) -> particle count            (pure)
//   rampColor(intensity) -> "rgb(r, g, b)"                          (pure)
//   raceLean(players) -> -1..1 (+ = P1 behind)                      (pure)
//   const cfx = createChallengeFx({ bg, aura, banner, timeBar, combo, governor });
//   cfx.update(snap)        // solo Challenge snapshot, every frame
//   cfx.updateRace(snap)    // versus snapshot, every frame
//   cfx.reset()             // leaving Challenge
//   cfx.intensity           // last value (for hit bursts)

export const DRAIN_HZ = { min: 0.6, max: 1.4, cap: 3 };

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

/** One number for "how hot is this run". Monotonic in every input. */
export function challengeIntensity({ mult = 1, streak = 0, len = 1, difficulty = "normal" } = {}) {
  const m = clamp01((mult - 1) / 3);
  const s = clamp01(streak / 12);
  const w = len >= 5 ? 1 : len === 4 ? 0.75 : len === 3 ? 0.5 : 0;
  const d = difficulty === "hard" ? 1 : 0;
  return clamp01(0.55 * m + 0.2 * s + 0.15 * w + 0.1 * d);
}

/** Drain pulse rate: calm at first, faster as time runs out, never >= 3 Hz. */
export function drainHz(remainingFrac) {
  const f = clamp01(remainingFrac);
  const hz = DRAIN_HZ.min + (DRAIN_HZ.max - DRAIN_HZ.min) * (1 - f);
  return Math.min(hz, DRAIN_HZ.cap - 0.01);
}

/** Hit-burst particles: grow with intensity on "full", capped on "lite". */
export function burstCount(base, intensity, level = "full") {
  if (level === "off") return 0;
  const n = Math.round(base * (1 + 1.5 * clamp01(intensity)));
  return level === "lite" ? Math.min(n, 30) : Math.min(n, 120);
}

const COOL = [56, 189, 248], ELECTRIC = [167, 139, 250], GOLD = [255, 200, 97];
/** The shared ramp (same stops as aurora.js): cool -> electric -> gold. */
export function rampColor(intensity) {
  const t = clamp01(intensity);
  const [a, b, k] = t < 0.5 ? [COOL, ELECTRIC, t * 2] : [ELECTRIC, GOLD, (t - 0.5) * 2];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Race seam lean from round wins: +1 = P1 far behind, -1 = P2 far behind. */
export function raceLean(players) {
  const a = players?.[0]?.wins ?? 0, b = players?.[1]?.wins ?? 0;
  return Math.max(-1, Math.min(1, (b - a) / 3));
}

export function createChallengeFx({ bg = null, aura = null, banner = null, timeBar = null, combo = null, governor = null } = {}) {
  let intensity = 0;
  let key = "";
  let raceKey = "";
  const level = () => governor?.level ?? "full";

  function write(el, prop, v) { if (el && el.style.getPropertyValue(prop) !== v) el.style.setProperty(prop, v); }

  return {
    get intensity() { return intensity; },
    update(snap) {
      if (!snap) return;
      const len = snap.target?.length || 1;
      intensity = challengeIntensity({ mult: snap.mult, streak: snap.streak, len, difficulty: snap.difficulty });
      bg?.setIntensity(intensity);
      const draining = !!snap.draining && snap.phase === "play";
      const hz = draining ? drainHz(snap.remainingFrac) : 0;
      // quantise so we only touch the DOM when something visible changes
      const k = `${intensity.toFixed(2)}|${draining}|${hz.toFixed(1)}|${snap.mult}|${snap.difficulty}|${len > 1}`;
      if (k === key) return;
      key = k;
      if (aura) {
        aura.hidden = false;
        aura.dataset.drain = draining ? "1" : "";
        write(aura, "--fx-intensity", intensity.toFixed(2));
        write(aura, "--aura-color", rampColor(intensity));
        write(aura, "--aura-w", `${(1 + 3 * intensity).toFixed(1)}px`);
        write(aura, "--drain-period", `${(1 / (hz || 1)).toFixed(2)}s`);
      }
      if (banner) {
        banner.dataset.diff = snap.difficulty || "normal";
        write(banner, "--fx-intensity", intensity.toFixed(2));
      }
      timeBar?.classList.toggle("notched", draining);
      if (combo) combo.dataset.mult = String(snap.mult || 1);
    },
    // a hit: brief brighter aura (CSS animation restarts via class toggle)
    hit() {
      if (!aura || level() === "off") return;
      aura.classList.remove("hit");
      void aura.offsetWidth;
      aura.classList.add("hit");
    },
    updateRace(snap) {
      if (!snap) return;
      const lean = raceLean(snap.players);
      const leader = (snap.players?.[0]?.wins ?? 0) === (snap.players?.[1]?.wins ?? 0) ? -1
        : snap.players[0].wins > snap.players[1].wins ? 0 : 1;
      const k = `${lean.toFixed(2)}|${leader}|${snap.over}`;
      if (k === raceKey) return leader;
      raceKey = k;
      // Race is pinned to "lite": the aurora redraws only while the seam eases
      bg?.setSplit(snap.over ? null : lean);
      return leader;
    },
    reset() {
      intensity = 0;
      key = raceKey = "";
      bg?.setIntensity(0);
      bg?.setSplit(null);
      if (aura) { aura.hidden = true; aura.dataset.drain = ""; aura.classList.remove("hit"); }
      timeBar?.classList.remove("notched");
      if (combo) combo.dataset.mult = "1";
    },
  };
}
