import { useId } from "react";
import { SKY_GLYPHS, type IconGlyph } from "../../../shared/ui/icons";
import type { EffortLevel } from "../model/effortLevels";

/** Medium is the design's own globe ("Ícone / terra"); the rest are Hugeicons. */
const LEVEL_ICONS: Record<Exclude<EffortLevel, "medium">, IconGlyph> = {
  low: SKY_GLYPHS.moon,
  high: SKY_GLYPHS.saturn,
  xhigh: SKY_GLYPHS.sun,
  max: SKY_GLYPHS.stars,
  ultracode: SKY_GLYPHS.comet,
  ultrathink: SKY_GLYPHS.galaxy,
};

/**
 * The icon for an effort level, drawn in `currentColor` so the level color
 * comes from `[data-effort-level]`; Ultrathink strokes a rainbow instead. A
 * value outside the ladder gets the globe, in whatever color it inherits.
 */
export function EffortLevelIcon({
  level,
  size,
  className,
}: {
  level: EffortLevel | undefined;
  size: number;
  className?: string;
}) {
  // React ids carry punctuation that `url(#…)` does not accept.
  const gradientId = `effort-rainbow-${useId().replace(/[^\w-]/g, "")}`;
  const paint = level === "ultrathink" ? `url(#${gradientId})` : "currentColor";
  const icon = level && level !== "medium" ? LEVEL_ICONS[level] : undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox={icon ? "0 0 24 24" : "-88 -88 424 424"}
      fill="none"
      aria-hidden="true"
      data-effort-icon={level ?? "none"}
      className={className}
    >
      {level === "ultrathink" ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f87171" />
            <stop offset="30%" stopColor="#fbbf24" />
            <stop offset="55%" stopColor="#34d399" />
            <stop offset="80%" stopColor="#60a5fa" />
            <stop offset="100%" stopColor="#e879f9" />
          </linearGradient>
        </defs>
      ) : null}
      {icon ? (
        icon.map(([tag, { key, ...attrs }]) => {
          const Tag = tag as "path" | "circle";
          return (
            <Tag
              key={String(key)}
              {...attrs}
              stroke={paintFor(attrs.stroke, paint)}
              fill={paintFor(attrs.fill, paint)}
            />
          );
        })
      ) : (
        <path d={GLOBE_PATH} fill={paint} />
      )}
    </svg>
  );
}

/** Swaps an icon's `currentColor` paint for the level's, keeping the rest. */
function paintFor(
  value: string | number | undefined,
  paint: string,
): string | undefined {
  if (value == null) return undefined;
  return value === "currentColor" ? paint : String(value);
}

/** The globe from the design's model panel. */
const GLOBE_PATH =
  "M123.996-48.25A172.25 172.25 0 1 0 296.246 124 172.432 172.432 0 0 0 123.996-48.25Zm145.75 172.25a145.12 145.12 0 0 1-10.6 54.557l-74.034-45.53a26.367 26.367 0 0 0-10.335-3.693l-37.796-5.102a26.682 26.682 0 0 0-26.5 13.018h-14.443l-6.293-13.018a26.351 26.351 0 0 0-18.219-14.359l-13.25-2.866L71.228 84.25h27.676a26.6 26.6 0 0 0 12.803-3.313l20.289-11.195a27.527 27.527 0 0 0 4.969-3.545l44.57-40.313A26.384 26.384 0 0 0 186.935-6.678l-0.597-1.076A145.932 145.932 0 0 1 269.746 124ZM149.354-19.53L163.746 6.241 119.177 46.554 98.904 57.75H71.228a26.5 26.5 0 0 0-22.988 13.25l-14.459 25.225L16.97 51.44 35.088 8.594a145.534 145.534 0 0 1 114.282-28.157ZM-21.754 124a144.971 144.971 0 0 1 14.145-62.606l18.782 50.135a26.5 26.5 0 0 0 19.245 16.562l35.494 7.636L72.222 148.844a26.649 26.649 0 0 0 23.85 14.906h2.451l-11.974 26.881a26.5 26.5 0 0 0 4.737 28.769l0.231 0.232L123.996 253.089l-3.213 16.562A145.932 145.932 0 0 1-21.754 124Zm169.899 143.73l1.871-9.623a26.649 26.649 0 0 0-6.625-23.022 3.064 3.064 0 0 1-0.232-0.232L110.746 201.414 133.437 150.5l37.796 5.102 75.723 46.573A146.048 146.048 0 0 1 148.145 267.73Z";
