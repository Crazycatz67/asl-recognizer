// tools/fx-drive.js — drive the live app with a synthetic hand in a HIDDEN /
// automation tab (visual layer v2 QA). Chrome stops rAF in hidden tabs and
// throttles timers to 1/s, so this swaps rAF for a MessageChannel pump
// (~60 Hz, not throttled) BEFORE the camera starts, then uses
// tools/testHarness.js's synthetic camera. Test-only; never loaded by the app.
//
//   const D = await (await import("/tools/fx-drive.js")).startDriven();
//   await D.sleep(500); D.pick("B"); D.feed("B"); ...
export async function startDriven() {
  const ch = new MessageChannel();
  let q = [], id = 0, last = performance.now(), spinning = false;
  ch.port1.onmessage = () => {
    const now = performance.now();
    if (now - last >= 16) { last = now; const run = q; q = []; for (const [, cb] of run) cb(now); }
    if (q.length) ch.port2.postMessage(0); else spinning = false;
  };
  window.requestAnimationFrame = (cb) => { q.push([++id, cb]); if (!spinning) { spinning = true; ch.port2.postMessage(0); } return id; };
  window.cancelAnimationFrame = (i) => { q = q.filter((x) => x[0] !== i); };
  const sleep = (ms) => new Promise((r) => {
    const t0 = performance.now(); const c = new MessageChannel();
    c.port1.onmessage = () => (performance.now() - t0 >= ms ? r() : c.port2.postMessage(0));
    c.port2.postMessage(0);
  });
  // effects pause in hidden tabs by design; pretend we're foregrounded so
  // the reward effects actually play under automation
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  const { createTestHarness } = await import("./testHarness.js");
  const H = createTestHarness();
  H.useSyntheticCamera();
  [...document.querySelectorAll("button")].find((b) => /turn on camera/i.test(b.textContent)).click();
  await H.ready();
  await sleep(800);
  return {
    H, sleep,
    pick(L) { [...document.querySelectorAll("button.chip")].find((b) => b.textContent.trim() === L)?.click(); },
    feed(L) { H.feedLetter(L, { holdMs: 10 }); },
    none() { H.noHand({ ms: 10 }); },
  };
}
