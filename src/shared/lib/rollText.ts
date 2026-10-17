/**
 * Rolling label transitions — a port of Scritto's `<scritto-text>` roll
 * (scrit.to/playground) for chip labels.
 *
 * When a label changes, the characters it shares with the old value at either
 * end stay put (the trailing run slides to its new place), while the changed
 * middle rolls: old glyphs rise out and shrink away as new ones rise in from
 * below, each softened by a 0.1em blur and 2° tilt while in motion, staggered
 * left to right, and the label's width glides between the two. The glyphs
 * ease out without Scritto's spring overshoot so the label lands dead still.
 */

/** Scritto's default per-glyph roll. */
export const ROLL_MS = 550;
/** Scritto's `cubic-bezier(.22,1,.36,1)` — the same curve as `--motion-ease-out`. */
export const ROLL_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
/**
 * Width and the shared trailing run settle on a short resize clock, so
 * whatever follows the label reaches its final place early and never moves
 * again while the glyphs finish rolling.
 */
export const RESIZE_MS = 200;
export const RESIZE_EASING = "cubic-bezier(0, 0, 0.58, 1)";
/**
 * Per-glyph travel (em), resting scale, tilt (degrees), blur (em) and the
 * stagger spread (fraction of the roll) — Scritto's
 * `{y: .35, scale: .6, rotate: 2, blur: .1, stagger: .3}`.
 */
export const TRAVEL_EM = 0.35;
export const REST_SCALE = 0.6;
export const TILT_DEG = 2;
export const BLUR_EM = 0.1;
export const STAGGER = 0.3;

/** The whole roll: the stagger pushes the last glyph's start out by up to STAGGER. */
export const ROLL_TOTAL_MS = ROLL_MS * (1 + STAGGER);

// `Intl.Segmenter` is newer than the project's ES2020 lib typings.
type GraphemeSegmenter = {
  segment(text: string): Iterable<{ segment: string }>;
};
const Segmenter = (
  Intl as unknown as {
    Segmenter?: new (
      locale: undefined,
      options: { granularity: "grapheme" },
    ) => GraphemeSegmenter;
  }
).Segmenter;
const segmenter = Segmenter
  ? new Segmenter(undefined, { granularity: "grapheme" })
  : null;

/** User-perceived characters, so emoji and combining marks roll whole. */
export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (part) => part.segment);
}

/**
 * Counts of the shared leading and trailing characters, never overlapping in
 * either string.
 */
export function sharedEnds(from: string[], to: string[]): [number, number] {
  let prefix = 0;
  while (
    prefix < from.length &&
    prefix < to.length &&
    from[prefix] === to[prefix]
  ) {
    prefix++;
  }
  const room = Math.min(from.length, to.length) - prefix;
  let suffix = 0;
  while (
    suffix < room &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix++;
  }
  return [prefix, suffix];
}

/**
 * Start delays (ms) for the changed glyphs at offsets `xs`: the stagger sweeps
 * left to right, spread by position rather than by index so wide and narrow
 * glyphs pace evenly.
 */
export function staggerDelays(xs: number[]): number[] {
  const count = xs.length;
  if (count === 0) return [];
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const spread = (ROLL_MS * STAGGER * (count - 1)) / count;
  return xs.map((x) =>
    max > min ? spread * Math.min(Math.max((x - min) / (max - min), 0), 1) : 0,
  );
}

/** Keyframes for a glyph leaving: rise, shrink, tilt, blur and fade out. */
export const ROLL_OUT: Keyframe[] = [
  { transform: "none", opacity: 1, filter: "none" },
  {
    transform: `translateY(${-TRAVEL_EM}em) rotate(${TILT_DEG}deg) scale(${REST_SCALE})`,
    opacity: 0,
    filter: `blur(${BLUR_EM}em)`,
  },
];

/** Keyframes for a glyph arriving from below, settling sharp and upright. */
export const ROLL_IN: Keyframe[] = [
  {
    transform: `translateY(${TRAVEL_EM}em) rotate(${TILT_DEG}deg) scale(${REST_SCALE})`,
    opacity: 0,
    filter: `blur(${BLUR_EM}em)`,
  },
  { transform: "none", opacity: 1, filter: "none" },
];
