import type { InboxItem } from "../../inbox/model/githubTasks";
import { isClosedCategory, type BoardCard } from "./boardTypes";

/**
 * The card as an Inbox item, so "Start chat" can reuse `onStartInboxItem`.
 * `projectPath` is empty: starting falls back to the active project.
 */
export function boardCardToInboxItem(card: BoardCard): InboxItem {
  const labels = card.tags.map((tag) => ({
    name: tag.name,
    color: tag.color?.replace(/^#/, "") ?? "",
  }));
  const assignees = card.assignee
    ? [
        card.assignee.avatarUrl
          ? { login: card.assignee.name, avatarUrl: card.assignee.avatarUrl }
          : { login: card.assignee.name },
      ]
    : [];
  if (card.provider === "azuredevops") {
    return {
      provider: "azuredevops",
      kind: "issue",
      number: card.number,
      title: card.title,
      url: card.url,
      state: isClosedCategory(card.stateCategory) ? "closed" : "open",
      updatedAt: card.updatedAt,
      labels,
      assignees,
      draft: false,
      repo: card.project,
      projectPath: "",
    };
  }
  const item: InboxItem = {
    provider: "linear",
    kind: "linear",
    id: card.id,
    identifier: card.ref,
    number: card.number,
    title: card.title,
    url: card.url,
    state: card.state,
    updatedAt: card.updatedAt,
    labels,
    assignees,
    draft: false,
    repo: card.teamKey ?? "",
    projectPath: "",
  };
  if (card.stateType) item.stateType = card.stateType;
  if (card.teamId) item.teamId = card.teamId;
  if (card.teamName) item.teamName = card.teamName;
  if (card.project) item.projectName = card.project;
  return item;
}
