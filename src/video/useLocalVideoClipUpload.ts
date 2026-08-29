import { useCallback, useState } from "react";
import type { VideoClipMetadata, VideoClipSelection } from "./clipSelection";
import {
  createDefaultSelection,
  isFullVideoSelection,
  readVideoMetadata,
  type PreparedVideoClip,
} from "./videoClipUpload";
import { trimVideoFile, VideoTooLargeForBrowserProcessingError } from "./trimVideoFile";

// 5 GB — same default both consuming apps (videos-mfe, root) already used
// before this hook was extracted. Callers with a different limit (or none)
// should pass `maxSizeBytes` explicitly instead of relying on this default.
export const DEFAULT_MAX_VIDEO_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

export type LocalVideoClipFileError =
  | "invalidType"
  | "sizeExceeded"
  | "metadataUnreadable"
  | "browserProcessingTooLarge";

export interface UseLocalVideoClipUploadOptions {
  /** Defaults to `DEFAULT_MAX_VIDEO_SIZE_BYTES` (5GB). */
  maxSizeBytes?: number;
  /** Picks the mobile vs desktop threshold for the real-time capture
   * fallback (see sizeGuard.ts) — that path re-encodes in real time and
   * holds real memory/GPU pressure, far more likely to crash a tab on
   * mobile than on desktop. Defaults to false. */
  isMobile?: boolean;
  /** Initial window (in seconds) selected when a file is first picked, e.g.
   * "the first 30 seconds". Omit to default to the full video — the
   * "upload the whole thing, trim optional" behavior. */
  initialWindowSeconds?: number;
  onFileError?: (error: LocalVideoClipFileError) => void;
}

/**
 * Reusable "pick a local video, read its metadata, let the user choose a
 * range to upload (or the full video)" state machine. Deliberately does NOT
 * perform the actual network upload — callers own that (see `uploadVideoFile`
 * in this package) — this hook only owns file selection, metadata, range
 * selection, and clip preparation, so it can be dropped into any upload
 * surface without dragging along a specific API call.
 */
export function useLocalVideoClipUpload(options: UseLocalVideoClipUploadOptions = {}) {
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_VIDEO_SIZE_BYTES;
  const isMobile = options.isMobile ?? false;
  const initialWindowSeconds = options.initialWindowSeconds;
  const onFileError = options.onFileError;

  const [file, setFile] = useState<File | null>(null);
  const [metadata, setMetadata] = useState<VideoClipMetadata | null>(null);
  const [selection, setSelection] = useState<VideoClipSelection | null>(null);
  const [isReadingMetadata, setIsReadingMetadata] = useState(false);
  const [isPreparingClip, setIsPreparingClip] = useState(false);
  const [clipPrepProgress, setClipPrepProgress] = useState<number | null>(null);

  const reset = useCallback(() => {
    setFile(null);
    setMetadata(null);
    setSelection(null);
  }, []);

  const selectFile = useCallback(
    async (candidate: File | null) => {
      reset();
      if (!candidate) return;

      if (!candidate.type.startsWith("video/")) {
        onFileError?.("invalidType");
        return;
      }

      if (candidate.size > maxSizeBytes) {
        onFileError?.("sizeExceeded");
        return;
      }

      try {
        setIsReadingMetadata(true);
        const meta = await readVideoMetadata(candidate);
        setFile(candidate);
        setMetadata(meta);
        setSelection(createDefaultSelection(meta.durationSeconds, initialWindowSeconds));
      } catch {
        onFileError?.("metadataUnreadable");
      } finally {
        setIsReadingMetadata(false);
      }
    },
    [maxSizeBytes, onFileError, reset, initialWindowSeconds],
  );

  /** Returns the file to upload — original or trimmed — per the current selection. */
  const prepareFile = useCallback(async (): Promise<PreparedVideoClip | null> => {
    if (!file || !selection) return null;
    if (isFullVideoSelection(selection)) {
      return { file, selection, wasGeneratedInBrowser: false };
    }

    setIsPreparingClip(true);
    setClipPrepProgress(0);
    try {
      const { file: trimmedFile } = await trimVideoFile(file, selection.trimStartSeconds, selection.trimEndSeconds, {
        isMobile,
        onProgress: setClipPrepProgress,
      });
      return { file: trimmedFile, selection, wasGeneratedInBrowser: true };
    } catch (error) {
      if (error instanceof VideoTooLargeForBrowserProcessingError) {
        onFileError?.("browserProcessingTooLarge");
        return null;
      }
      throw error;
    } finally {
      setIsPreparingClip(false);
      setClipPrepProgress(null);
    }
  }, [file, selection, isMobile, onFileError]);

  return {
    file,
    metadata,
    selection,
    setSelection,
    isReadingMetadata,
    isPreparingClip,
    clipPrepProgress,
    selectFile,
    prepareFile,
    reset,
  };
}
