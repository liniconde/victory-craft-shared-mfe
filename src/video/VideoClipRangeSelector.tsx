import React, { useEffect, useMemo, useRef, useState } from "react";
import { FiCheckCircle, FiScissors } from "react-icons/fi";
import { canRecordVideoClipInBrowser, type VideoClipMetadata, type VideoClipSelection } from "./clipSelection";
import { createSelectionFromRange, isFullVideoSelection } from "./videoClipUpload";
import { FOCUS_SPAN_SECONDS, computeLensWindow, timeToTrackPercent, trackPercentToTime } from "./timelineLens";

export interface VideoClipRangeSelectorLabels {
  title: string;
  statusFullVideo: string;
  statusTrimmed: string;
  statusUnsupported: string;
  originalDuration: (duration: string) => string;
  selectedRange: (start: string, end: string) => string;
  selectedDuration: (duration: string) => string;
  /** Single summary line shown instead of the three `span`s above when
   * `compact` is set — mobile views default to less copy. */
  compactSummary: (total: string, start: string, end: string, duration: string) => string;
  startHandle: string;
  endHandle: string;
  processingHint: string;
  unsupportedHint: string;
}

export interface VideoClipRangeSelectorProps {
  file: File;
  metadata: VideoClipMetadata;
  selection: VideoClipSelection;
  labels: VideoClipRangeSelectorLabels;
  /** Minimum clip length in seconds — defaults to 1. There is no maximum:
   * this selector is meant for "trim an already-uploaded-size video",
   * unlike HighlightRangeSelector which enforces both a min and a max. */
  minClipSeconds?: number;
  disabled?: boolean;
  onSelectionChange: (selection: VideoClipSelection) => void;
  /** Mobile screens default to less copy: one summary line, no processing hint. */
  compact?: boolean;
}

const TRIM_STEP_SECONDS = 0.25;

type TrimHandle = "start" | "end";

