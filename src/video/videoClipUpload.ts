import { createClipSelectionFromRange, type VideoClipMetadata, type VideoClipSelection } from "./clipSelection";

// Minimum clip length enforced by createSelectionFromRange when the caller
// doesn't override it. Unlike HighlightRangeSelector's createClipSelectionFromRange
// (which always takes an explicit max), this file's helpers back the "trim a
// long video, no cap" flow (VideoClipRangeSelector / useLocalVideoClipUpload)
// so there's no maxSeconds — the practical ceiling is just the video's own
// duration.
export const MIN_CLIP_DURATION_SECONDS = 1;

// Tolerance (in seconds) used to decide whether the user's selection should
// be treated as "the whole video" (upload the original file, no re-encode).
const FULL_SELECTION_TOLERANCE_SECONDS = 0.25;

export interface PreparedVideoClip {
  file: File;
  selection: VideoClipSelection;
  wasGeneratedInBrowser: boolean;
  /** True when the browser-recorded clip's real duration didn't match the
   * requested range — selection fields have already been corrected to the
   * real value in this case, but callers may want to surface a small
   * "this may look off" note. */
  durationMismatch?: boolean;
}

const waitForEvent = <T extends Event>(target: EventTarget, eventName: string, timeoutMs = 15000) =>
  new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      target.removeEventListener(eventName, handleEvent);
      target.removeEventListener("error", handleError);
    };

    const handleEvent = (event: Event) => {
      cleanup();
      resolve(event as T);
    };

    const handleError = () => {
      cleanup();
      reject(new Error(`Failed while waiting for ${eventName}`));
    };

    target.addEventListener(eventName, handleEvent, { once: true });
    target.addEventListener("error", handleError, { once: true });
  });

const roundSeconds = (value: number) => Math.round(value * 1000) / 1000;

export const readVideoMetadata = async (file: File): Promise<VideoClipMetadata> => {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  try {
    video.src = url;
    await waitForEvent(video, "loadedmetadata");

    return {
      durationSeconds: Number.isFinite(video.duration) ? roundSeconds(video.duration) : 0,
      width: video.videoWidth || 0,
      height: video.videoHeight || 0,
    };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
};

/**
 * Builds a clamped VideoClipSelection with no artificial upper bound on clip
 * length beyond the video's own duration — unlike
 * `createClipSelectionFromRange` (used by the capped highlight flow), there
 * is no `maxSeconds` here.
 */
export const createSelectionFromRange = (
  durationSeconds: number,
  startSeconds: number,
  endSeconds: number,
  minSeconds: number = MIN_CLIP_DURATION_SECONDS,
): VideoClipSelection => {
  const safeDuration = Math.max(0, durationSeconds);
  return createClipSelectionFromRange(
    safeDuration,
    startSeconds,
    endSeconds,
    minSeconds,
    Math.max(safeDuration, minSeconds),
  );
};

// Initial selection when a file is first picked. With no `initialWindowSeconds`
// the whole video is selected by default (the "full video by default, trim
// optional" flow); passing one preserves the older "first N seconds" UX some
// callers still want (e.g. videos-mfe's short-highlight upload surface).
export const createDefaultSelection = (
  durationSeconds: number,
  initialWindowSeconds?: number,
): VideoClipSelection => {
  const safeDuration = Math.max(0, durationSeconds);
  const endSeconds =
    initialWindowSeconds == null
      ? safeDuration
      : Math.min(initialWindowSeconds, safeDuration || initialWindowSeconds);
  return createSelectionFromRange(safeDuration, 0, endSeconds);
};

// True when the user's selection covers (approximately) the entire video —
// in that case the original File should be uploaded unmodified, no re-encode.
export const isFullVideoSelection = (
  selection: VideoClipSelection,
  toleranceSeconds: number = FULL_SELECTION_TOLERANCE_SECONDS,
): boolean => {
  const coversStart = selection.trimStartSeconds <= toleranceSeconds;
  const coversEnd = selection.originalDurationSeconds - selection.trimEndSeconds <= toleranceSeconds;
  return coversStart && coversEnd;
};
