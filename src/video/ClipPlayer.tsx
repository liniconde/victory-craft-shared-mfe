import React, { useEffect, useRef, useState } from "react";
import { FiAlertTriangle, FiMaximize, FiMinimize, FiPause, FiPlay, FiVolume2, FiVolumeX } from "react-icons/fi";

/** Feed-style virtualized lists (e.g. a swipeable rankings feed) mount many
 * players at once but only want one actually playing at a time. Mirrors
 * RecruiterVideoPlaybackMode's shape so callers can pass that straight
 * through without a translation layer, without this package depending on
 * the app's own type. */
export type ClipPlayerPlaybackMode = "active" | "preload" | "idle" | "off";

export interface ClipPlayerProps {
  src: string;
  className?: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  preload?: "none" | "metadata" | "auto";
  controls?: boolean;
  /** "default" shows play/pause, the scrub track, the time label, mute, and
   * fullscreen. "feed" drops the scrub track and time label — just
   * play/pause, mute, and fullscreen — for dense swipeable feeds where a
   * full transport bar is more chrome than the card has room for. */
  variant?: "default" | "feed";
  /** Pause immediately regardless of autoPlay — for a feed item that's been
   * scrolled out of the active slot. Defaults to true (always eligible). */
  isActive?: boolean;
  /** See ClipPlayerPlaybackMode — "off" pauses like isActive=false;
   * "preload" mounts the element (so it's ready to play instantly once
   * active) without ever calling play(), even if autoPlay is set. */
  playbackMode?: ClipPlayerPlaybackMode;
  loadingLabel?: string;
  /** Shown in the error overlay when the native <video> element fails to
   * load its src (403/404, CORS block, expired presigned URL, unsupported
   * codec, ...). Defaults to a generic Spanish message since ClipPlayer has
   * no way to know *why* it failed. */
  errorLabel?: string;
  /** Label for the retry button inside the error overlay. */
  retryLabel?: string;
  /**
   * How long to wait for the browser to report metadata before treating the
   * load as failed. A `<video>` that never gets there does NOT fire `error`
   * — it just sits at readyState 0 / networkState 2 (NETWORK_LOADING) with a
   * spinner over it forever, which is what a viewer sees as "CARGANDO…" and
   * 0:00 / 0:00 with no way out. Set to 0 to disable the timeout.
   */
  loadTimeoutMs?: number;
  /** Called when the native <video> element fires its `error` event, i.e.
   * the src failed to load for any reason. ClipPlayer itself only knows how
   * to retry loading the *same* src (via the retry button, which calls
   * video.load()) — it has no notion of signed-URL mechanics. This callback
   * lets a host app react to the failure however it needs to, e.g.
   * re-fetching a fresh signed URL and passing a new src down. Optional and
   * best-effort: ClipPlayer's own error UI works whether or not this is
   * provided. */
  onPlaybackError?: () => void;
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
const AUTO_HIDE_DELAY_MS = 1000;

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
  variant = "default",
  isActive = true,
  playbackMode = "active",
  loadingLabel = "Cargando…",
  errorLabel = "No se pudo cargar el video",
  retryLabel = "Reintentar",
  loadTimeoutMs = 20000,
  onPlaybackError,
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
  const [hasError, setHasError] = useState(false);
  const [isMuted, setIsMuted] = useState(muted);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isExpandedFallback, setIsExpandedFallback] = useState(false);
  const [realDuration, setRealDuration] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [trimMetadataFitsFile, setTrimMetadataFitsFile] = useState(true);
  const [isDragging, setIsDragging] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    setHasError(false);
    setRealDuration(0);
    setElapsed(0);
    setTrimMetadataFitsFile(true);
    setControlsHidden(false);
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }, [src]);

  // Nothing else surfaces a load that never finishes: the element reports no
  // error, so without this the buffer overlay stays up indefinitely. Skipped
  // for preload="none", where staying at readyState 0 until the viewer presses
  // play is the correct, expected state rather than a failure.
  useEffect(() => {
    if (!src || hasError || loadTimeoutMs <= 0 || preload === "none") return;
    const timeoutId = setTimeout(() => {
      const video = videoRef.current;
      if (video && video.readyState >= 1) return; // metadata arrived in time
      setHasError(true);
      setIsBuffering(false);
      onPlaybackError?.();
    }, loadTimeoutMs);
    return () => clearTimeout(timeoutId);
  }, [src, loadAttempt, hasError, loadTimeoutMs, preload, onPlaybackError]);

  useEffect(() => () => {
    if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
  }, []);

  // Mirrors what "el reproductor normal" does: once playback starts, the
  // control bar auto-hides after a beat so it doesn't cover the video, and
  // only comes back when the viewer presses play again or taps the video —
  // never on hover, so touch and mouse behave the same way.
  const clearHideTimer = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  };
  const scheduleAutoHide = () => {
    clearHideTimer();
    hideTimeoutRef.current = setTimeout(() => setControlsHidden(true), AUTO_HIDE_DELAY_MS);
  };
  const revealControls = () => {
    clearHideTimer();
    setControlsHidden(false);
    if (videoRef.current && !videoRef.current.paused) {
      scheduleAutoHide();
    }
  };

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
    if (!video) return;

    if (playbackMode === "off" || !isActive) {
      video.pause();
      return;
    }

    if (playbackMode === "preload" || !autoPlay) return;

    const playPromise = video.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch(() => undefined);
    }
  }, [autoPlay, isActive, playbackMode, src]);

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
      scheduleAutoHide();
    };
    const handlePause = () => {
      setIsPlaying(false);
      clearHideTimer();
      setControlsHidden(false);
    };
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
    const video = videoRef.current;
    const onFullscreenChange = () => setIsFullscreen(document.fullscreenElement === videoRef.current);
    // iOS Safari never sets document.fullscreenElement for a <video>'s own
    // native fullscreen — it only fires these two events instead.
    const onWebkitBegin = () => setIsFullscreen(true);
    const onWebkitEnd = () => setIsFullscreen(false);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    video?.addEventListener("webkitbeginfullscreen", onWebkitBegin);
    video?.addEventListener("webkitendfullscreen", onWebkitEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      video?.removeEventListener("webkitbeginfullscreen", onWebkitBegin);
      video?.removeEventListener("webkitendfullscreen", onWebkitEnd);
    };
  }, []);

  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video || hasError) return;
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

  // Fullscreens the <video> element itself rather than our wrapper div, so
  // the browser treats it exactly like a native player: on Android Chrome
  // and desktop that means real orientation-aware fullscreen presentation
  // for a landscape clip "for free" (no ScreenOrientation.lock hack needed);
  // on iOS Safari — which doesn't support the Fullscreen API on arbitrary
  // elements at all — the <video> element's own webkitEnterFullscreen entry
  // point is what makes fullscreen work there in the first place. Our
  // custom overlay buttons live outside the video element, so they can't be
  // reached once it's fullscreened — the video's native controls take over
  // for the duration (see the `controls={isFullscreen}` prop below).
  const toggleFullscreen = () => {
    const video = videoRef.current as
      | (HTMLVideoElement & {
          webkitEnterFullscreen?: () => void;
          webkitExitFullscreen?: () => void;
          webkitDisplayingFullscreen?: boolean;
        })
      | null;
    if (!video) return;
    if (document.fullscreenElement === video) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (video.webkitDisplayingFullscreen) {
      video.webkitExitFullscreen?.();
      return;
    }
    if (video.requestFullscreen) {
      void video.requestFullscreen().catch(() => setIsExpandedFallback((prev) => !prev));
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
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
        hasError ? "is-error" : "",
        isExpandedFallback ? "is-expanded-fallback" : "",
        controlsHidden ? "is-controls-hidden" : "",
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
          controls={isFullscreen}
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
          onError={() => {
            setHasError(true);
            setIsBuffering(false);
            onPlaybackError?.();
          }}
        />

        <button
          type="button"
          className="vc-clip-player__tap-veil"
          onClick={() => {
            if (controlsHidden) {
              revealControls();
            } else {
              togglePlayback();
            }
          }}
          aria-label={isPlaying ? "Pausar" : "Reproducir"}
        />

        <div className="vc-clip-player__center-play" aria-hidden="true">
          <FiPlay />
        </div>

        <div className="vc-clip-player__buffer-overlay">
          <span className="vc-clip-player__spinner" aria-hidden="true" />
          <span className="vc-clip-player__buffer-label">{loadingLabel}</span>
        </div>

        <div className="vc-clip-player__error-overlay">
          <FiAlertTriangle className="vc-clip-player__error-icon" aria-hidden="true" />
          <span className="vc-clip-player__error-label">{errorLabel}</span>
          <button
            type="button"
            className="vc-clip-player__error-retry-btn"
            onClick={() => {
              const video = videoRef.current;
              setHasError(false);
              setIsBuffering(true);
              setLoadAttempt((attempt) => attempt + 1);
              video?.load();
            }}
          >
            {retryLabel}
          </button>
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

            {variant === "default" ? (
              <>
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
              </>
            ) : (
              // "feed" variant: no scrub track, so the play button needs its
              // own room to breathe instead of hugging the mute/fullscreen
              // buttons on the other end of a mostly-empty bar.
              <div className="vc-clip-player__controls-spacer" />
            )}

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