const formatSeconds = (value: number) => {
  const safe = Math.max(0, Math.round(value));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const VideoClipRangeSelector: React.FC<VideoClipRangeSelectorProps> = ({
  file,
  metadata,
  selection,
  labels,
  minClipSeconds = 1,
  disabled,
  onSelectionChange,
  compact = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [draggingHandle, setDraggingHandle] = useState<TrimHandle | null>(null);
  const canRecord = canRecordVideoClipInBrowser();
  const canAdjustRange = metadata.durationSeconds > minClipSeconds && canRecord;
  const rangeInteractive = canAdjustRange && !disabled;
  const isFullSelection = isFullVideoSelection(selection);

  const minLabel = formatSeconds(selection.trimStartSeconds);
  const maxLabel = formatSeconds(selection.trimEndSeconds);
  const durationLabel = formatSeconds(selection.clipDurationSeconds);
  const lens = useMemo(
    () => computeLensWindow(metadata.durationSeconds, selection.trimStartSeconds, selection.trimEndSeconds),
    [metadata.durationSeconds, selection.trimStartSeconds, selection.trimEndSeconds],
  );
  const isLensed = metadata.durationSeconds > FOCUS_SPAN_SECONDS;
  const startPct = timeToTrackPercent(selection.trimStartSeconds, metadata.durationSeconds, lens);
  const endPct = timeToTrackPercent(selection.trimEndSeconds, metadata.durationSeconds, lens);
  const lensStartPct = timeToTrackPercent(lens.focusStart, metadata.durationSeconds, lens);
  const lensEndPct = timeToTrackPercent(lens.focusEnd, metadata.durationSeconds, lens);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => {
      if (video.currentTime < selection.trimStartSeconds || video.currentTime >= selection.trimEndSeconds) {
        video.currentTime = selection.trimStartSeconds;
      }
    };

    const handleTimeUpdate = () => {
      if (!video.paused && video.currentTime >= selection.trimEndSeconds) {
        video.currentTime = selection.trimStartSeconds;
        void video.play().catch(() => undefined);
      }
    };

    video.addEventListener("play", handlePlay);
    video.addEventListener("timeupdate", handleTimeUpdate);
    return () => {
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [selection.trimEndSeconds, selection.trimStartSeconds]);

  const statusLabel = !canRecord
    ? labels.statusUnsupported
    : isFullSelection
      ? labels.statusFullVideo
      : labels.statusTrimmed;

  const seekPreview = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    videoRef.current.currentTime = time;
  };

  const applyStart = (time: number) => {
    const nextSelection = createSelectionFromRange(
      metadata.durationSeconds,
      time,
      selection.trimEndSeconds,
      minClipSeconds,
    );
    onSelectionChange(nextSelection);
    seekPreview(nextSelection.trimStartSeconds);
  };

  const applyEnd = (time: number) => {
    const nextSelection = createSelectionFromRange(
      metadata.durationSeconds,
      selection.trimStartSeconds,
      time,
      minClipSeconds,
    );
    onSelectionChange(nextSelection);
    seekPreview(nextSelection.trimEndSeconds);
  };

  const applyHandle = (handle: TrimHandle, time: number) => {
    if (handle === "start") applyStart(time);
    else applyEnd(time);
  };

  const timeFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || metadata.durationSeconds <= 0) return 0;
    const rect = track.getBoundingClientRect();
    const percent = rect.width > 0 ? ((clientX - rect.left) / rect.width) * 100 : 0;
    const clampedPercent = Math.min(100, Math.max(0, percent));
    return trackPercentToTime(clampedPercent, metadata.durationSeconds, lens);
  };

  const handlePointerDown = (handle: TrimHandle) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rangeInteractive) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggingHandle(handle);
    applyHandle(handle, timeFromClientX(event.clientX));
  };

  const handlePointerMove = (handle: TrimHandle) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (draggingHandle !== handle) return;
    applyHandle(handle, timeFromClientX(event.clientX));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setDraggingHandle(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (handle: TrimHandle) => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!rangeInteractive) return;
    const current = handle === "start" ? selection.trimStartSeconds : selection.trimEndSeconds;
    let next: number | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = current - TRIM_STEP_SECONDS;
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = current + TRIM_STEP_SECONDS;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = metadata.durationSeconds;

    if (next === null) return;
    event.preventDefault();
    applyHandle(handle, next);
  };

  return (
    <article className="vc-video-clip-range">
      <div className="vc-video-clip-range__header">
        <span className="vc-video-clip-range__icon">
          {isFullSelection ? <FiCheckCircle aria-hidden="true" /> : <FiScissors aria-hidden="true" />}
        </span>
        <div>
          <span>{labels.title}</span>
          <strong>{statusLabel}</strong>
        </div>
      </div>

      {previewUrl ? (
        <video
          ref={videoRef}
          className="vc-video-clip-range__preview"
          src={previewUrl}
          controls
          muted
          playsInline
          preload="metadata"
        />
      ) : null}

      {compact ? (
        <p className="vc-video-clip-range__meta-compact">
          {labels.compactSummary(formatSeconds(metadata.durationSeconds), minLabel, maxLabel, durationLabel)}
        </p>
      ) : (
        <div className="vc-video-clip-range__meta">
          <span>{labels.originalDuration(formatSeconds(metadata.durationSeconds))}</span>
          <span>{labels.selectedRange(minLabel, maxLabel)}</span>
          <span>{labels.selectedDuration(durationLabel)}</span>
        </div>
      )}

      {canAdjustRange ? (
        <div className={`vc-video-clip-range__track ${rangeInteractive ? "" : "is-disabled"}`} ref={trackRef}>
          <div className="vc-video-clip-range__track-base" />
          {isLensed ? (
            <div
              className="vc-video-clip-range__lens-wash"
              style={{ left: `${lensStartPct}%`, width: `${Math.max(0, lensEndPct - lensStartPct)}%` }}
            />
          ) : null}
          <div
            className="vc-video-clip-range__track-fill"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          />
          <div
            className="vc-video-clip-range__handle"
            style={{ left: `${startPct}%` }}
            role="slider"
            tabIndex={rangeInteractive ? 0 : -1}
            aria-label={labels.startHandle}
            aria-valuemin={0}
            aria-valuemax={metadata.durationSeconds}
            aria-valuenow={selection.trimStartSeconds}
            aria-valuetext={minLabel}
            onPointerDown={handlePointerDown("start")}
            onPointerMove={handlePointerMove("start")}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown("start")}
          />
          <div
            className="vc-video-clip-range__handle vc-video-clip-range__handle--end"
            style={{ left: `${endPct}%` }}
            role="slider"
            tabIndex={rangeInteractive ? 0 : -1}
            aria-label={labels.endHandle}
            aria-valuemin={0}
            aria-valuemax={metadata.durationSeconds}
            aria-valuenow={selection.trimEndSeconds}
            aria-valuetext={maxLabel}
            onPointerDown={handlePointerDown("end")}
            onPointerMove={handlePointerMove("end")}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onKeyDown={handleKeyDown("end")}
          />
        </div>
      ) : null}

      {compact && canRecord ? null : (
        <p className="vc-video-clip-range__hint">{canRecord ? labels.processingHint : labels.unsupportedHint}</p>
      )}
    </article>
  );
};

export default VideoClipRangeSelector;
