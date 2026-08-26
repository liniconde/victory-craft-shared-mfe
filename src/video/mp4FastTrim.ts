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
const BOX_HEADER_PROBE_BYTES = 16; // 4(size) + 4(type) + 8(largesize), the most any top-level box header needs.
const MAX_TOP_LEVEL_BOXES_TO_WALK = 64; // safety cap against a malformed/unexpected file shape.
// Boxes at/under this size are read in full (mp4box.js needs a small box's
// actual content, e.g. ftyp's compatible_brands list, not just its header).
// A box bigger than this is assumed to be `mdat` — only its header is read;
// mp4box.js's own stream.seek() skips the rest once it knows the box's
// declared size, so the media bytes are never fetched at all.
const HEAD_INLINE_BOX_MAX_BYTES = 8 * 1024 * 1024;

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

interface BoxChunkPlan {
  start: number;
  end: number;
}

/**
 * Walks top-level ISO-BMFF boxes sequentially from byte 0 — reading only
 * each box's small header (8 or 16 bytes) and jumping ahead by its declared
 * size — until it finds `targetType` or runs out of boxes/reads. Returns the
 * byte ranges mp4box.js actually needs to parse everything *up to* that box
 * (full content for small boxes like `ftyp`, header-only for huge ones like
 * `mdat`), plus the target box's own range.
 *
 * This is the only correct way to locate a box in a large file: box
 * boundaries can't be guessed from a fixed-size window at the head or tail,
 * since a window that doesn't land exactly on a box boundary hands mp4box.js
 * garbage (mid-box bytes) and it silently fails to parse anything. That
 * previously made `moov` unlocatable for any real multi-GB camera file,
 * where `mdat` occupies nearly the whole file right up to (or almost up to)
 * EOF and no fixed tail/head window happens to align with `moov`'s actual
 * start — see [[project_video_fast_trim]]. A handful of small reads is
 * enough here since real files have only a few top-level boxes
 * (ftyp/free/wide/mdat/moov, in some order), and `mdat`'s multi-GB body is
 * never fetched — only its 8/16-byte header, which is all mp4box.js's own
 * seek-to-skip logic needs.
 */
const planMoovChunks = async (
  file: File,
  targetType: string,
): Promise<{ chunks: BoxChunkPlan[]; target: BoxChunkPlan } | null> => {
  const chunks: BoxChunkPlan[] = [];
  let offset = 0;
  for (let i = 0; i < MAX_TOP_LEVEL_BOXES_TO_WALK && offset < file.size; i++) {
    const headerEnd = Math.min(file.size, offset + BOX_HEADER_PROBE_BYTES);
    const headerBuffer = await file.slice(offset, headerEnd).arrayBuffer();
    if (headerBuffer.byteLength < 8) return null; // not enough bytes left for even a minimal header.

    const view = new DataView(headerBuffer);
    const size32 = view.getUint32(0);
    const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));

    let boxSize: number;
    let headerSize = 8;
    if (size32 === 1) {
      // Extended (64-bit) size follows the 8-byte base header.
      if (headerBuffer.byteLength < 16) return null;
      boxSize = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      headerSize = 16;
    } else if (size32 === 0) {
      boxSize = file.size - offset; // box extends to EOF (only valid for the last box).
    } else {
      boxSize = size32;
    }
    if (!Number.isFinite(boxSize) || boxSize <= 0) return null; // malformed; avoid an infinite loop.

    if (type === targetType) {
      return { chunks, target: { start: offset, end: offset + boxSize } };
    }

    chunks.push(
      boxSize <= HEAD_INLINE_BOX_MAX_BYTES
        ? { start: offset, end: offset + boxSize } // full content — mp4box.js needs it (e.g. ftyp's brand list).
        : { start: offset, end: offset + headerSize }, // header only — mp4box.js skips the rest via seek().
    );
    offset += boxSize;
  }
  return null;
};

// A pathologically high per-track sample count — e.g. uncompressed/LPCM
// audio, which stores one MP4 "sample" per raw PCM frame (tens of millions
// for a multi-minute clip, vs. tens of thousands for a normal AAC track or
// video track) — makes mp4box.js's own per-sample list construction
// (buildSampleLists(), an unavoidable synchronous step inside its own
// appendBuffer()/parse() — it runs *before* onReady fires, so there's no
// hook to react and bail out after the fact) take minutes and allocate
// millions of JS objects. No real video/audio track needs anywhere near
// this many samples, so it's checked for and rejected before mp4box.js
// ever sees the moov content at all.
const MAX_REASONABLE_SAMPLE_COUNT = 2_000_000;

