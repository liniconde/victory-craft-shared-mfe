import { createFile, MP4BoxBuffer, type ISOFile, type Movie } from "mp4box";

/**
 * Container-level ("stream copy") MP4/MOV trimming: no decode, no
 * re-encode, no real-time playback wait. Instead of the browserCapture.ts
 * approach (play the source in real time and re-record it), this reads only
 * the MP4 index (the `moov` box — kilobytes to a few MB, not the file's
 * media data) to find keyframe-aligned sample boundaries, slices out just
 * the raw compressed bytes for the requested time range with
 * `Blob.slice()`, and re-muxes them into a small self-contained fragmented
 * MP4 using mp4box.js's own segmentation writer. Memory/IO cost scales with
 * the *output clip size*, not the source file size — a 2GB source costs the
 * same either way to trim a 30s clip out of.
 *
 * Trade-offs: cuts snap to the nearest keyframe (typically within 0.5-2s of
 * the requested boundary for normal camera footage), not frame-exact — fine
 * for a highlight/arena clip, not for professional editing. Samples also
 * keep their original timestamps from the source file rather than being
 * rebased to a zero-based clip timeline, so the output's `duration`
 * metadata reflects ~trimEndSeconds (the source file's timeline), not the
 * actual clip length — playback itself is correct either way (starts at
 * the right frame, right content), but anything reading the file's own
 * duration atom (rather than the app's own selection state) will see a
 * number larger than the real clip length. See the comment above
 * `playableDurationSeconds` in trimMp4Fast for what a proper fix would
 * need and why a first attempt at it was reverted.
 *
 * Only works for the ISO-BMFF family (MP4, MOV/QuickTime) — see
 * containerFormat.ts. Any failure at any stage throws
 * Mp4FastTrimUnavailableError so the caller can fall back to
 * browserCapture.ts, which is format-agnostic.
 */

export class Mp4FastTrimUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "Mp4FastTrimUnavailableError";
  }
}

const TAIL_PROBE_SIZES_BYTES = [4, 16, 64].map((mb) => mb * 1024 * 1024);
const HEAD_PROBE_SIZES_BYTES = [2, 8, 32].map((mb) => mb * 1024 * 1024);
const EXTRACTION_CHUNK_BYTES = 4 * 1024 * 1024;
const SEGMENT_SAMPLES_PER_TRACK = 60;
const VALIDATION_DURATION_TOLERANCE_SECONDS = 3;

const toMp4BoxBuffer = (arrayBuffer: ArrayBuffer, fileStart: number) =>
  MP4BoxBuffer.fromArrayBuffer(arrayBuffer, fileStart);

/**
 * Feeds `file` bytes starting at `fileStart` into a fresh ISOFile instance
 * until `onReady` fires (moov fully parsed) or `maxBytes` have been fed.
 * Returns the ready instance + info, or null if moov wasn't found in range.
 */
const tryLocateMoov = async (
  file: File,
  fileStart: number,
  maxBytes: number,
): Promise<{ isoFile: ISOFile; info: Movie } | null> => {
  const isoFile = createFile(false); // keepMdatData=false: index only, discard media bytes.
  let info: Movie | null = null;
  isoFile.onReady = (movieInfo) => {
    info = movieInfo;
  };
  isoFile.onError = () => {
    /* surfaced via the null return below */
  };

  const end = Math.min(file.size, fileStart + maxBytes);
  const slice = await file.slice(fileStart, end).arrayBuffer();
  const buffer = toMp4BoxBuffer(slice, fileStart);
  try {
    isoFile.appendBuffer(buffer);
  } catch {
    return null;
  }
  return info ? { isoFile, info } : null;
};

const locateMoov = async (file: File): Promise<{ isoFile: ISOFile; info: Movie }> => {
  for (const size of TAIL_PROBE_SIZES_BYTES) {
    const result = await tryLocateMoov(file, Math.max(0, file.size - size), size);
    if (result) return result;
  }
  for (const size of HEAD_PROBE_SIZES_BYTES) {
    const result = await tryLocateMoov(file, 0, size);
    if (result) return result;
  }
  throw new Mp4FastTrimUnavailableError("Could not locate the moov box near the start or end of the file.");
};

