export { default as HighlightRangeSelector } from "./HighlightRangeSelector";
export type { HighlightRangeSelectorProps, HighlightRangeSelectorLabels } from "./HighlightRangeSelector";

export { default as ClipPlayer } from "./ClipPlayer";
export type { ClipPlayerProps, ClipPlayerPlaybackMode } from "./ClipPlayer";

export {
  canCaptureVideoStreamInBrowser,
  canRecordVideoClipInBrowser,
  createClipSelectionFromRange,
  createDefaultClipSelection,
} from "./clipSelection";
export type { VideoClipMetadata, VideoClipSelection } from "./clipSelection";

export { FOCUS_SPAN_SECONDS, computeLensWindow, timeToTrackPercent, trackPercentToTime } from "./timelineLens";
export type { LensWindow } from "./timelineLens";

export { detectContainerFormat } from "./containerFormat";
export type { DetectedContainerFormat } from "./containerFormat";

export {
  BROWSER_CAPTURE_MAX_BYTES_DESKTOP,
  BROWSER_CAPTURE_MAX_BYTES_MOBILE,
  getBrowserCaptureMaxBytes,
} from "./sizeGuard";

export { captureClipInBrowser } from "./browserCapture";
export { Mp4FastTrimUnavailableError, trimMp4Fast } from "./mp4FastTrim";
export { trimVideoFile, VideoTooLargeForBrowserProcessingError } from "./trimVideoFile";
export type { TrimMethod, TrimVideoFileOptions } from "./trimVideoFile";

export { default as VideoClipRangeSelector } from "./VideoClipRangeSelector";
export type { VideoClipRangeSelectorProps, VideoClipRangeSelectorLabels } from "./VideoClipRangeSelector";

export {
  MIN_CLIP_DURATION_SECONDS,
  createDefaultSelection,
  createSelectionFromRange,
  isFullVideoSelection,
  readVideoMetadata,
} from "./videoClipUpload";
export type { PreparedVideoClip } from "./videoClipUpload";

export { useLocalVideoClipUpload, DEFAULT_MAX_VIDEO_SIZE_BYTES } from "./useLocalVideoClipUpload";
export type { LocalVideoClipFileError, UseLocalVideoClipUploadOptions } from "./useLocalVideoClipUpload";

export { uploadFileMultipart, MULTIPART_UPLOAD_THRESHOLD_BYTES } from "./multipartUpload";
export type {
  HttpClient,
  MultipartInitResponse,
  MultipartPartUrl,
  MultipartUploadedPart,
  MultipartUploadParams,
  MultipartUploadResult,
} from "./multipartUpload";

export { uploadVideoFile } from "./uploadVideoFile";
export type { UploadVideoFileOptions, UploadVideoFileResult } from "./uploadVideoFile";
