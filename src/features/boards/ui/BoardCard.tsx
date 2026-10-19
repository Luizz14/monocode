import {
  memo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LoaderCircle, X } from "../../../shared/ui/icons";
import { InboxMiniLabel } from "../../inbox/ui/InboxMiniCard";
import { describeOwner } from "../model/boardOwners";
import { cardAriaLabel } from "../model/boardView";
import type {
  BoardCard as BoardCardData,
  BoardColumn,
  BoardPerson,
} from "../model/boardTypes";
import { LinearPriorityGlyph, WorkItemTypeGlyph } from "./boardGlyphs";

const MAX_TAGS = 3;
/** Avatars shown before the `+N` overflow. */
const MAX_PEOPLE = 3;

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

/** Initials, or Linear's image. Azure avatars need the PAT, so only the name is used. */
export function PersonAvatar({
  person,
  title,
  className = "size-5 text-[9px]",
  strong = false,
}: {
  person: BoardPerson;
  title?: string;
  className?: string;
  /** The primary owner: a firmer fill than the people beside them. */
  strong?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = !!person.avatarUrl && !failed;
  return (
    <span
      title={title ?? person.name}
      data-person={person.isMe ? "me" : undefined}
      className={`board-avatar grid shrink-0 place-items-center overflow-hidden rounded-full font-medium ring-1 ${className} ${
        person.isMe ? "ring-accent" : "ring-background-base"
      } ${strong ? "board-avatar-strong text-content/85" : "text-content/60"}`}
    >
      {showImage ? (
        <img
          src={person.avatarUrl}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : (
        initials(person.name)
      )}
    </span>
  );
}

/**
 * Who holds the card: the people on its children, primary first, else its
 * Assigned To. Hovering an avatar lists that person's children.
 */
function People({ card }: { card: BoardCardData }) {
  const owners = card.owners;
  const people = owners
    ? [owners.primary, ...owners.others]
    : card.assignee
      ? [card.assignee]
      : [];
  if (people.length === 0) return null;
  const shown = people.slice(0, MAX_PEOPLE);
  const extra = people.length - shown.length;
  const fromChildren = owners?.source === "children";
  return (
    <span
      data-card-people={fromChildren ? "children" : "assignee"}
      className="ml-auto flex shrink-0 items-center -space-x-1"
    >
      {shown.map((person, index) => (
        <PersonAvatar
          key={`${person.id ?? person.name}-${index}`}
          person={person}
          strong={fromChildren && index === 0}
          title={
            fromChildren
              ? describeOwner(person, card.children)
              : `Assigned to ${person.name}`
          }
        />
      ))}
      {extra > 0 ? (
        <span
          title={people
            .slice(MAX_PEOPLE)
            .map((person) => person.name)
            .join(", ")}
          className="board-avatar grid size-5 shrink-0 place-items-center rounded-full text-[9px] tabular-nums text-content/55 ring-1 ring-background-base"
        >
          +{extra}
        </span>
      ) : null}
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
          {column?.target.provider === "local" ? (
            // Parked here for organization: the real state stays visible.
            <span
              title={`State in Azure DevOps: ${card.state}`}
              className="min-w-0 truncate rounded px-1 py-px text-[10px] text-content/55 ring-1 ring-content/10"
              style={
                card.stateColor
                  ? { boxShadow: `inset 2px 0 0 ${card.stateColor}` }
                  : undefined
              }
            >
              {card.state}
            </span>
          ) : null}
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
        {tags.length > 0 || card.assignee || card.owners ? (
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
            <People card={card} />
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
