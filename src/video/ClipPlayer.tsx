import React, { useEffect, useRef, useState } from "react";
import { FiMaximize, FiMinimize, FiPause, FiPlay, FiVolume2, FiVolumeX } from "react-icons/fi";

export interface ClipPlayerProps {
  src: string;
  className?: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  preload?: "none" | "metadata" | "auto";
  controls?: boolean;
  loadingLabel?: string;
  /**
   * A clip produced by the fast, no-re-encode trim path keeps the source
   * file's original (non-zero-based) timestamps. When both are provided AND
   * they actually fit inside the real file's duration, playback is rebased
   * to a zero-based clip timeline: [trimStartSeconds, trimStartSeconds +
   * clipDurationSeconds] displays as [0:00, clip duration]. If the file
   * turns out shorter than trimStartSeconds (e.g. it was produced by a
   * real-time capture fallback that's already zero-based, and the caller
   * still sent the source-relative offset), this is detected on
   * loadedmetadata and the whole file is played instead — never seeks past
   * the end.
   */
  trimStartSeconds?: number;
  clipDurationSeconds?: number;
  onOrientationChange?: (orientation: "portrait" | "landscape") => void;
  onAspectRatioChange?: (ratio: string) => void;
}

const SEEK_STEP_SECONDS = 5;

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

