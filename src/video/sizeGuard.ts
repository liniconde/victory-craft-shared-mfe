// The real-time capture fallback (play the source + MediaRecorder) puts real
// memory/GPU pressure on the device for as long as the clip is being played
// back, which is far more likely to crash a tab on mobile than on desktop.
// These thresholds only gate the *fallback* path — the fast MP4 path (see
// mp4FastTrim.ts) never re-encodes, so it isn't subject to this limit.
export const BROWSER_CAPTURE_MAX_BYTES_DESKTOP = 15 * 1024 * 1024 * 1024;
export const BROWSER_CAPTURE_MAX_BYTES_MOBILE = 2 * 1024 * 1024 * 1024;

export const getBrowserCaptureMaxBytes = (isMobile: boolean) =>
  isMobile ? BROWSER_CAPTURE_MAX_BYTES_MOBILE : BROWSER_CAPTURE_MAX_BYTES_DESKTOP;
