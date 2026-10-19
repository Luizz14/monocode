import { DEFAULT_AUTO_TASK_TITLE } from "./boardConfigs";
import { isClosedCategory } from "./boardTypes";
import type { BoardCard, BoardColumn, BoardConfig } from "./boardTypes";

export type PickupDecision =
  | { kind: "create" }
  | {
      kind: "skip";
      reason:
        | "disabled"
        | "provider"
        | "not-proposed"
        | "not-work-column"
        | "child-type"
        | "already-mine"
        | "not-moved";
    };

/**
 * Types that are the work itself, not something to take up: giving a Task a
 * Task of its own would only nest the same work one level down.
 */
const CHILD_LEVEL_TYPES = new Set(["task", "test", "test case", "issue"]);

/**
 * Whether moving `before` into `column` is the moment someone takes the item
 * up, so a Task for them should be created under it. That is: an Azure item
 * (not itself a Task, Test or Issue) leaves a Proposed state for a work
 * column, and the connected user has no unfinished child of it already.
 * The checks run in a fixed order so a skip names the first reason.
 */
export function pickupDecision(
  before: BoardCard,
  column: BoardColumn,
  config: BoardConfig,
): PickupDecision {
  if (config.provider !== "azuredevops" || before.provider !== "azuredevops") {
    return { kind: "skip", reason: "provider" };
  }
  if (!config.autoTask.enabled) return { kind: "skip", reason: "disabled" };
  if (CHILD_LEVEL_TYPES.has((before.type ?? "").trim().toLowerCase())) {
    return { kind: "skip", reason: "child-type" };
  }
  const proposed =
    before.stateCategory === "todo" ||
    before.stateCategory === "backlog" ||
    before.stateCategory === "triage";
  if (!proposed) return { kind: "skip", reason: "not-proposed" };
  if (column.category !== "inProgress") {
    return { kind: "skip", reason: "not-work-column" };
  }
  if (column.id === before.columnId)
    return { kind: "skip", reason: "not-moved" };
  const holdsOne = (before.children ?? []).some(
    (child) =>
      child.assignee?.isMe === true && !isClosedCategory(child.stateCategory),
  );
  if (holdsOne) return { kind: "skip", reason: "already-mine" };
  return { kind: "create" };
}

/** The new Task's title: the board's own, else the default. */
export function pickupTitle(config: BoardConfig): string {
  if (config.provider !== "azuredevops") return DEFAULT_AUTO_TASK_TITLE;
  return config.autoTask.title.trim() || DEFAULT_AUTO_TASK_TITLE;
}