const ClipPlayer: React.FC<ClipPlayerProps> = ({
  src,
  className,
  poster,
  autoPlay = false,
  muted = false,
  loop = false,
  preload = "metadata",
  controls = true,
  loadingLabel = "Cargando…",
  trimStartSeconds,
  clipDurationSeconds,
  onOrientationChange,
  onAspectRatioChange,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(true);
  const [isMuted, setIsMuted] = useState(muted);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpandedFallback, setIsExpandedFallback] = useState(false);
  const [realDuration, setRealDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [trimMetadataFitsFile, setTrimMetadataFitsFile] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  const hasTrimMetadataProps =
    typeof clipDurationSeconds === "number" && Number.isFinite(clipDurationSeconds) && clipDurationSeconds > 0;
  const hasTrimMetadata = hasTrimMetadataProps && trimMetadataFitsFile;
  const rawClipStart = trimStartSeconds && trimStartSeconds > 0 ? trimStartSeconds : 0;
  const clipStart = hasTrimMetadata ? rawClipStart : 0;
  const clipEnd = hasTrimMetadata ? clipStart + (clipDurationSeconds || 0) : realDuration;
  const windowDuration = Math.max(0, clipEnd - clipStart);

  useEffect(() => {
    setOrientation("landscape");
    setIsPlaying(false);
    setIsBuffering(true);
    setRealDuration(0);
    setElapsed(0);
    setTrimMetadataFitsFile(true);
  }, [src]);

  const detectAndEmitOrientation = (video: HTMLVideoElement) => {
    const { videoWidth, videoHeight } = video;
    if (videoWidth === 0 || videoHeight === 0) return;
    const detected = videoHeight > videoWidth ? "portrait" : "landscape";
    setOrientation(detected);
    onOrientationChange?.(detected);
    onAspectRatioChange?.(`${videoWidth} / ${videoHeight}`);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !autoPlay) return;
    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => undefined);
    }
  }, [autoPlay, src]);

  // Bounds playback to [clipStart, clipEnd] and keeps the displayed elapsed
  // time zero-based, whether that window comes from real trim metadata or
  // (when there isn't any, or it didn't fit the file) the whole file.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || windowDuration <= 0) return;

    const handleTimeUpdate = () => {
      if (video.currentTime >= clipEnd) {
        video.currentTime = clipStart;
        setElapsed(0);
        if (loop) {
          void video.play().catch(() => undefined);
        } else {
          video.pause();
          setIsPlaying(false);
        }
        return;
      }
      setElapsed(Math.max(0, video.currentTime - clipStart));
    };
    const handlePlay = () => {
      if (video.currentTime < clipStart || video.currentTime >= clipEnd) {
        video.currentTime = clipStart;
      }
      setIsPlaying(true);
    };
    const handlePause = () => setIsPlaying(false);
    const handleWaiting = () => setIsBuffering(true);
    const handlePlaying = () => setIsBuffering(false);
    const handleCanPlay = () => setIsBuffering(false);

    video.addEventListener("timeupdate", handleTimeUpdate);
    video.addEventListener("play", handlePlay);
    video.addEventListener("pause", handlePause);
    video.addEventListener("ended", handlePause);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("stalled", handleWaiting);
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("canplay", handleCanPlay);
    return () => {
      video.removeEventListener("timeupdate", handleTimeUpdate);
      video.removeEventListener("play", handlePlay);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("ended", handlePause);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("stalled", handleWaiting);
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("canplay", handleCanPlay);
    };
  }, [clipStart, clipEnd, windowDuration, loop]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const seekToClientX = (clientX: number) => {
    const video = videoRef.current;
    const track = trackRef.current;
    if (!video || !track || windowDuration <= 0) return;
    const rect = track.getBoundingClientRect();
    const percent = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const clamped = Math.min(1, Math.max(0, percent));
    video.currentTime = clipStart + clamped * windowDuration;
  };

  const handleTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    seekToClientX(event.clientX);
  };
  const handleTrackPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    seekToClientX(event.clientX);
  };
  const handleTrackPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const handleTrackKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      video.currentTime = Math.min(clipEnd, video.currentTime + SEEK_STEP_SECONDS);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      video.currentTime = Math.max(clipStart, video.currentTime - SEEK_STEP_SECONDS);
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (document.fullscreenElement === container) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (container.requestFullscreen) {
      container.requestFullscreen().catch(() => setIsExpandedFallback((prev) => !prev));
    } else {
      setIsExpandedFallback((prev) => !prev);
    }
  };

  const progressPercent = windowDuration > 0 ? Math.min(100, (elapsed / windowDuration) * 100) : 0;

  return (
    <div
      ref={containerRef}
      className={[
        "vc-clip-player",
        `is-${orientation}`,
        isPlaying ? "is-playing" : "",
        isBuffering ? "is-buffering" : "",
        isExpandedFallback ? "is-expanded-fallback" : "",
        className || "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="vc-clip-player__stage">
        <video
          ref={videoRef}
          className="vc-clip-player__video"
          src={src}
          poster={poster}
          autoPlay={autoPlay}
          muted={muted}
          loop={loop && !hasTrimMetadataProps}
          playsInline
          preload={preload}
          controls={false}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            detectAndEmitOrientation(video);
            const duration = video.duration;
            setRealDuration(Number.isFinite(duration) ? duration : 0);
            if (!hasTrimMetadataProps) return;
            if (Number.isFinite(duration) && rawClipStart >= duration - 0.05) {
              setTrimMetadataFitsFile(false);
              return;
            }
            video.currentTime = rawClipStart;
          }}
          onLoadedData={(event) => {
            setIsBuffering(false);
            detectAndEmitOrientation(event.currentTarget);
          }}
          onCanPlay={() => setIsBuffering(false)}
        />

        <button
          type="button"
          className="vc-clip-player__tap-veil"
          onClick={togglePlayback}
          aria-label={isPlaying ? "Pausar" : "Reproducir"}
        />

        <div className="vc-clip-player__center-play" aria-hidden="true">
          <FiPlay />
        </div>

        <div className="vc-clip-player__buffer-overlay">
          <span className="vc-clip-player__spinner" aria-hidden="true" />
          <span className="vc-clip-player__buffer-label">{loadingLabel}</span>
        </div>

        {controls ? (
          <div className="vc-clip-player__controls">
            <button
              type="button"
              className="vc-clip-player__play-btn"
              onClick={togglePlayback}
              aria-label={isPlaying ? "Pausar" : "Reproducir"}
            >
              {isPlaying ? <FiPause aria-hidden="true" /> : <FiPlay aria-hidden="true" />}
            </button>

            <div
              className="vc-clip-player__track"
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Progreso del video"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPercent)}
              onPointerDown={handleTrackPointerDown}
              onPointerMove={handleTrackPointerMove}
              onPointerUp={handleTrackPointerUp}
              onPointerCancel={handleTrackPointerUp}
              onKeyDown={handleTrackKeyDown}
            >
              <div className="vc-clip-player__track-base">
                <div className="vc-clip-player__track-fill" style={{ width: `${progressPercent}%` }} />
                <div className="vc-clip-player__track-thumb" style={{ left: `${progressPercent}%` }} />
              </div>
            </div>

            <span className="vc-clip-player__time">
              {formatSeconds(elapsed)} / {formatSeconds(windowDuration)}
            </span>

            <button
              type="button"
              className="vc-clip-player__icon-btn"
              onClick={toggleMute}
              aria-label={isMuted ? "Activar sonido" : "Silenciar"}
            >
              {isMuted ? <FiVolumeX aria-hidden="true" /> : <FiVolume2 aria-hidden="true" />}
            </button>

            <button
              type="button"
              className="vc-clip-player__icon-btn"
              onClick={toggleFullscreen}
              aria-label={isFullscreen || isExpandedFallback ? "Salir de pantalla completa" : "Pantalla completa"}
            >
              {isFullscreen || isExpandedFallback ? (
                <FiMinimize aria-hidden="true" />
              ) : (
                <FiMaximize aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ClipPlayer;