interface TrackRange {
  trackId: number;
  targetSampleIndex: number;
}

/**
 * Reads each track's sample table (pure moov metadata — offsets, sizes,
 * timing, keyframe flags; no mdat/media bytes needed) to find, for the
 * requested [trimStartSeconds, trimEndSeconds] window:
 *  - the video track's nearest keyframe at/before trimStartSeconds (audio
 *    doesn't need keyframe alignment — every sample is independently
 *    decodable — so it's aligned to the *same wall-clock time* instead, to
 *    stay in sync with the snapped video start),
 *  - the first sample of each track whose end time reaches trimEndSeconds.
 */
const planTrackRanges = (isoFile: ISOFile, videoTrackId: number, audioTrackId: number | null, trimStartSeconds: number, trimEndSeconds: number) => {
  const videoSamples = isoFile.getTrackSamplesInfo(videoTrackId);
  if (videoSamples.length === 0) throw new Mp4FastTrimUnavailableError("Video track has no samples.");

  let startSampleIndex = 0;
  for (let i = 0; i < videoSamples.length; i++) {
    const sample = videoSamples[i];
    if (sample.cts / sample.timescale > trimStartSeconds) break;
    if (sample.is_sync) startSampleIndex = i;
  }
  const snappedStartSeconds = videoSamples[startSampleIndex].cts / videoSamples[startSampleIndex].timescale;

  const findTargetIndex = (samples: typeof videoSamples) => {
    const index = samples.findIndex((sample) => (sample.cts + sample.duration) / sample.timescale >= trimEndSeconds);
    return index === -1 ? samples.length - 1 : index;
  };

  const ranges: TrackRange[] = [
    { trackId: videoTrackId, targetSampleIndex: findTargetIndex(videoSamples) },
  ];

  if (audioTrackId !== null) {
    const audioSamples = isoFile.getTrackSamplesInfo(audioTrackId);
    if (audioSamples.length > 0) {
      ranges.push({ trackId: audioTrackId, targetSampleIndex: findTargetIndex(audioSamples) });
    }
  }

  return { ranges, snappedStartSeconds };
};

interface TrackSegmentState {
  buffers: ArrayBuffer[];
  /** Sample index (exclusive) processed so far, per onSegment's `nextSample`. */
  nextSample: number;
  /** Sample index we need `nextSample` to reach before this track is "done". */
  targetSampleIndex: number;
}

/**
 * Feeds `file` into a *fresh* ISOFile (never the instance used to locate
 * moov/plan ranges — re-feeding a region that instance already consumed
 * during probing produced overlapping/inconsistent state in testing),
 * seeking to `snappedStartSeconds` to find where to resume from, then
 * collecting fragmented-MP4 segments via mp4box's segmentation API until
 * every track has actually emitted segments covering its
 * `targetSampleIndex` (tracked via onSegment's own `nextSample` progress
 * marker) or `maxBytesToRead` is exceeded.
 *
 * Returns the single combined init segment plus each track's fragment
 * buffers, in the order they must be concatenated.
 */
