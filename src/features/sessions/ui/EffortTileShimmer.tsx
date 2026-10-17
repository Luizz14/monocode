import type { CSSProperties } from "react";

const EFFORT_TILE_COLUMNS = 32;
const EFFORT_TILE_ROWS = 5;

/**
 * The tile grid behind a top effort level: tiles light up from the center
 * outward in the tone's color, then clear. Styled in `ModelPicker.css`.
 */
export function EffortTileShimmer({ className }: { className?: string }) {
  return (
    <span
      className={`codex-effort-tiles${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      {Array.from(
        { length: EFFORT_TILE_COLUMNS * EFFORT_TILE_ROWS },
        (_, index) => {
          const column = index % EFFORT_TILE_COLUMNS;
          const row = Math.floor(index / EFFORT_TILE_COLUMNS);
          const centerColumn = (EFFORT_TILE_COLUMNS - 1) / 2;
          const centerRow = (EFFORT_TILE_ROWS - 1) / 2;
          const distance = Math.hypot(
            (column - centerColumn) / centerColumn,
            (row - centerRow) / centerRow,
          );
          const filled = (index * 73 + index * index * 19 + 23) % 101 < 65;
          return (
            <span
              key={index}
              className={`codex-effort-tile${filled ? " codex-effort-tile--filled" : ""}`}
              style={
                {
                  "--tile-distance": distance,
                  "--tile-column": column,
                } as CSSProperties
              }
            />
          );
        },
      )}
    </span>
  );
}
