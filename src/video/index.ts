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
