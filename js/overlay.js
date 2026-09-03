// All canvas drawing lives here. Stage 1 only needs the skeleton; drawLetter()
// is a stub wired up in Stage 4.

import { loadVision } from "./mediapipe.js";

export async function createOverlay(canvas) {
  const { DrawingUtils, HandLandmarker } = await loadVision();
  const ctx = canvas.getContext("2d");
  const drawer = new DrawingUtils(ctx);

  return {
    canvas,
    ctx,

    // Match the canvas backing store to the camera's real resolution so the
    // normalised (0..1) landmark coords map straight onto pixels.
    resizeToVideo(video) {
      if (
        canvas.width !== video.videoWidth ||
        canvas.height !== video.videoHeight
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    },

    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    drawHands(landmarksList) {
      for (const landmarks of landmarksList) {
        drawer.drawConnectors(landmarks, HandLandmarker.HAND_CONNECTIONS, {
          color: "#38bdf8",
          lineWidth: 4,
        });
        drawer.drawLandmarks(landmarks, {
          color: "#f8fafc",
          lineWidth: 1,
          radius: 4,
        });
      }
    },

    // Practice mode: a "ghost" of the target letter's canonical hand shape,
    // anchored to the live wrist and scaled to the live hand so the user just
    // has to match finger positions. `color` carries the off/close/correct
    // signal; `glow` (0..1) brightens as they get closer.
    drawGhost(vec, live, { color = "#f59e0b", glow = 0.4, mirror = false } = {}) {
      if (!vec || !live?.length) return;
      const w = canvas.width;
      const h = canvas.height;
      const wrist = live[0];
      const ox = wrist.x * w;
      const oy = wrist.y * h;

      // live hand radius in pixels -> use it to scale the (unit-radius) ghost
      let r = 1e-6;
      for (const p of live) {
        const d = Math.hypot((p.x - wrist.x) * w, (p.y - wrist.y) * h);
        if (d > r) r = d;
      }
      const aspect = w / h;
      const sx = mirror ? -1 : 1; // centroid is right-hand canonical
      const px = (i) => [ox + ((vec[i * 3] * sx) / aspect) * r, oy + vec[i * 3 + 1] * r];

      // "glow" is conveyed by line weight + opacity (fatter and more solid as
      // you match) rather than canvas shadowBlur, which is far too slow to run
      // every frame on a full skeleton.
      const g = Math.max(0, Math.min(1, glow));
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;

      // soft under-stroke
      ctx.globalAlpha = 0.18 + 0.22 * g;
      ctx.lineWidth = 12 + 10 * g;
      strokeSkeleton();
      // crisp over-stroke
      ctx.globalAlpha = 0.5 + 0.45 * g;
      ctx.lineWidth = 3 + 3 * g;
      strokeSkeleton();

      ctx.globalAlpha = 0.7 + 0.3 * g;
      for (let i = 0; i < 21; i++) {
        const [x, y] = px(i);
        ctx.beginPath();
        ctx.arc(x, y, 3.5 + g, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      function strokeSkeleton() {
        ctx.beginPath();
        for (const c of HandLandmarker.HAND_CONNECTIONS) {
          const [ax, ay] = px(c.start ?? c[0]);
          const [bx, by] = px(c.end ?? c[1]);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
      }
    },

    // Stage 4: the confirmed predicted letter, big and centred. The stage
    // wrapper is CSS-mirrored, so we flip the text back here to keep it
    // readable.
    drawLetter(letter) {
      if (!letter) return;
      const { width, height } = canvas;
      const size = Math.round(Math.min(width, height) * 0.34);
      ctx.save();
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.font = `800 ${size}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = Math.max(6, size * 0.06);
      ctx.strokeStyle = "rgba(2, 6, 23, 0.85)";
      ctx.fillStyle = "rgba(248, 250, 252, 0.96)";
      ctx.strokeText(letter, width / 2, height / 2);
      ctx.fillText(letter, width / 2, height / 2);
      ctx.restore();
    },
  };
}
