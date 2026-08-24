export interface VideoClipMetadata {
  durationSeconds: number;
  width: number;
  height: number;
}

export interface VideoClipSelection {
  trimStartSeconds: number;
  trimEndSeconds: number;
  clipDurationSeconds: number;
  originalDurationSeconds: number;
  thumbnailTimeSeconds: number;
}

const roundSeconds = (value: number) => Math.round(value * 1000) / 1000;

const getSupportedRecorderMimeType = () => {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
};

export const canRecordVideoClipInBrowser = () =>
  typeof window !== "undefined" &&
  typeof MediaRecorder !== "undefined" &&
  typeof document !== "undefined" &&
  Boolean(getSupportedRecorderMimeType());

// Stricter check for the highlight flow: canRecordVideoClipInBrowser() only
// confirms MediaRecorder + a webm mimetype exist, but Safari (desktop and
// iOS) ships MediaRecorder without HTMLVideoElement.captureStream/
// mozCaptureStream support, which recording the trimmed range needs.
export const canCaptureVideoStreamInBrowser = () => {
  if (!canRecordVideoClipInBrowser()) return false;
  const video = document.createElement("video") as HTMLVideoElement & {
    captureStream?: () => MediaStream;
    mozCaptureStream?: () => MediaStream;
  };
  return typeof video.captureStream === "function" || typeof video.mozCaptureStream === "function";
};

/**
 * Builds a clamped VideoClipSelection: trimStart/trimEnd always stay within
 * [0, durationSeconds] and the resulting clip length always stays within
 * [minSeconds, maxSeconds].
 */
export const createClipSelectionFromRange = (
  durationSeconds: number,
  startSeconds: number,
  endSeconds: number,
  minSeconds: number,
  maxSeconds: number,
): VideoClipSelection => {
  const safeDuration = Math.max(0, durationSeconds);
  const maxStart = Math.max(0, safeDuration - minSeconds);
  const trimStartSeconds = roundSeconds(Math.min(Math.max(0, startSeconds), maxStart));
  const minEnd = Math.min(safeDuration, trimStartSeconds + minSeconds);
  const maxEnd = Math.min(safeDuration, trimStartSeconds + maxSeconds);
  const trimEndSeconds = roundSeconds(Math.min(Math.max(endSeconds, minEnd), maxEnd));
  const finalClipDuration = roundSeconds(trimEndSeconds - trimStartSeconds);

  return {
    trimStartSeconds,
    trimEndSeconds,
    clipDurationSeconds: finalClipDuration,
    originalDurationSeconds: roundSeconds(safeDuration),
    thumbnailTimeSeconds: roundSeconds(trimStartSeconds + finalClipDuration / 2),
  };
};

export const createDefaultClipSelection = (
  durationSeconds: number,
  minSeconds: number,
  maxSeconds: number,
  startSeconds = 0,
): VideoClipSelection => {
  const safeDuration = Math.max(0, durationSeconds);
  const clipDurationSeconds = Math.min(maxSeconds, safeDuration || maxSeconds);
  return createClipSelectionFromRange(
    safeDuration,
    startSeconds,
    startSeconds + clipDurationSeconds,
    minSeconds,
    maxSeconds,
  );
};