const readBoxHeader = (
  view: DataView,
  offset: number,
  end: number,
): { type: string; size: number; headerSize: number } | null => {
  if (offset + 8 > end) return null;
  const size32 = view.getUint32(offset);
  const type = String.fromCharCode(
    view.getUint8(offset + 4),
    view.getUint8(offset + 5),
    view.getUint8(offset + 6),
    view.getUint8(offset + 7),
  );
  let size: number;
  let headerSize = 8;
  if (size32 === 1) {
    if (offset + 16 > end) return null;
    size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
    headerSize = 16;
  } else if (size32 === 0) {
    size = end - offset;
  } else {
    size = size32;
  }
  if (!Number.isFinite(size) || size <= 0 || offset + size > end) return null;
  return { type, size, headerSize };
};

const findFirstChildBox = (view: DataView, start: number, end: number, type: string): number | null => {
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (!header) return null;
    if (header.type === type) return offset;
    offset += header.size;
  }
  return null;
};

const findChildBoxes = (view: DataView, start: number, end: number, type: string): number[] => {
  const starts: number[] = [];
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(view, offset, end);
    if (!header) break;
    if (header.type === type) starts.push(offset);
    offset += header.size;
  }
  return starts;
};

const TRACK_TYPE_VIDEO = "vide";

interface TrakInfo {
  start: number;
  end: number;
  headerSize: number;
  handlerType: string | null;
  sampleCount: number | null;
}

/**
 * Independently reads one `trak` box's handler type (`vide`/`soun`/...) and
 * declared sample count — no mp4box.js involved, just enough of the box
 * tree to make the video-vs-audio, reasonable-vs-degenerate call below.
 * Missing/unrecognized sub-boxes (e.g. a `stz2` compact size table instead
 * of `stsz`) just leave the corresponding field `null`, which callers treat
 * as "can't tell, assume fine" — this is a defensive fast-path check, not a
 * correctness requirement.
 */
const inspectTrak = (view: DataView, trakStart: number, trakHeader: { size: number; headerSize: number }): TrakInfo => {
  const trakEnd = trakStart + trakHeader.size;
  const info: TrakInfo = { start: trakStart, end: trakEnd, headerSize: trakHeader.headerSize, handlerType: null, sampleCount: null };

  const mdiaStart = findFirstChildBox(view, trakStart + trakHeader.headerSize, trakEnd, "mdia");
  if (mdiaStart === null) return info;
  const mdiaHeader = readBoxHeader(view, mdiaStart, trakEnd);
  if (!mdiaHeader) return info;
  const mdiaEnd = mdiaStart + mdiaHeader.size;

  const hdlrStart = findFirstChildBox(view, mdiaStart + mdiaHeader.headerSize, mdiaEnd, "hdlr");
  if (hdlrStart !== null) {
    const hdlrHeader = readBoxHeader(view, hdlrStart, mdiaEnd);
    // hdlr: box header + version/flags (4) + pre_defined (4) + handler_type (4).
    const handlerTypeOffset = hdlrHeader ? hdlrStart + hdlrHeader.headerSize + 4 + 4 : Infinity;
    if (hdlrHeader && handlerTypeOffset + 4 <= view.byteLength) {
      info.handlerType = String.fromCharCode(
        view.getUint8(handlerTypeOffset),
        view.getUint8(handlerTypeOffset + 1),
        view.getUint8(handlerTypeOffset + 2),
        view.getUint8(handlerTypeOffset + 3),
      );
    }
  }

  const minfStart = findFirstChildBox(view, mdiaStart + mdiaHeader.headerSize, mdiaEnd, "minf");
  if (minfStart === null) return info;
  const minfHeader = readBoxHeader(view, minfStart, mdiaEnd);
  if (!minfHeader) return info;

  const stblStart = findFirstChildBox(view, minfStart + minfHeader.headerSize, minfStart + minfHeader.size, "stbl");
  if (stblStart === null) return info;
  const stblHeader = readBoxHeader(view, stblStart, minfStart + minfHeader.size);
  if (!stblHeader) return info;

  const stszStart = findFirstChildBox(view, stblStart + stblHeader.headerSize, stblStart + stblHeader.size, "stsz");
  if (stszStart === null) return info;
  const stszHeader = readBoxHeader(view, stszStart, stblStart + stblHeader.size);
  if (!stszHeader) return info;
  // stsz: box header + version/flags (4) + sample_size (4) + sample_count (4).
  const sampleCountOffset = stszStart + stszHeader.headerSize + 4 + 4;
  if (sampleCountOffset + 4 <= view.byteLength) info.sampleCount = view.getUint32(sampleCountOffset);
  return info;
};

