import {
  BOARD_CATEGORY_RANK,
  OTHER_COLUMN_ID,
  isClosedCategory,
  type BoardCard,
  type BoardColumn,
  type BoardConfig,
  type BoardLocalColumn,
  type BoardSnapshot,
} from "./boardTypes";

/**
 * Organizational columns that exist only in MonoCode. Parking a card in one
 * ("Aguardando code review", "Em homologação") changes nothing in the
 * provider: the card keeps its real state and is shown here instead of in
 * its state's column, for as long as this board remembers it.
 */

export const LOCAL_COLUMN_PREFIX = "local:";
export const LOCAL_COLUMN_SUBTITLE = "MonoCode";

export function localColumnId(id: string): string {
  return `${LOCAL_COLUMN_PREFIX}${id}`;
}

export function isLocalColumnId(columnId: string): boolean {
  return columnId.startsWith(LOCAL_COLUMN_PREFIX);
}

export function isLocalColumn(column: BoardColumn): boolean {
  return column.target.provider === "local";
}

export function buildLocalColumns(
  definitions: readonly BoardLocalColumn[],
): BoardColumn[] {
  return definitions.map((definition) => ({
    id: localColumnId(definition.id),
    title: definition.title,
    subtitle: LOCAL_COLUMN_SUBTITLE,
    category: "inProgress",
    target: { provider: "local", localId: definition.id },
  }));
}

/**
 * Local columns sit after the last in-progress column, where review and
 * homologation fall in the flow; without one, before the first finished
 * column; with neither, before Other or at the end.
 */
export function insertLocalColumns(
  columns: readonly BoardColumn[],
  locals: readonly BoardColumn[],
): BoardColumn[] {
  if (locals.length === 0) return [...columns];
  let at = -1;
  for (let index = 0; index < columns.length; index += 1) {
    if (columns[index]!.category === "inProgress") at = index + 1;
  }
  if (at === -1) {
    at = columns.findIndex(
      (column) =>
        column.id === OTHER_COLUMN_ID ||
        BOARD_CATEGORY_RANK[column.category] >= BOARD_CATEGORY_RANK.resolved,
    );
    if (at === -1) at = columns.length;
  }
  return [...columns.slice(0, at), ...locals, ...columns.slice(at)];
}

/** Card key -> local column id (`local:...`). */
export type LocalPlacements = Readonly<Record<string, string>>;

export function localPlacementsKey(boardId: string): string {
  return `monocode.boards.local.${boardId}`;
}

export function loadLocalPlacements(boardId: string): LocalPlacements {
  try {
    const raw = localStorage.getItem(localPlacementsKey(boardId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const placements: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && isLocalColumnId(value)) {
        placements[key] = value;
      }
    }
    return placements;
  } catch {
    return {};
  }
}

export function saveLocalPlacements(
  boardId: string,
  placements: LocalPlacements,
) {
  try {
    const key = localPlacementsKey(boardId);
    if (Object.keys(placements).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(placements));
  } catch {
    // Storage refused the write: the placement lives on for this window.
  }
}

/** A card in a finished state goes back where it belongs; parking is for work. */
export function canParkCard(card: Pick<BoardCard, "stateCategory">): boolean {
  return !isClosedCategory(card.stateCategory);
}

/**
 * The board as shown: the config's local columns spliced in and parked
 * cards moved into them. Cards that finished, or whose column is gone, show
 * in their real column again.
 */
export function applyLocalBoard(
  snapshot: BoardSnapshot | null,
  config: BoardConfig | null,
  placements: LocalPlacements,
): BoardSnapshot | null {
  if (!snapshot || !config || config.provider !== "azuredevops") return snapshot;
  const locals = buildLocalColumns(config.localColumns);
  if (locals.length === 0) return snapshot;
  const columns = insertLocalColumns(snapshot.columns, locals);
  const known = new Set(locals.map((column) => column.id));
  let changed = false;
  const cards = snapshot.cards.map((card) => {
    const parked = placements[card.key];
    if (!parked || !known.has(parked) || !canParkCard(card)) return card;
    changed = true;
    return { ...card, columnId: parked };
  });
  return { ...snapshot, columns, cards: changed ? cards : snapshot.cards };
}

/**
 * Placements worth keeping: the card is still on the board, can be parked,
 * and its column still exists. The same object comes back when nothing
 * changed, so callers can skip a write.
 */
export function prunedPlacements(
  placements: LocalPlacements,
  snapshot: BoardSnapshot | null,
  config: BoardConfig | null,
): LocalPlacements {
  if (!snapshot || !config || config.provider !== "azuredevops") {
    return placements;
  }
  const known = new Set(
    config.localColumns.map((definition) => localColumnId(definition.id)),
  );
  const cards = new Map(snapshot.cards.map((card) => [card.key, card]));
  let changed = false;
  const next: Record<string, string> = {};
  for (const [key, columnId] of Object.entries(placements)) {
    const card = cards.get(key);
    if (card && known.has(columnId) && canParkCard(card)) {
      next[key] = columnId;
    } else {
      changed = true;
    }
  }
  return changed ? next : placements;
}
