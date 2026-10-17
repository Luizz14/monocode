import { memo } from "react";
import { RollNumber } from "../../../shared/ui/RollText";
import type { ColumnLoad, DropVerdict } from "../model/boardColumns";
import {
  isClosedCategory,
  type BoardCard as BoardCardData,
  type BoardColumn as BoardColumnData,
} from "../model/boardTypes";
import { columnAriaLabel, columnCountLabel } from "../model/boardView";
import { BoardCard, type BoardCardHandlers } from "./BoardCard";

const EMPTY_ERRORS: Readonly<Record<string, string>> = {};

export const BoardColumn = memo(function BoardColumn({
  column,
  load,
  cards,
  doneHidden,
  drop,
  draggingKey,
  focusKey,
  pending,
  moveErrors = EMPTY_ERRORS,
  handlers,
}: {
  column: BoardColumnData;
  load: ColumnLoad;
  cards: readonly BoardCardData[];
  /** The board hides done items, so an empty done column says why. */
  doneHidden: boolean;
  /** Verdict while a dragged card hovers this column. */
  drop: DropVerdict | null;
  draggingKey: string | null;
  focusKey: string | null;
  pending: ReadonlySet<string>;
  moveErrors?: Readonly<Record<string, string>>;
  handlers: BoardCardHandlers;
}) {
  const label = columnAriaLabel(column, load);
  const dropKind = drop?.kind ?? null;
  return (
    <section
      data-board-column={column.id}
      data-drop={dropKind ?? undefined}
      aria-label={label}
      className={`flex max-h-full w-[272px] shrink-0 flex-col rounded-lg bg-content/[0.03] ring-1 transition-shadow ${
        dropKind === "ok"
          ? "ring-2 ring-accent"
          : dropKind === "disallowed"
            ? "ring-2 ring-red-400/60"
            : "ring-content/6"
      }`}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 px-2.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full bg-content/25"
          style={column.color ? { backgroundColor: column.color } : undefined}
        />
        <h3 className="flex min-w-0 flex-1 items-baseline gap-1 text-[12px] font-medium text-content">
          <span className="min-w-0 truncate">{column.title}</span>
          {column.subtitle ? (
            <span className="shrink-0 text-[11px] font-normal text-content/45">
              {column.subtitle}
            </span>
          ) : null}
        </h3>
        <span
          aria-hidden
          title={
            load.limit !== null
              ? `${load.groupCount} of ${load.limit} allowed in progress`
              : undefined
          }
          className={`shrink-0 rounded-full px-1.5 py-px text-[11px] tabular-nums ${
            load.over
              ? "bg-red-500/15 text-red-400"
              : "bg-content/8 text-content/55"
          }`}
        >
          <RollNumber text={columnCountLabel(load)} />
        </span>
      </header>
      {drop?.kind === "disallowed" ? (
        <p className="shrink-0 px-2.5 pb-1.5 text-[11px] leading-snug text-red-400">
          {drop.reason}
        </p>
      ) : null}
      {cards.length === 0 ? (
        <p className="px-2.5 pb-3 pt-1 text-[11.5px] text-content/40">
          {doneHidden && isClosedCategory(column.category)
            ? "Done items are hidden by this board's filter."
            : "No items"}
        </p>
      ) : (
        <ul
          role="list"
          aria-label={`${column.title} cards`}
          data-board-list
          className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-1.5 pb-1.5"
        >
          {cards.map((card) => (
            <BoardCard
              key={card.key}
              card={card}
              column={column}
              focused={card.key === focusKey}
              pending={pending.has(card.key)}
              error={moveErrors[card.key]}
              dragging={card.key === draggingKey}
              handlers={handlers}
            />
          ))}
        </ul>
      )}
    </section>
  );
});
