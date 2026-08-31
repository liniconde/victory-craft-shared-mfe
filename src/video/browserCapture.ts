import fixWebmDuration from "fix-webm-duration";
import { canCaptureVideoStreamInBrowser } from "./clipSelection";

type CaptureStreamVideo = HTMLVideoElement & {
  captureStream?: () => MediaStream;
  mozCaptureStream?: () => MediaStream;
};

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

const seekVideo = async (video: HTMLVideoElement, timeSeconds: number) => {
  video.currentTime = Math.max(0, timeSeconds);
  await waitForEvent(video, "seeked");
};

const getSupportedRecorderMimeType = () => {
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
};

// captureStream() records at the source video's native resolution, and
// MediaRecorder defaults to an unbounded encoder bitrate — a 720p source
// stays modest either way, but a 1080p/4K source would inherit that same
// resolution uncapped, unlike the byte-size guards elsewhere in this package
// (BROWSER_CAPTURE_MAX_BYTES_*) which only bound the SOURCE file being read,
// not this recorded output. 4 Mbps keeps even a ~30s clip under ~15MB
// regardless of source resolution.
const RECORDED_CLIP_VIDEO_BITS_PER_SECOND = 4_000_000;

// The tick loop below already had an absolute deadline (maxWaitMs), which
// does prevent a true infinite hang, but a genuinely slow-but-still-
// progressing capture (a long source over a mediocre connection) can still
// get killed early by that fixed multiplier, and the loop had no listener
// for the video's own "error" event, so a hard playback failure mid-capture
// was invisible until the deadline finally fired. Stall detection (no
// progress for N seconds) replaces the fixed deadline with a
// still-recovers-from-a-slow-but-working-connection check, matching the
// equivalent fix applied to the recruiters app's own local copy of this
// real-time capture logic (recordVideoHighlightFromUrl).
const CAPTURE_STALL_TIMEOUT_MS = 15000;

/**
 * Trims a local video File by playing it back in real time and re-encoding
 * the played segment with MediaRecorder. Works on essentially any format the
 * browser's <video> element can decode, but is slow (as slow as the clip's
 * own duration) and holds the source video's native decode buffers for that
 * whole time — see mp4FastTrim.ts for a lighter-weight path for MP4/MOV
 * sources that avoids both constraints.
 */
export const captureClipInBrowser = async (
  sourceFile: File,
  trimStartSeconds: number,
  trimEndSeconds: number,
  options?: { signal?: AbortSignal; onProgress?: (percent: number) => void },
): Promise<File> => {
  if (!canCaptureVideoStreamInBrowser()) {
    throw new Error("Browser video recording is not supported.");
  }

  const clipDurationSeconds = Math.max(0.01, trimEndSeconds - trimStartSeconds);
  const url = URL.createObjectURL(sourceFile);
  const video = document.createElement("video") as CaptureStreamVideo;
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  // Kept inside the viewport (top-left, near-invisible) rather than pushed
  // off-screen — mobile browsers (notably iOS Safari) throttle or silently
  // stall playback of <video> elements positioned outside the layout
  // viewport to save battery, which can hang forever waiting for
  // currentTime to advance during a real recording.
  video.style.position = "fixed";
  video.style.top = "0";
  video.style.left = "0";
  video.style.width = "2px";
  video.style.height = "2px";
  video.style.opacity = "0.01";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);

  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;

  try {
    if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    video.src = url;
    await waitForEvent(video, "loadedmetadata");
    await seekVideo(video, trimStartSeconds);

    stream = video.captureStream?.() || video.mozCaptureStream?.() || null;
    if (!stream) throw new Error("Video capture stream is not available.");

    const mimeType = getSupportedRecorderMimeType();
    const mediaRecorder = (recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : undefined),
      videoBitsPerSecond: RECORDED_CLIP_VIDEO_BITS_PER_SECOND,
    }));
    const chunks: BlobPart[] = [];

    const finished = new Promise<Blob>((resolve, reject) => {
      const abort = () => {
        if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
        reject(new DOMException("Aborted", "AbortError"));
      };

      options?.signal?.addEventListener("abort", abort, { once: true });
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorder.onerror = () => {
        options?.signal?.removeEventListener("abort", abort);
        reject(new Error("Could not record clip."));
      };
      mediaRecorder.onstop = () => {
        options?.signal?.removeEventListener("abort", abort);
        resolve(new Blob(chunks, { type: mediaRecorder.mimeType || "video/webm" }));
      };
    });

    mediaRecorder.start(250);

    // Safety net: if playback stalls (browser throttling, a backgrounded
    // tab pausing rAF/currentTime, a stream that goes silent mid-capture) or
    // the video errors out, fail clearly instead of hanging on "preparing
    // clip" forever.
    let rejectCapture: ((reason: unknown) => void) | null = null;
    const captureFailure = new Promise<never>((_, reject) => {
      rejectCapture = reject;
    });
    const fail = (reason: unknown) => {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
      rejectCapture?.(reason);
    };
    const handleVideoError = () => fail(new Error("Video failed while recording clip."));
    video.addEventListener("error", handleVideoError);

    try {
      await Promise.race([video.play(), captureFailure]);

      let lastAdvanceAt = performance.now();
      let lastCurrentTime = video.currentTime;

      await Promise.race([
        new Promise<void>((resolve) => {
          const stopAt = trimEndSeconds;
          const startedAt = trimStartSeconds;
          const totalSeconds = Math.max(0.001, stopAt - startedAt);
          const tick = () => {
            const now = performance.now();
            if (video.currentTime > lastCurrentTime) {
              lastCurrentTime = video.currentTime;
              lastAdvanceAt = now;
            } else if (now - lastAdvanceAt > CAPTURE_STALL_TIMEOUT_MS) {
              fail(new Error("Video stalled while recording clip."));
              return;
            }
            options?.onProgress?.(
              Math.min(99, Math.max(0, Math.round(((video.currentTime - startedAt) / totalSeconds) * 100))),
            );
            if (video.currentTime >= stopAt || video.ended) {
              options?.onProgress?.(100);
              resolve();
              return;
            }
            window.requestAnimationFrame(tick);
          };
          tick();
        }),
        captureFailure,
      ]);
    } finally {
      video.removeEventListener("error", handleVideoError);
    }

    video.pause();
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();

    const rawBlob = await finished;
    const isWebm = rawBlob.type.includes("webm");
    const extension = isWebm ? "webm" : "mp4";
    // MediaRecorder-produced webm has no duration in its header, which
    // leaves video.duration as NaN and breaks seeking/preview later. Patch
    // it in using the clip length we recorded.
    const blob = isWebm
      ? await fixWebmDuration(rawBlob, clipDurationSeconds * 1000, { logger: false })
      : rawBlob;
    const baseName = sourceFile.name.replace(/\.[^.]+$/, "").replace(/\s+/g, "-") || "video-clip";

    return new File([blob], `${baseName}-clip.${extension}`, {
      type: blob.type || "video/webm",
      lastModified: Date.now(),
    });
  } finally {
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stream?.getTracks().forEach((track) => track.stop());
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
};
