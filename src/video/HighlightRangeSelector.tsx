import React, { useMemo, useEffect, useRef, useState } from "react";
import { FiFilm, FiPause, FiPlay, FiScissors } from "react-icons/fi";
import { canCaptureVideoStreamInBrowser, createClipSelectionFromRange, type VideoClipMetadata, type VideoClipSelection } from "./clipSelection";
import { FOCUS_SPAN_SECONDS, computeLensWindow, timeToTrackPercent, trackPercentToTime } from "./timelineLens";

export interface HighlightRangeSelectorLabels {
  title: string;
  statusReady: string;
  statusUnsupported: string;
  playPreview: string;
  pausePreview: string;
  originalDuration: (duration: string) => string;
  selectedRange: (start: string, end: string) => string;
  selectedDuration: (duration: string) => string;
  startHandle: string;
  endHandle: string;
  hint: (minSeconds: number, maxSeconds: number) => string;
}

export interface HighlightRangeSelectorProps {
  videoUrl: string;
  metadata: VideoClipMetadata;
  selection: VideoClipSelection;
  labels: HighlightRangeSelectorLabels;
  minClipSeconds?: number;
  maxClipSeconds?: number;
  disabled?: boolean;
  onSelectionChange: (selection: VideoClipSelection) => void;
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

const HighlightRangeSelector: React.FC<HighlightRangeSelectorProps> = ({
  videoUrl,
  metadata,
  selection,
  labels,
  minClipSeconds = 5,
  maxClipSeconds = 30,
  disabled,
  onSelectionChange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<TrimHandle | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const canRecord = canCaptureVideoStreamInBrowser();
  const canAdjustRange = metadata.durationSeconds > minClipSeconds;
  const rangeInteractive = canAdjustRange && !disabled && canRecord;

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

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlaying = () => setIsPlaying(true);
    const handlePaused = () => setIsPlaying(false);

    video.addEventListener("play", handlePlaying);
    video.addEventListener("pause", handlePaused);
    video.addEventListener("ended", handlePaused);
    return () => {
      video.removeEventListener("play", handlePlaying);
      video.removeEventListener("pause", handlePaused);
      video.removeEventListener("ended", handlePaused);
    };
  }, [videoUrl]);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const seekPreview = (time: number) => {
    if (!videoRef.current) return;
    videoRef.current.pause();
    videoRef.current.currentTime = time;
  };

  const applyStart = (time: number) => {
    const nextSelection = createClipSelectionFromRange(
      metadata.durationSeconds,
      time,
      selection.trimEndSeconds,
      minClipSeconds,
      maxClipSeconds,
    );
    onSelectionChange(nextSelection);
    seekPreview(nextSelection.trimStartSeconds);
  };

  const applyEnd = (time: number) => {
    const nextSelection = createClipSelectionFromRange(
      metadata.durationSeconds,
      selection.trimStartSeconds,
      time,
      minClipSeconds,
      maxClipSeconds,
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
    <article className="vc-highlight-trim">
      <div className="vc-highlight-trim__header">
        <span className="vc-highlight-trim__icon">
          <FiScissors aria-hidden="true" />
        </span>
        <div>
          <span>{labels.title}</span>
          <strong>{canRecord ? labels.statusReady : labels.statusUnsupported}</strong>
        </div>
      </div>

      <video
        ref={videoRef}
        className="vc-highlight-trim__preview"
        src={videoUrl}
        crossOrigin="anonymous"
        controls
        muted
        playsInline
        preload="metadata"
      />

      <div className="vc-highlight-trim__meta">
        <button
          type="button"
          className="vc-highlight-trim__play-button"
          onClick={togglePlayback}
          aria-label={isPlaying ? labels.pausePreview : labels.playPreview}
          title={isPlaying ? labels.pausePreview : labels.playPreview}
        >
          {isPlaying ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
        </button>
        <span>
          <FiFilm aria-hidden="true" />
          {labels.originalDuration(formatSeconds(metadata.durationSeconds))}
        </span>
        <span>{labels.selectedRange(minLabel, maxLabel)}</span>
        <span>{labels.selectedDuration(durationLabel)}</span>
      </div>

      {canAdjustRange ? (
        <div
          className={`vc-highlight-trim__track ${rangeInteractive ? "" : "is-disabled"}`}
          ref={trackRef}
        >
          <div className="vc-highlight-trim__track-base" />
          {isLensed ? (
            <div
              className="vc-highlight-trim__lens-wash"
              style={{ left: `${lensStartPct}%`, width: `${Math.max(0, lensEndPct - lensStartPct)}%` }}
            />
          ) : null}
          <div
            className="vc-highlight-trim__track-fill"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          />
          <div
            className="vc-highlight-trim__handle vc-highlight-trim__handle--lane-start"
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
            className="vc-highlight-trim__handle vc-highlight-trim__handle--end vc-highlight-trim__handle--lane-end"
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

      <p className="vc-highlight-trim__hint">{labels.hint(minClipSeconds, maxClipSeconds)}</p>
    </article>
  );
};

export default HighlightRangeSelector;
