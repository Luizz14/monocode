import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LoaderCircle, X } from "../../../shared/ui/icons";
import { InboxMiniLabel } from "../../inbox/ui/InboxMiniCard";
import { cardAriaLabel } from "../model/boardView";
import type {
  BoardCard as BoardCardData,
  BoardColumn,
} from "../model/boardTypes";
import { LinearPriorityGlyph, WorkItemTypeGlyph } from "./boardGlyphs";

const MAX_TAGS = 3;

/** Stable handlers shared by every card on the board. */
export type BoardCardHandlers = {
  onPointerDown: (key: string, event: ReactPointerEvent<HTMLElement>) => void;
  onClick: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onAuxClick: (key: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (
    key: string,
    event: ReactMouseEvent<HTMLButtonElement>,
  ) => void;
  onKeyDown: (
    key: string,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => void;
  onFocus: (key: string) => void;
  onDismissError: (key: string) => void;
};

export function initials(name: string): string {
  const words = name
    .replace(/[<(].*$/, "")
    .split(/[\s._@-]+/)
    .filter(Boolean);
  const letters =
    words.length >= 2
      ? `${words[0]![0]}${words[words.length - 1]![0]}`
      : (words[0]?.slice(0, 2) ?? "?");
  return letters.toUpperCase();
}

function Assignee({ card }: { card: BoardCardData }) {
  const [failed, setFailed] = useState(false);
  const assignee = card.assignee;
  if (!assignee) return null;
  // Azure avatars need the PAT, so only Linear loads the image.
  const showImage =
    card.provider === "linear" && !!assignee.avatarUrl && !failed;
  return (
    <span
      title={assignee.name}
      className="ml-auto grid size-5 shrink-0 place-items-center overflow-hidden rounded-full bg-content/10 text-[9px] font-medium text-content/65"
    >
      {showImage ? (
        <img
          src={assignee.avatarUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        initials(assignee.name)
      )}
    </span>
  );
}

function formatEffort(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export const BoardCard = memo(function BoardCard({
  card,
  column,
  focused,
  pending,
  error,
  dragging,
  handlers,
}: {
  card: BoardCardData;
  column: BoardColumn | undefined;
  /** Holds the roving tab stop. */
  focused: boolean;
  pending: boolean;
  error: string | undefined;
  /** This card is the one being dragged. */
  dragging: boolean;
  handlers: BoardCardHandlers;
}) {
  const key = card.key;
  const tags = card.tags.slice(0, MAX_TAGS);
  const extraTags = card.tags.length - tags.length;
  return (
    <li
      data-board-card
      data-card-key={key}
      className={`relative flex flex-col gap-1 ${dragging ? "opacity-40" : ""}`}
    >
      <button
        type="button"
        data-card-key={key}
        tabIndex={focused ? 0 : -1}
        aria-busy={pending || undefined}
        aria-haspopup="menu"
        aria-label={cardAriaLabel(card, { column, pending, error })}
        onPointerDown={(event) => handlers.onPointerDown(key, event)}
        onClick={(event) => handlers.onClick(key, event)}
        onAuxClick={(event) => handlers.onAuxClick(key, event)}
        onContextMenu={(event) => handlers.onContextMenu(key, event)}
        onKeyDown={(event) => handlers.onKeyDown(key, event)}
        onFocus={() => handlers.onFocus(key)}
        className={`flex w-full touch-none select-none flex-col gap-1.5 rounded-md border bg-background-base px-2.5 py-2 text-left outline-none hover:border-content/20 focus-visible:ring-2 focus-visible:ring-accent ${
          error ? "border-red-400/40" : "border-content/8"
        } ${pending ? "opacity-70" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-content/50">
          {card.provider === "azuredevops" ? (
            <WorkItemTypeGlyph type={card.type} />
          ) : (
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full border border-content/30"
              style={
                card.stateColor
                  ? {
                      backgroundColor: card.stateColor,
                      borderColor: card.stateColor,
                    }
                  : undefined
              }
            />
          )}
          <span className="min-w-0 truncate tabular-nums">{card.ref}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {card.provider === "linear" && card.priority ? (
              <LinearPriorityGlyph priority={card.priority} />
            ) : null}
            {pending ? (
              <LoaderCircle
                aria-hidden
                className="size-3 animate-spin text-content/50"
                strokeWidth={1.75}
              />
            ) : card.effort != null ? (
              <span className="rounded bg-content/8 px-1 py-px text-[10px] tabular-nums text-content/60">
                {formatEffort(card.effort)}
              </span>
            ) : null}
          </span>
        </span>
        <span className="line-clamp-2 text-[12.5px] leading-snug text-content">
          {card.title || "Untitled"}
        </span>
        {tags.length > 0 || card.assignee ? (
          <span className="flex min-w-0 items-center gap-1">
            {tags.map((tag) => (
              <InboxMiniLabel
                key={tag.name}
                label={{ name: tag.name, color: tag.color ?? "" }}
              />
            ))}
            {extraTags > 0 ? (
              <span className="shrink-0 text-[10px] text-content/40">
                +{extraTags}
              </span>
            ) : null}
            <Assignee card={card} />
          </span>
        ) : null}
      </button>
      {error ? (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md bg-red-500/10 px-2 py-1 text-[11px] leading-snug text-red-400"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button
            type="button"
            aria-label={`Dismiss error for ${card.ref}`}
            onClick={() => handlers.onDismissError(key)}
            className="grid size-4 shrink-0 place-items-center rounded text-red-400/80 hover:bg-red-500/15 hover:text-red-300"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </div>
      ) : null}
    </li>
  );
});
