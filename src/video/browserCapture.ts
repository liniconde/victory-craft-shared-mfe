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
    const mediaRecorder = (recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined));
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
    await video.play();

    // Safety net: if playback stalls (browser throttling, a backgrounded
    // tab pausing rAF/currentTime, a device silently refusing to advance)
    // fail clearly instead of hanging on "preparing clip" forever.
    const maxWaitMs = Math.max(20000, clipDurationSeconds * 1000 * 2.5);
    await new Promise<void>((resolve, reject) => {
      const stopAt = trimEndSeconds;
      const startedAt = trimStartSeconds;
      const totalSeconds = Math.max(0.001, stopAt - startedAt);
      const timeoutId = window.setTimeout(() => {
        reject(new Error("Timed out generating the video clip."));
      }, maxWaitMs);
      const tick = () => {
        options?.onProgress?.(
          Math.min(99, Math.max(0, Math.round(((video.currentTime - startedAt) / totalSeconds) * 100))),
        );
        if (video.currentTime >= stopAt || video.ended) {
          window.clearTimeout(timeoutId);
          options?.onProgress?.(100);
          resolve();
          return;
        }
        window.requestAnimationFrame(tick);
      };
      tick();
    });

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
