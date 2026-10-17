import type { ExplorerMenuItem } from "../../files/ui/ExplorerMenu";
import { dropVerdict } from "../model/boardColumns";
import {
  BOARD_PROVIDER_LABELS,
  type BoardCard,
  type BoardSnapshot,
} from "../model/boardTypes";

export type BoardCardMenuAction =
  | { kind: "open" }
  | { kind: "copy-link" }
  | { kind: "copy-id" }
  | { kind: "start" }
  | { kind: "move"; columnId: string };

const MOVE_PREFIX = "move:";

/**
 * The card's action menu: open, copy link and ID, start a chat, and a
 * "Move to…" submenu where the current column is checked and columns the
 * card can't land on are disabled with the reason.
 */
export function boardCardMenuItems(
  snapshot: BoardSnapshot,
  card: BoardCard,
  options: { pending?: boolean; canStart?: boolean } = {},
): ExplorerMenuItem[] {
  const provider = BOARD_PROVIDER_LABELS[card.provider];
  const items: ExplorerMenuItem[] = [
    {
      kind: "item",
      id: "open",
      label: `Open in ${provider}`,
      disabled: !card.url,
    },
    { kind: "item", id: "copy-link", label: "Copy link", disabled: !card.url },
    { kind: "item", id: "copy-id", label: "Copy ID" },
  ];
  if (options.canStart) {
    items.push({ kind: "item", id: "start", label: "Start chat" });
  }
  const submenu = snapshot.columns.map((column) => {
    const verdict = dropVerdict(snapshot, card, column, options.pending);
    const current = column.id === card.columnId;
    const label = column.subtitle
      ? `${column.title} · ${column.subtitle}`
      : column.title;
    return {
      kind: "item" as const,
      id: `${MOVE_PREFIX}${column.id}`,
      label,
      checked: current,
      disabled: !current && verdict.kind !== "ok",
      ...(verdict.kind === "disallowed" && !current
        ? { description: verdict.reason }
        : {}),
    };
  });
  if (submenu.length > 0) {
    items.push(
      { kind: "sep" },
      {
        kind: "item",
        id: "move",
        label: "Move to…",
        disabled: options.pending,
        submenu,
      },
    );
  }
  return items;
}

/** The action behind a picked menu id, or `null` for ids it doesn't know. */
export function boardCardMenuAction(id: string): BoardCardMenuAction | null {
  if (id.startsWith(MOVE_PREFIX)) {
    const columnId = id.slice(MOVE_PREFIX.length);
    return columnId ? { kind: "move", columnId } : null;
  }
  switch (id) {
    case "open":
    case "copy-link":
    case "copy-id":
    case "start":
      return { kind: id };
    default:
      return null;
  }
}

/** What "Copy ID" puts on the clipboard: `#123` or `ENG-12`. */
export function boardCardCopyId(card: BoardCard): string {
  return card.ref || String(card.number);
}
