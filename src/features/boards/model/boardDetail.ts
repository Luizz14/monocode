import {
  azureWorkItemDetail,
  type AzureRelatedItem,
  type AzureWorkItemDetail,
} from "./azureBoards";
import { azureStateCategory, ownValue } from "./boardTypes";
import type { AzureStateInfo, BoardStateCategory } from "./boardTypes";

/** A detail this young is shown without refetching. */
export const BOARD_DETAIL_FRESH_MS = 2 * 60_000;

type Entry = { value: AzureWorkItemDetail; at: number };

let generation = 0;
const details = new Map<string, Entry>();
const inflight = new Map<string, Promise<AzureWorkItemDetail>>();

function keyOf(project: string, id: number): string {
  return `${project.trim()}\u0000${id}`;
}

export function clearBoardDetailCache() {
  generation += 1;
  details.clear();
  inflight.clear();
}

/** Drops one item so its next open refetches, such as after a move. */
export function invalidateBoardDetail(project: string, id: number) {
  const key = keyOf(project, id);
  details.delete(key);
  inflight.delete(key);
}

export function peekBoardDetail(
  project: string,
  id: number,
  now = Date.now(),
): AzureWorkItemDetail | null {
  const hit = details.get(keyOf(project, id));
  return hit && now - hit.at < BOARD_DETAIL_FRESH_MS ? hit.value : null;
}

/** Stale cached value, for showing while a refresh runs. */
export function peekStaleBoardDetail(
  project: string,
  id: number,
): AzureWorkItemDetail | null {
  return details.get(keyOf(project, id))?.value ?? null;
}

/**
 * The work item detail, cached per project and id with one shared request;
 * a cache clear drops late answers.
 */
export function loadBoardDetail(
  project: string,
  id: number,
  options?: { force?: boolean },
): Promise<AzureWorkItemDetail> {
  const key = keyOf(project, id);
  if (!options?.force) {
    const cached = peekBoardDetail(project, id);
    if (cached) return Promise.resolve(cached);
    const running = inflight.get(key);
    if (running) return running;
  }
  const started = generation;
  const pending = azureWorkItemDetail(project, id)
    .then((detail) => {
      if (started === generation && inflight.get(key) === pending) {
        details.set(key, { value: detail, at: Date.now() });
      }
      return detail;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

// ---------------------------------------------------------------------------
// Pure helpers for the detail pane
// ---------------------------------------------------------------------------

/** Category of a related item's state: the board's types first, else by name. */
export function relatedStateCategory(
  item: Pick<AzureRelatedItem, "workItemType" | "state">,
  info: AzureStateInfo | undefined,
  childTypes?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): BoardStateCategory {
  const known = ownValue(ownValue(info, item.workItemType), item.state);
  if (known) return known.category;
  const category = childTypes?.get(item.workItemType)?.get(item.state);
  if (category) return azureStateCategory(category);
  return guessStateCategory(item.state);
}

/** Common process state names, for types the board never loaded. */
export function guessStateCategory(state: string): BoardStateCategory {
  switch (state.trim().toLowerCase()) {
    case "new":
    case "to do":
    case "defined":
    case "proposed":
    case "approved":
    case "requested":
      return "todo";
    case "active":
    case "in progress":
    case "doing":
    case "committed":
    case "open":
    case "em desenvolvimento":
    case "em andamento":
      return "inProgress";
    case "resolved":
    case "ready for test":
    case "accepted":
      return "resolved";
    case "closed":
    case "done":
    case "completed":
    case "inactive":
      return "done";
    case "removed":
    case "cut":
    case "abandoned":
      return "canceled";
    default:
      return "unknown";
  }
}

/** `14 Oct 2026, 13:27` in the user's locale; the raw text when unparsable. */
export function formatDetailDate(
  value: string,
  options?: { time?: boolean },
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(options?.time === false
      ? {}
      : { hour: "2-digit", minute: "2-digit" }),
  });
}

/** Last two segments of a path: `2026_R4 \ S01 - R4_2026`. */
export function shortPath(path: string): string {
  const parts = path.split("\\").filter(Boolean);
  if (parts.length <= 2) return parts.join(" \\ ");
  return parts.slice(-2).join(" \\ ");
}
