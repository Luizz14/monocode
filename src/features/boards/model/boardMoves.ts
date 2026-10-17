import { recordInboxSelfActivity } from "../../inbox/model/inboxSelfActivity";
import { azureItemToCard, azureStateMeta, moveAzureCard } from "./azureBoards";
import { resolveBoardMove } from "./boardColumns";
import {
  linearStateCategory,
  normalizeHexColor,
  ownValue,
  type BoardCard,
  type BoardColumn,
  type BoardSnapshot,
} from "./boardTypes";
import { linearIssueToCard, moveLinearCard } from "./linearBoards";

/** The card as it should look in `column` before the provider answers. */
export function optimisticPlacement(
  snapshot: BoardSnapshot,
  card: BoardCard,
  column: BoardColumn,
): BoardCard {
  const target = column.target;
  if (target.provider === "azuredevops") {
    const state = ownValue(target.stateMappings, card.type) ?? card.state;
    const meta = snapshot.azure
      ? azureStateMeta(snapshot.azure.stateInfo, card.type, state)
      : undefined;
    const next: BoardCard = {
      ...card,
      columnId: column.id,
      state,
      stateCategory: meta?.category ?? card.stateCategory,
      boardColumnDone: target.split === "done",
    };
    if (meta?.color) next.stateColor = meta.color;
    if (target.boardColumn) next.boardColumn = target.boardColumn;
    return next;
  }
  if (target.provider === "linear") {
    const state = ownValue(target.statesByTeam, card.teamId);
    if (!state) return { ...card, columnId: column.id };
    const next: BoardCard = {
      ...card,
      columnId: column.id,
      state: state.name,
      stateId: state.id,
      stateType: state.type,
      stateCategory: linearStateCategory(state.type),
    };
    const color = normalizeHexColor(state.color);
    if (color) next.stateColor = color;
    return next;
  }
  return { ...card, columnId: column.id };
}

export class BoardMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardMoveError";
  }
}

/**
 * Writes the move to the provider and returns the card as the provider now
 * reports it. The column is recomputed from that answer because a process
 * rule may have picked a different state. Azure cards keep their list
 * position (Azure order is the query position); Linear uses `sortOrder`.
 */
export async function commitBoardMove(
  snapshot: BoardSnapshot,
  card: BoardCard,
  column: BoardColumn,
): Promise<BoardCard> {
  const resolution = resolveBoardMove(snapshot, card, column);
  if ("error" in resolution) {
    throw new BoardMoveError(
      resolution.error === "same-column"
        ? `Already in “${column.title}”`
        : `Can't move to “${column.title}”`,
    );
  }
  const { plan } = resolution;
  if (plan.provider === "azuredevops") {
    const azure = snapshot.azure;
    if (!azure) throw new BoardMoveError("This board isn't loaded yet");
    const item = await moveAzureCard({
      project: card.project || azure.project,
      id: card.number,
      state: plan.state,
      columnField: plan.column !== null ? azure.columnField : null,
      column: plan.column,
      doneField: plan.done !== null ? azure.doneField : null,
      done: plan.done,
      orderField: azure.orderField,
      effortField: azure.effortField,
    });
    recordInboxSelfActivity({
      provider: "azuredevops",
      kind: "issue",
      repo: item.project || card.project,
      number: item.id,
    });
    return azureItemToCard(item, snapshot.columns, azure.stateInfo, card.order);
  }
  const issue = await moveLinearCard(card.id, plan.stateId);
  recordInboxSelfActivity({ provider: "linear", kind: "linear", id: issue.id });
  return linearIssueToCard(issue, snapshot.columns);
}