const extractFragments = async (
  file: File,
  isoFile: ISOFile,
  ranges: TrackRange[],
  snappedStartSeconds: number,
  maxBytesToRead: number,
  clipDurationSeconds: number,
  movieTimescale: number,
): Promise<{ initSegment: ArrayBuffer; fragmentsByTrack: Map<number, ArrayBuffer[]> }> => {
  const states = new Map<number, TrackSegmentState>();
  for (const range of ranges) {
    states.set(range.trackId, {
      buffers: [],
      nextSample: 0,
      targetSampleIndex: range.targetSampleIndex,
    });
  }

  isoFile.onSegment = (id, _user, buffer, nextSample) => {
    const state = states.get(id);
    if (!state) return;
    // A single appendBuffer() call can synchronously fire onSegment many
    // times if the chunk we fed contains more samples than needed (e.g. a
    // small source file where one EXTRACTION_CHUNK_BYTES read covers the
    // whole remaining file) — allCovered() is only checked *between*
    // appendBuffer() calls, so without this guard we'd keep accumulating
    // segments well past the requested range within that single call.
    if (state.nextSample > state.targetSampleIndex) return;
    state.buffers.push(buffer);
    state.nextSample = nextSample;
  };

  for (const range of ranges) {
    isoFile.setSegmentOptions(range.trackId, range.trackId, {
      nbSamples: SEGMENT_SAMPLES_PER_TRACK,
      rapAlignement: true,
    });
  }

  // initializeSegmentation() only writes a duration hint (`mehd`) into the
  // init segment when the *original* moov already has an `mvex` box with a
  // fragment_duration — true for an already-fragmented source, never true
  // for a normal camera-recorded MP4/MOV. Without it, `<video>.duration`
  // comes back NaN in the browser. Inject the value it reads
  // (this.moov.mvex.mehd.fragment_duration) directly — a plain duck-typed
  // object is enough since it's only ever read, never treated as a real
  // box instance.
  (isoFile.moov as unknown as { mvex: { mehd: { fragment_duration: number }; trexs: unknown[] } }).mvex = {
    mehd: { fragment_duration: Math.round(clipDurationSeconds * movieTimescale) },
    trexs: [],
  };

  const initSegmentation = isoFile.initializeSegmentation();
  isoFile.start();

  // seek() isn't just a byte-offset calculator — calling it primes this
  // ISOFile's internal cursor to expect the next appendBuffer() to resume
  // from that point. It must come *after* start()/initializeSegmentation()
  // — resetTables() (run once, internally, the first time
  // initializeSegmentation() is called) clears the sample tables seek()
  // relies on to translate a target time into a byte offset; calling seek()
  // beforehand silently produced an offset the parser could never actually
  // resume from (appendBuffer completed but onSegment never fired).
  const { offset: startOffset } = isoFile.seek(snappedStartSeconds, true);

  let offset = startOffset;
  let bytesRead = 0;
  const allCovered = () =>
    Array.from(states.values()).every((state) => state.nextSample > state.targetSampleIndex);

  while (offset < file.size && bytesRead < maxBytesToRead) {
    const end = Math.min(file.size, offset + EXTRACTION_CHUNK_BYTES);
    const slice = await file.slice(offset, end).arrayBuffer();
    const buffer = toMp4BoxBuffer(slice, offset);
    bytesRead += slice.byteLength;
    const isLast = end >= file.size;
    isoFile.appendBuffer(buffer, isLast);
    offset = end;
    if (allCovered() || isLast) break;
  }

  // flush() (not just stop()) is required to finalize the last in-progress
  // segment — without it, onSegment never fires with `last: true` for a
  // segment we stopped short of nbSamples on (which is the common case,
  // since we deliberately stop as soon as the requested range is covered
  // rather than waiting for a full nbSamples-sized batch), leaving the
  // output's fragment duration hint incomplete and `<video>.duration` NaN.
  isoFile.flush();
  isoFile.stop();

  if (!allCovered()) {
    throw new Mp4FastTrimUnavailableError(
      "Did not receive enough sample data to cover the requested clip range.",
    );
  }

  const fragmentsByTrack = new Map<number, ArrayBuffer[]>();
  for (const [id, state] of states) fragmentsByTrack.set(id, state.buffers);
  return { initSegment: initSegmentation.buffer, fragmentsByTrack };
};

