// =============================================================================
// js/glyphfx.js — "you signed THIS letter" tile beside the hand (visual layer v2, B3)
// =============================================================================
// WHAT: on the big reward tiers (first time a letter lands, mastery), a solid
//   letter tile pops up BESIDE the hand (never over it), holds for a beat,
//   then floats up and fades — a plain, instantly readable "you got A".
//
// HISTORY: this was a cloud of up to 200 particles springing into the glyph's
//   outline. Owner live test (2026-09-25, A->Z run): "it pops up the letter
//   in a bunch of dots ... very distracting and cluttered ... not an easy
//   read, it looks like braille in a sense — keep the notifier, change the
//   design". It also read the glyph back from a canvas (getImageData) on
//   every reward — a frame spike. Now one reused DOM node + one Web
//   Animation: no canvas, no rAF loop, no per-frame work at all.
//
// BUDGET (js/fxquality.js): "full"/"lite": pop-in + float-out animation;
//   "off" / reduced motion: the tile simply appears and fades. Pointer-events
//   none, aria-hidden (the toast / live region carries the words).
//
// PUBLIC API:
//   const g = createGlyphFx({ governor });
//   g.assemble(letter, { box: {left,top,right,bottom} (page px), tier: "first"|"mastery" })
//   g.bench(frames)                       // ?debug: ms per show (DOM cost)
//   placeBeside(box, size, view) -> {x, y}              (pure)

const HOLD_MS = 1300;

/**
 * Where to put a size x size tile next to the hand's box (page px): on the
 * side with more room, vertically centred on the hand, clamped into view.
 * Returns the tile's top-left. Pure.
 */
export function placeBeside(box, size, view) {
  const gap = size * 0.25;
  const roomL = box.left - view.left, roomR = view.right - box.right;
  let x = roomR >= roomL ? box.right + gap : box.left - gap - size;
  let y = (box.top + box.bottom) / 2 - size / 2;
  x = Math.max(view.left + 4, Math.min(view.right - size - 4, x));
  y = Math.max(view.top + 4, Math.min(view.bottom - size - 4, y));
  return { x, y };
}

export function createGlyphFx({ governor = null } = {}) {
  const tile = document.createElement("div");
  tile.className = "fx-letter-tile";
  tile.setAttribute("aria-hidden", "true");
  const glyph = document.createElement("b");
  const cap = document.createElement("span");
  tile.append(glyph, cap);
  document.body.appendChild(tile);
  let anim = null;
  const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  return {
    assemble(letter, { box, tier = "first" } = {}) {
      if (!letter || !box) return false;
      const hh = Math.max(1, box.bottom - box.top);
      const size = Math.round(Math.max(64, Math.min(116, hh * 0.42)));
      const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const { x, y } = placeBeside(box, size, view);
      glyph.textContent = letter;
      cap.textContent = tier === "mastery" ? "mastered" : "first!";
      tile.classList.toggle("mastery", tier === "mastery");
      tile.style.cssText = `left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${size}px;height:${size}px;font-size:${(size * 0.56).toFixed(0)}px`;
      anim?.cancel();
      const still = (governor?.level ?? "full") === "off" || reduced();
      anim = tile.animate(
        still
          ? [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
          : [
              { opacity: 0, transform: "scale(0.6)" },
              { opacity: 1, transform: "scale(1.06)", offset: 0.14 },
              { opacity: 1, transform: "scale(1)", offset: 0.24 },
              { opacity: 1, transform: "translateY(0) scale(1)", offset: 0.78 },
              { opacity: 0, transform: "translateY(-14px) scale(0.96)" },
            ],
        { duration: HOLD_MS, easing: "ease-out", fill: "forwards" },
      );
      return true;
    },
    bench(frames = 30) {
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) this.assemble("W", { box: { left: 200, top: 200, right: 400, bottom: 460 }, tier: i % 2 ? "first" : "mastery" });
      const ms = (performance.now() - t0) / frames;
      anim?.cancel();
      return { msPerFrame: ms };
    },
    dispose() { anim?.cancel(); tile.remove(); },
  };
}
