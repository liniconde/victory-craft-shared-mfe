import { detectContainerFormat } from "./containerFormat";
import { captureClipInBrowser } from "./browserCapture";
import { canCaptureVideoStreamInBrowser } from "./clipSelection";
import { Mp4FastTrimUnavailableError, trimMp4Fast } from "./mp4FastTrim";
import { getBrowserCaptureMaxBytes } from "./sizeGuard";

export type TrimMethod = "fast-mp4" | "browser-capture";

export interface TrimVideoFileOptions {
  isMobile: boolean;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export class VideoTooLargeForBrowserProcessingError extends Error {
  constructor(public readonly maxBytes: number) {
    super("This video is too large to process in this browser.");
    this.name = "VideoTooLargeForBrowserProcessingError";
  }
}

/**
 * Trims a local video File to [trimStartSeconds, trimEndSeconds].
 *
 * Tries the fast, memory-light container-level path first (see
 * mp4FastTrim.ts — MP4/MOV only, no re-encode, cost scales with output size
 * not source size). Falls back to real-time browser capture
 * (browserCapture.ts) for any other format, or if the fast path fails for
 * any reason — but the fallback re-encodes in real time and holds real
 * memory/GPU pressure for the clip's duration, so it's gated by a
 * mobile/desktop size guard: a huge file that isn't MP4/MOV (or whose fast
 * path failed) is rejected with a clear error instead of risking a crashed
 * tab.
 */
export const trimVideoFile = async (
  sourceFile: File,
  trimStartSeconds: number,
  trimEndSeconds: number,
  options: TrimVideoFileOptions,
): Promise<{ file: File; method: TrimMethod }> => {
  const format = await detectContainerFormat(sourceFile);

  if (format === "iso-bmff") {
    try {
      const file = await trimMp4Fast(sourceFile, trimStartSeconds, trimEndSeconds);
      return { file, method: "fast-mp4" };
    } catch (error) {
      if (!(error instanceof Mp4FastTrimUnavailableError)) throw error;
      // Fall through to the browser-capture fallback below.
    }
  }

  const maxBytes = getBrowserCaptureMaxBytes(options.isMobile);
  if (sourceFile.size > maxBytes) {
    throw new VideoTooLargeForBrowserProcessingError(maxBytes);
  }
  if (!canCaptureVideoStreamInBrowser()) {
    throw new Error("Browser video recording is not supported.");
  }

  const file = await captureClipInBrowser(sourceFile, trimStartSeconds, trimEndSeconds, {
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return { file, method: "browser-capture" };
};
