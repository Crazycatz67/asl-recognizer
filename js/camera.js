// =============================================================================
// js/camera.js — webcam start/stop via getUserMedia (Browser I/O)
// =============================================================================
// WHAT: Thin wrapper around getUserMedia. Keeps all the browser-quirk
//   handling (iOS needing an explicit play(), waiting for real frame data,
//   soft resolution/facing constraints) in one spot so main.js's state
//   machine only sees "a <video> that is playing" or a thrown error.
//
// PIPELINE: [camera.js] → <video> → handTracker.js (MediaPipe) → … — the very
//   first stage. main.js start() / stop() / flip() are the only callers.
//
// PUBLIC API:
//   startCamera(video, { facingMode }) → Promise<MediaStream>  (video is playing)
//   stopCamera(stream)                 → stop every track (null-safe)
//   countCameras()                     → Promise<number> of video inputs (0 on error)
//   facingOf(stream)                   → "user" | "environment" | undefined
//
// GOTCHAS: needs a secure context (https or http://localhost) — a bare
//   file:// page has no navigator.mediaDevices. Errors (NotAllowedError,
//   NotFoundError, …) propagate to the caller, which maps them to friendly
//   text in main.js friendlyError().

/**
 * Open the camera and start it playing into `video`.
 * @param {HTMLVideoElement} video  element to attach the stream to
 * @param {{facingMode?: "user"|"environment"}} [opts]  preferred camera (a soft "ideal")
 * @returns {Promise<MediaStream>} resolves once the first frame is decodable
 * @throws if getUserMedia is unsupported, denied, or no camera exists
 */
export async function startCamera(video, { facingMode = "user" } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access (getUserMedia).");
  }

  // `ideal` (not `exact`) so a device with only one camera still starts
  // instead of throwing OverconstrainedError, and so a camera that can't hit
  // 1280x720 just falls back to its best rather than failing outright.
  // Was 640x480 — too little detail for MediaPipe's hand landmarks once the
  // hand is smaller in frame (arm's length, or the back camera), which is
  // exactly the case that needs the most precision, not the least.
  // Phones (mobile pass, 2026-09-25): 960x540 instead of 1280x720 — ~45%
  // fewer pixels to upload to the GPU every frame, still well above the
  // 640x480 that lost detail at arm's length — and 30 fps max everywhere:
  // many phones default to 60 fps, doubling camera + upload work for frames
  // detection (TARGET_FPS 30) never uses.
  const phone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: phone ? 960 : 1280 },
      height: { ideal: phone ? 540 : 720 },
      frameRate: { ideal: 30, max: 30 },
    },
  });

  video.srcObject = stream;

  // iOS Safari needs an explicit play() triggered from a user gesture.
  await video.play();

  // Wait until the first frame is actually decodable, otherwise videoWidth
  // is still 0 and the first detections fail.
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      video.addEventListener("loadeddata", resolve, { once: true });
    });
  }

  return stream;
}

/**
 * Stop every track of a stream (turns the camera light off).
 * @param {MediaStream | null | undefined} stream
 */
export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

// Number of video input devices. Used to decide whether a "flip camera"
// control is worth showing. Labels are empty until permission is granted,
// but the count is still accurate, so call this after startCamera().
/** @returns {Promise<number>} number of video input devices, or 0 if enumeration fails */
export async function countCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput").length;
  } catch {
    return 0;
  }
}

// What the running stream actually resolved to ("user" | "environment" |
// undefined), which may differ from what we asked for.
/**
 * @param {MediaStream | null | undefined} stream
 * @returns {"user"|"environment"|undefined} the first video track's actual facing mode
 */
export function facingOf(stream) {
  return stream?.getVideoTracks?.()[0]?.getSettings?.().facingMode;
}
