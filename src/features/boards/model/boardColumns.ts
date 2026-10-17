import { resolveAzureMove, type AzureMoveChange } from "./azureBoards";
import { resolveLinearMove } from "./linearBoards";
import {
  OTHER_COLUMN_ID,
  ownValue,
  type BoardCard,
  type BoardColumn,
  type BoardMoveRejection,
  type BoardSnapshot,
} from "./boardTypes";

export { OTHER_COLUMN_ID };

export const OTHER_COLUMN: BoardColumn = {
  id: OTHER_COLUMN_ID,
  title: "Other",
  category: "unknown",
  target: { provider: "none" },
};

/** Appends the Other column when at least one card fits no column. */
export function withOtherColumn(
  columns: readonly BoardColumn[],
  cards: readonly BoardCard[],
): BoardColumn[] {
  const known = new Set(columns.map((column) => column.id));
  const needsOther =
    !known.has(OTHER_COLUMN_ID) &&
    cards.some(
      (card) => card.columnId === OTHER_COLUMN_ID || !known.has(card.columnId),
    );
  return needsOther ? [...columns, OTHER_COLUMN] : [...columns];
}

function updatedTime(card: BoardCard): number {
  const time = Date.parse(card.updatedAt);
  return Number.isFinite(time) ? time : 0;
}

/** Provider order first, then most recently updated. */
export function sortBoardCards(cards: readonly BoardCard[]): BoardCard[] {
  return cards
    .slice()
    .sort((a, b) => a.order - b.order || updatedTime(b) - updatedTime(a));
}

/**
 * Sorted cards per column id; every column has an entry. Cards pointing at an
 * unknown column go to Other when the board has one.
 */
export function groupCardsByColumn(
  columns: readonly BoardColumn[],
  cards: readonly BoardCard[],
): Map<string, BoardCard[]> {
  const grouped = new Map<string, BoardCard[]>();
  for (const column of columns) grouped.set(column.id, []);
  for (const card of sortBoardCards(cards)) {
    const bucket =
      grouped.get(card.columnId) ?? grouped.get(OTHER_COLUMN_ID) ?? null;
    bucket?.push(card);
  }
  return grouped;
}

export type ColumnLoad = {
  /** Cards in this column. */
  count: number;
  /** Cards across the column's group (both split halves). */
  groupCount: number;
  limit: number | null;
  over: boolean;
};

export function columnLoad(
  column: BoardColumn,
  columns: readonly BoardColumn[],
  grouped: ReadonlyMap<string, readonly BoardCard[]>,
): ColumnLoad {
  const group = column.groupId ?? column.id;
  const count = grouped.get(column.id)?.length ?? 0;
  let groupCount = 0;
  for (const other of columns) {
    if ((other.groupId ?? other.id) === group) {
      groupCount += grouped.get(other.id)?.length ?? 0;
    }
  }
  const limit = column.wipLimit && column.wipLimit > 0 ? column.wipLimit : null;
  return {
    count,
    groupCount,
    limit,
    over: limit !== null && groupCount > limit,
  };
}

export type BoardMovePlan =
  | ({ provider: "azuredevops" } & AzureMoveChange)
  | { provider: "linear"; stateId: string };

export type BoardMoveResolution =
  { plan: BoardMovePlan } | { error: BoardMoveRejection };

export function resolveBoardMove(
  snapshot: BoardSnapshot,
  card: BoardCard,
  column: BoardColumn,
): BoardMoveResolution {
  if (card.provider === "azuredevops") {
    const result = resolveAzureMove(card, column, {
      columnField: snapshot.azure?.columnField ?? null,
      doneField: snapshot.azure?.doneField ?? null,
    });
    return "error" in result
      ? result
      : { plan: { provider: "azuredevops", ...result } };
  }
  const result = resolveLinearMove(card, column);
  return "error" in result
    ? result
    : { plan: { provider: "linear", stateId: result.stateId } };
}

export type DropVerdict =
  { kind: "ok" } | { kind: "same" } | { kind: "disallowed"; reason: string };

/** Whether `card` may be dropped on `column`, with a reason when it may not. */
export function dropVerdict(
  snapshot: BoardSnapshot,
  card: BoardCard,
  column: BoardColumn,
  pending = false,
): DropVerdict {
  if (column.id === card.columnId) return { kind: "same" };
  if (pending) {
    return { kind: "disallowed", reason: "This card is still moving" };
  }
  const result = resolveBoardMove(snapshot, card, column);
  if ("plan" in result) return { kind: "ok" };
  if (result.error === "same-column") return { kind: "same" };
  return {
    kind: "disallowed",
    reason: disallowedReason(snapshot, card, column),
  };
}

function disallowedReason(
  snapshot: BoardSnapshot,
  card: BoardCard,
  column: BoardColumn,
): string {
  if (column.target.provider === "none") {
    return `Cards can't be moved to “${column.title}”`;
  }
  if (card.provider === "azuredevops") {
    return `No “${column.title}” state for ${card.type || "this work item type"}`;
  }
  const team =
    card.teamName ||
    snapshot.linear?.teams.find((entry) => entry.id === card.teamId)?.name ||
    "This team";
  if (column.target.provider === "linear") {
    const state = ownValue(column.target.statesByTeam, card.teamId);
    if (!state) return `${team} has no “${column.title}” state`;
  }
  return `Can't move to “${column.title}”`;
}

/** The nearest column in `dir` that accepts the card, or `null`. */
export function adjacentMoveTarget(
  snapshot: BoardSnapshot,
  card: BoardCard,
  dir: -1 | 1,
  pending = false,
): BoardColumn | null {
  const columns = snapshot.columns;
  const from = columns.findIndex((column) => column.id === card.columnId);
  if (from === -1) return null;
  for (
    let index = from + dir;
    index >= 0 && index < columns.length;
    index += dir
  ) {
    const column = columns[index]!;
    if (dropVerdict(snapshot, card, column, pending).kind === "ok")
      return column;
  }
  return null;
}
