import { openUrl } from "@tauri-apps/plugin-opener";
import type { RefObject } from "react";
import { formatInteger } from "../../../shared/lib/numbers";
import {
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from "../../../shared/ui/icons";
import { RollNumber, RollText } from "../../../shared/ui/RollText";
import { BOARD_PROVIDER_LABELS, type BoardProvider } from "../model/boardTypes";

const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-content/45";

export function BoardToolbar({
  provider,
  search,
  onSearchChange,
  searchRef,
  iterationLabel,
  iterationTitle,
  count,
  truncated,
  limit,
  busy,
  webUrl,
  onEdit,
  onRefresh,
}: {
  provider: BoardProvider;
  search: string;
  onSearchChange: (value: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  iterationLabel?: string;
  iterationTitle?: string;
  /** Cards on screen; `null` before the first load. */
  count: number | null;
  truncated: boolean;
  limit: number;
  busy: boolean;
  webUrl: string | null;
  onEdit: () => void;
  onRefresh: () => void;
}) {
  const providerLabel = BOARD_PROVIDER_LABELS[provider];
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
      <div className="relative flex h-7 w-56 min-w-0 shrink items-center">
        <Search className="pointer-events-none absolute left-2 size-3 shrink-0 opacity-50" />
        <input
          ref={searchRef}
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Filter cards"
          aria-label="Filter cards"
          spellCheck={false}
          autoComplete="off"
          className="h-7 w-full rounded-md bg-transparent pl-7 pr-2 text-[12px] text-content outline-none placeholder:text-content/40"
        />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 text-[12px] text-content/50">
        {iterationLabel ? (
          <>
            <span
              title={iterationTitle || iterationLabel}
              className="flex min-w-0 shrink"
            >
              <RollText text={iterationLabel} className="min-w-0 truncate" />
            </span>
            {count !== null ? (
              <span aria-hidden className="shrink-0 text-content/30">
                ·
              </span>
            ) : null}
          </>
        ) : null}
        {count !== null ? (
          <span className="shrink-0 tabular-nums">
            <RollNumber
              text={`${formatInteger(count)} ${count === 1 ? "item" : "items"}`}
            />
          </span>
        ) : null}
        {truncated ? (
          <span
            title="Narrow this board's filters to see every item"
            className="shrink-0 rounded-full bg-amber-500/12 px-1.5 py-px text-[11px] text-amber-500"
          >
            {`First ${formatInteger(limit)}`}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        title="Edit board"
        aria-label="Edit board"
        onClick={onEdit}
        className={ICON_BUTTON}
      >
        <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        title="Refresh"
        aria-label="Refresh"
        onClick={onRefresh}
        className={ICON_BUTTON}
      >
        {busy ? (
          <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
        ) : (
          <RefreshCw className="size-3.5" strokeWidth={1.75} />
        )}
      </button>
      {webUrl ? (
        <button
          type="button"
          title={`Open in ${providerLabel}`}
          aria-label={`Open in ${providerLabel}`}
          onClick={() => void openUrl(webUrl).catch(() => {})}
          className={ICON_BUTTON}
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </div>
  );
}
