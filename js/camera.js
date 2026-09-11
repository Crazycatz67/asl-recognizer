// Thin wrapper around getUserMedia. Keeps all the browser-quirk handling
// (iOS playsinline, waiting for real frame data) in one spot.

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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
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

export function stopCamera(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

// Number of video input devices. Used to decide whether a "flip camera"
// control is worth showing. Labels are empty until permission is granted,
// but the count is still accurate, so call this after startCamera().
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
export function facingOf(stream) {
  return stream?.getVideoTracks?.()[0]?.getSettings?.().facingMode;
}
