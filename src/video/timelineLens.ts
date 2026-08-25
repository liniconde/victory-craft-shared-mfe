/**
 * Non-linear time <-> track-percent mapping ("lens") used by HighlightRangeSelector.
 *
 * On long videos a purely linear mapping makes the max clip window collapse to a
 * couple of pixels, so start/end handles become nearly impossible to grab
 * independently. This lens keeps the mapping linear far from the current selection,
 * but expands a fixed-width window of context around it (FOCUS_SPAN_SECONDS) to a
 * guaranteed share of the track's pixel width (FOCUS_TRACK_PERCENT), borrowing that
 * width from the rest of the timeline where drag precision doesn't matter.
 */

export const FOCUS_SPAN_SECONDS = 90;
const FOCUS_TRACK_PERCENT = 55;
/** How many multiples of the current selection width the lens keeps as
 * padding around it, when that's wider than FOCUS_SPAN_SECONDS — a caller
 * with no max clip length (a plain "trim this range" selector, as opposed
 * to a capped highlight) can have a selection much wider than 90s, and a
 * fixed-width lens centered on it would no longer contain both handles. */
const FOCUS_SPAN_SELECTION_MULTIPLIER = 3;

export interface LensWindow {
  focusStart: number;
  focusEnd: number;
}

export const computeLensWindow = (
  duration: number,
  start: number,
  end: number,
  focusSpanSeconds: number = FOCUS_SPAN_SECONDS,
): LensWindow => {
  const span = Math.max(focusSpanSeconds, (end - start) * FOCUS_SPAN_SELECTION_MULTIPLIER);
  if (duration <= span) {
    return { focusStart: 0, focusEnd: duration };
  }

  const center = (start + end) / 2;
  let focusStart = center - span / 2;
  let focusEnd = center + span / 2;

  if (focusStart < 0) {
    focusEnd += -focusStart;
    focusStart = 0;
  }
  if (focusEnd > duration) {
    focusStart -= focusEnd - duration;
    focusEnd = duration;
  }

  focusStart = Math.max(0, focusStart);
  focusEnd = Math.min(duration, Math.max(focusStart, focusEnd));
  return { focusStart, focusEnd };
};

const outerPadding = (duration: number, lens: LensWindow) => {
  const leftOuter = lens.focusStart;
  const rightOuter = duration - lens.focusEnd;
  const outerTotal = leftOuter + rightOuter;
  const outerPercent = 100 - FOCUS_TRACK_PERCENT;
  const leftPad = outerTotal > 0 ? (leftOuter / outerTotal) * outerPercent : 0;
  const rightPad = outerPercent - leftPad;
  return { leftOuter, rightOuter, leftPad, rightPad };
};

export const timeToTrackPercent = (time: number, duration: number, lens: LensWindow): number => {
  if (duration <= 0) return 0;
  const { focusStart, focusEnd } = lens;
  if (focusEnd <= focusStart) return (time / duration) * 100;

  const { leftOuter, rightOuter, leftPad, rightPad } = outerPadding(duration, lens);

  if (time <= focusStart) {
    return leftOuter > 0 ? (time / leftOuter) * leftPad : 0;
  }
  if (time >= focusEnd) {
    return rightOuter > 0 ? 100 - rightPad + ((time - focusEnd) / rightOuter) * rightPad : 100;
  }
  return leftPad + ((time - focusStart) / (focusEnd - focusStart)) * FOCUS_TRACK_PERCENT;
};

export const trackPercentToTime = (percent: number, duration: number, lens: LensWindow): number => {
  if (duration <= 0) return 0;
  const { focusStart, focusEnd } = lens;
  if (focusEnd <= focusStart) return (percent / 100) * duration;

  const { leftOuter, rightOuter, leftPad, rightPad } = outerPadding(duration, lens);

  if (percent <= leftPad) {
    return leftPad > 0 ? (percent / leftPad) * leftOuter : 0;
  }
  if (percent >= 100 - rightPad) {
    return rightPad > 0 ? focusEnd + ((percent - (100 - rightPad)) / rightPad) * rightOuter : focusEnd;
  }
  return focusStart + ((percent - leftPad) / FOCUS_TRACK_PERCENT) * (focusEnd - focusStart);
};