const TRACK_TYPE_AUDIO = "soun";

const isDegenerateTrak = (info: TrakInfo): boolean =>
  info.sampleCount !== null && info.sampleCount > MAX_REASONABLE_SAMPLE_COUNT;

/**
 * Removes every track from a raw moov buffer except the video track and
 * (if present and not degenerate) the audio track — before any of it is
 * ever handed to mp4box.js. Two independent reasons this matters:
 *
 *  1. A pathological sample count (see MAX_REASONABLE_SAMPLE_COUNT) — e.g.
 *     uncompressed/LPCM audio, one MP4 "sample" per raw PCM frame, tens of
 *     millions for a multi-minute clip — makes mp4box.js's own per-sample
 *     list construction (an unavoidable synchronous step inside its own
 *     appendBuffer()/parse(), with no hook to skip a single track) take
 *     minutes. Real iPhone recordings were observed hitting this on their
 *     audio track. Losing that audio is an acceptable trade for a highlight
 *     clip that only needs to be watchable, not for one that needs to
 *     re-encode in real time just to carry sound nobody asked to keep.
 *  2. Any other leftover track (timed-metadata/"meta" tracks — HDR gain
 *     map data, camera telemetry — hint tracks, subtitles, ...) never gets
 *     segmented or written into the output (only the video/audio tracks in
 *     `ranges`, built downstream from this same trimmed moov, get that),
 *     so mp4box.js's own init-segment writer ends up describing tracks
 *     that have zero actual sample data in the output — which real iPhone
 *     ProRes/Log recordings were observed producing, and which made the
 *     resulting clip fail to decode in the browser. Dropping them here
 *     means the init segment only ever describes tracks we actually wrote.
 *
 * The video track is *never* removed, even if it were (hypothetically)
 * also pathological — there'd be nothing useful left to extract without
 * it, so that case still falls through to the "still unreasonable" check
 * in the caller and bails to the real-time fallback.
 *
 * Removing a whole `trak` subtree doesn't corrupt the tracks that remain:
 * sample offsets (`stco`/`co64`) are absolute *file* positions (into
 * `mdat`, elsewhere in the file), not positions relative to other boxes
 * inside `moov` — only `moov`'s own declared size needs patching after the
 * cut.
 */
const pruneMoovTracks = (moovBytes: ArrayBuffer): ArrayBuffer => {
  const view = new DataView(moovBytes);
  const total = moovBytes.byteLength;
  const moovHeader = readBoxHeader(view, 0, total);
  if (!moovHeader) return moovBytes;

  const toRemove: Array<{ start: number; end: number }> = [];
  for (const trakStart of findChildBoxes(view, moovHeader.headerSize, moovHeader.size, "trak")) {
    const trakHeader = readBoxHeader(view, trakStart, moovHeader.size);
    if (!trakHeader) continue;
    const info = inspectTrak(view, trakStart, trakHeader);
    const keep =
      info.handlerType === TRACK_TYPE_VIDEO || (info.handlerType === TRACK_TYPE_AUDIO && !isDegenerateTrak(info));
    if (!keep) toRemove.push({ start: info.start, end: info.end });
  }
  if (toRemove.length === 0) return moovBytes;

  const removedBytes = toRemove.reduce((sum, r) => sum + (r.end - r.start), 0);
  const out = new Uint8Array(total - removedBytes);
  let writeOffset = 0;
  let readOffset = 0;
  for (const range of toRemove) {
    out.set(new Uint8Array(moovBytes, readOffset, range.start - readOffset), writeOffset);
    writeOffset += range.start - readOffset;
    readOffset = range.end;
  }
  out.set(new Uint8Array(moovBytes, readOffset, total - readOffset), writeOffset);

  // Patch moov's own declared size to match the new (smaller) total.
  const outView = new DataView(out.buffer);
  if (moovHeader.headerSize === 16) {
    const newSize = BigInt(out.byteLength);
    outView.setUint32(8, Number(newSize >> 32n));
    outView.setUint32(12, Number(newSize & 0xffffffffn));
  } else {
    outView.setUint32(0, out.byteLength);
  }

  return out.buffer;
};

/**
 * Final safety net after stripping: if *any* remaining track (practically,
 * this can now only be the video track, or a non-video track that wasn't
 * degenerate to begin with) is still pathological, there's nothing safe
 * left to hand mp4box.js — bail out entirely rather than risk the same
 * multi-minute hang this whole check exists to avoid.
 */
