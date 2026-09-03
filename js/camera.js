// Thin wrapper around getUserMedia. Keeps all the browser-quirk handling
// (iOS playsinline, waiting for real frame data) in one spot.

export async function startCamera(video, { facingMode = "user" } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access (getUserMedia).");
  }

  // `ideal` (not `exact`) so a device with only one camera still starts
  // instead of throwing OverconstrainedError.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 640 },
      height: { ideal: 480 },
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