const validateOutput = (blob: Blob, expectedDurationSeconds: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    const cleanup = () => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Mp4FastTrimUnavailableError("Fast-path output did not become playable in time."));
    }, 8000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeoutId);
      const durationOk =
        Number.isFinite(video.duration) &&
        Math.abs(video.duration - expectedDurationSeconds) <= VALIDATION_DURATION_TOLERANCE_SECONDS;
      cleanup();
      if (durationOk) resolve();
      else reject(new Mp4FastTrimUnavailableError(`Fast-path output duration looked wrong (${video.duration}s).`));
    };
    video.onerror = () => {
      window.clearTimeout(timeoutId);
      cleanup();
      reject(new Mp4FastTrimUnavailableError("Fast-path output failed to decode."));
    };
    video.src = url;
  });

export const trimMp4Fast = async (
  sourceFile: File,
  trimStartSeconds: number,
  trimEndSeconds: number,
): Promise<File> => {
  try {
    // Two ISOFile instances, deliberately: one to locate moov and read
    // sample tables (read-only analysis), a second, fresh one to actually
    // feed and extract from. Reusing one instance for both — seeking into
    // and re-appending data that the same instance already consumed while
    // probing for moov — produced inconsistent/overlapping state in
    // testing, especially on files small enough that the moov probe alone
    // already covers the whole file.
    const { isoFile: analysisFile, info } = await locateMoov(sourceFile);

    const videoTrack = info.videoTracks[0];
    if (!videoTrack) throw new Mp4FastTrimUnavailableError("No video track found.");
    const audioTrack = info.audioTracks[0] ?? null;

    const { ranges, snappedStartSeconds } = planTrackRanges(
      analysisFile,
      videoTrack.id,
      audioTrack ? audioTrack.id : null,
      trimStartSeconds,
      trimEndSeconds,
    );
    // The extracted samples keep their *original* cts/dts from the source
    // file — this fast path doesn't rebase timestamps to a zero-based clip
    // timeline. A rebase is possible in principle (mp4box's internal
    // `trak.first_dts`, normally unset for a parsed-not-authored file,
    // feeds directly into each fragment's tfdt base decode time) but a
    // first attempt at it either produced a mismatched, wrapped-around
    // duration (when computed from a separate sample-table scan than the
    // one seek() actually used) or a duration that still didn't line up
    // exactly with the request even once that mismatch was fixed — not
    // safe to ship without more investigation. Browsers report this
    // output's `duration` as ~trimEndSeconds (confirmed across every
    // tested range), not trimEndSeconds - snappedStartSeconds, so that's
    // what we validate against. The clip *plays* the correct footage from
    // the correct starting frame either way; only the duration metadata
    // reflects the source file's timeline rather than a proper zero-based
    // clip length.
    const playableDurationSeconds = Math.max(0.01, trimEndSeconds);

    const requestedClipSeconds = Math.max(0.01, trimEndSeconds - trimStartSeconds);
    const estimatedClipBytes =
      info.duration > 0 ? (requestedClipSeconds / (info.duration / info.timescale)) * sourceFile.size : 0;
    const maxBytesToRead = Math.max(32 * 1024 * 1024, estimatedClipBytes * 4);

    const { isoFile: extractionFile } = await locateMoov(sourceFile);
    const { initSegment, fragmentsByTrack } = await extractFragments(
      sourceFile,
      extractionFile,
      ranges,
      snappedStartSeconds,
      maxBytesToRead,
      playableDurationSeconds,
      info.timescale,
    );

    const parts: BlobPart[] = [initSegment];
    for (const range of ranges) {
      for (const buffer of fragmentsByTrack.get(range.trackId) ?? []) parts.push(buffer);
    }

    const outputBlob = new Blob(parts, { type: "video/mp4" });
    await validateOutput(outputBlob, playableDurationSeconds);

    const baseName = sourceFile.name.replace(/\.[^.]+$/, "").replace(/\s+/g, "-") || "video-clip";
    return new File([outputBlob], `${baseName}-clip.mp4`, { type: "video/mp4", lastModified: Date.now() });
  } catch (error) {
    if (error instanceof Mp4FastTrimUnavailableError) throw error;
    throw new Mp4FastTrimUnavailableError("Fast MP4 trim failed unexpectedly.", { cause: error });
  }
};
