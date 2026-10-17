import type { ColumnLoad } from "./boardColumns";
import type { BoardCard, BoardColumn } from "./boardTypes";

export type BoardFocusDirection =
  "up" | "down" | "left" | "right" | "home" | "end";

/**
 * The card key focus should move to from `key`, given card keys per column in
 * board order. Left and right skip empty columns and keep the row when they
 * can; Home and End stay in the column. `null` when there is nowhere to go.
 */
export function focusNeighbor(
  grid: readonly (readonly string[])[],
  key: string,
  direction: BoardFocusDirection,
): string | null {
  let col = -1;
  let row = -1;
  for (let index = 0; index < grid.length; index += 1) {
    const found = grid[index]!.indexOf(key);
    if (found !== -1) {
      col = index;
      row = found;
      break;
    }
  }
  if (col === -1) return null;
  const column = grid[col]!;
  switch (direction) {
    case "up":
      return row > 0 ? column[row - 1]! : null;
    case "down":
      return row < column.length - 1 ? column[row + 1]! : null;
    case "home":
      return row > 0 ? column[0]! : null;
    case "end":
      return row < column.length - 1 ? column[column.length - 1]! : null;
    case "left":
    case "right": {
      const step = direction === "left" ? -1 : 1;
      for (
        let index = col + step;
        index >= 0 && index < grid.length;
        index += step
      ) {
        const next = grid[index]!;
        if (next.length > 0) return next[Math.min(row, next.length - 1)]!;
      }
      return null;
    }
  }
}

/** `3`, or `4/5` when the column has a WIP limit (counted across its group). */
export function columnCountLabel(load: ColumnLoad): string {
  return load.limit !== null
    ? `${load.groupCount}/${load.limit}`
    : String(load.count);
}

function items(count: number): string {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

export function columnAriaLabel(column: BoardColumn, load: ColumnLoad): string {
  const title = column.subtitle
    ? `${column.title}, ${column.subtitle}`
    : column.title;
  const parts = [title, items(load.count)];
  if (load.limit !== null) {
    parts.push(
      load.over ? `over the limit of ${load.limit}` : `limit ${load.limit}`,
    );
  }
  return parts.join(", ");
}

export function cardAriaLabel(
  card: BoardCard,
  options?: { column?: BoardColumn; pending?: boolean; error?: string },
): string {
  const kind = card.type ? `${card.type} ` : "";
  const parts = [`${kind}${card.ref}: ${card.title || "Untitled"}`];
  const where = options?.column
    ? options.column.subtitle
      ? `${options.column.title} (${options.column.subtitle})`
      : options.column.title
    : card.state;
  parts.push(
    where === card.state
      ? `State ${card.state}`
      : `In ${where}, state ${card.state}`,
  );
  if (card.assignee) parts.push(`Assigned to ${card.assignee.name}`);
  else parts.push("Unassigned");
  if (card.effort != null) {
    parts.push(`${card.effort} ${card.effort === 1 ? "point" : "points"}`);
  }
  if (card.priority) parts.push(card.priority.label);
  if (card.tags.length > 0) {
    parts.push(`Tags ${card.tags.map((tag) => tag.name).join(", ")}`);
  }
  if (options?.pending) parts.push("Moving");
  if (options?.error) parts.push(`Move failed: ${options.error}`);
  return `${parts.join(". ")}.`;
}
