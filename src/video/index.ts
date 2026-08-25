export { default as HighlightRangeSelector } from "./HighlightRangeSelector";
export type { HighlightRangeSelectorProps, HighlightRangeSelectorLabels } from "./HighlightRangeSelector";

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