const hasReasonableSampleCounts = (moovBytes: ArrayBuffer): boolean => {
  const view = new DataView(moovBytes);
  const total = moovBytes.byteLength;
  const moovHeader = readBoxHeader(view, 0, total);
  if (!moovHeader) return true;
  for (const trakStart of findChildBoxes(view, moovHeader.headerSize, moovHeader.size, "trak")) {
    const trakHeader = readBoxHeader(view, trakStart, moovHeader.size);
    if (!trakHeader) continue;
    if (isDegenerateTrak(inspectTrak(view, trakStart, trakHeader))) return false;
  }
  return true;
};

/**
 * Feeds `plan`'s chunks into a fresh ISOFile in order, followed by the
 * target box's own bytes. mp4box.js requires the *first* buffer it ever
 * sees to have `fileStart === 0` (see MultiBufferStream.initialized()), so
 * this only works when `planMoovChunks` found the target starting from
 * byte 0 — which it always does, by construction.
 */
const tryLocateFromPlan = async (
  file: File,
  plan: { chunks: BoxChunkPlan[]; target: BoxChunkPlan },
): Promise<{ isoFile: ISOFile; info: Movie } | null> => {
  const isoFile = createFile(false); // keepMdatData=false: index only, discard media bytes.
  let info: Movie | null = null;
  isoFile.onReady = (movieInfo) => {
    info = movieInfo;
  };
  isoFile.onError = () => {
    /* surfaced via the null return below */
  };

  try {
    for (const chunk of plan.chunks) {
      const bytes = await file.slice(chunk.start, chunk.end).arrayBuffer();
      isoFile.appendBuffer(toMp4BoxBuffer(bytes, chunk.start));
    }
    const moovBytesRaw = await file.slice(plan.target.start, plan.target.end).arrayBuffer();
    const moovBytes = pruneMoovTracks(moovBytesRaw);
    if (!hasReasonableSampleCounts(moovBytes)) return null;
    isoFile.appendBuffer(toMp4BoxBuffer(moovBytes, plan.target.start));
  } catch {
    return null;
  }
  return info ? { isoFile, info } : null;
};

const locateMoov = async (file: File): Promise<{ isoFile: ISOFile; info: Movie }> => {
  const plan = await planMoovChunks(file, "moov");
  if (plan) {
    const result = await tryLocateFromPlan(file, plan);
    if (result) return result;
  }

  // Fallback: the old fixed-window probes. Cheap safety net for shapes the
  // sequential walk doesn't expect (e.g. moov nested somewhere unusual) —
  // rarely exercised now that the walk above handles the common case
  // correctly regardless of file size.
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

/**
 * Verifies the fast-path output actually plays back correctly — normally a
 * genuine safety net (catches real muxing bugs), but it can't tell "this
 * device can't decode this codec at all" apart from "this file is broken":
 * both surface as the same `<video>` error event. Android's WebView (used
 * by PWA-wrapped installs, e.g. via PWABuilder) commonly has no HEVC
 * decoder — hardware support is device-dependent and Chromium ships no
 * software fallback for licensing reasons — while the *exact same* output
 * decodes fine on a desktop browser with HEVC support, since the fast path
 * never re-encodes: the output carries the source's original codec
 * unchanged. Failing the whole fast path (and paying for a real-time
 * re-encode fallback instead) over a device limitation we already know
 * about, for a file whose container structure we built ourselves from
 * verified sample-table math, is the wrong trade — so `canPlayType()` is
 * checked *first*: only if this device claims it CAN play the codec do we
 * hold the decode check to its normal strict standard; if it can't, we
 * skip straight to trusting the container-level correctness instead.
 */
const validateOutput = (blob: Blob, expectedDurationSeconds: number, videoCodec: string | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    const probe = document.createElement("video");
    if (videoCodec && !probe.canPlayType(`video/mp4; codecs="${videoCodec}"`)) {
      resolve();
      return;
    }

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
    await validateOutput(outputBlob, playableDurationSeconds, videoTrack.codec);

    const baseName = sourceFile.name.replace(/\.[^.]+$/, "").replace(/\s+/g, "-") || "video-clip";
    return new File([outputBlob], `${baseName}-clip.mp4`, { type: "video/mp4", lastModified: Date.now() });
  } catch (error) {
    if (error instanceof Mp4FastTrimUnavailableError) throw error;
    throw new Mp4FastTrimUnavailableError("Fast MP4 trim failed unexpectedly.", { cause: error });
  }
};
