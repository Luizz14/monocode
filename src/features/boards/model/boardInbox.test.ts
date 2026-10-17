import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inboxComposerCard,
  inboxItemKey,
  type InboxItem,
} from "../../inbox/model/githubTasks";
import { inboxTrackerDescription } from "../../inbox/model/inboxContext";
import { boardCardToInboxItem } from "./boardInbox";
import type { BoardCard } from "./boardTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const azureCard: BoardCard = {
  provider: "azuredevops",
  key: "azuredevops:123",
  id: "123",
  ref: "#123",
  number: 123,
  title: "Fix DARF payment",
  url: "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/123",
  type: "Bug",
  state: "Active",
  stateCategory: "inProgress",
  columnId: "az:c2",
  tags: [{ name: "Android" }, { name: "PJ", color: "#ff0000" }],
  assignee: { name: "Luiz Santos" },
  project: "TI Banese",
  order: 0,
  updatedAt: "2026-10-10T00:00:00Z",
};

const linearCard: BoardCard = {
  provider: "linear",
  key: "linear:issue-uuid",
  id: "issue-uuid",
  ref: "ENG-12",
  number: 12,
  title: "Fix auth",
  url: "https://linear.app/acme/issue/ENG-12/fix-auth",
  state: "In Progress",
  stateId: "e-doing",
  stateType: "started",
  stateCategory: "inProgress",
  columnId: "ln:e-doing",
  tags: [{ name: "Bug", color: "#eb5757" }],
  project: "Auth",
  teamId: "eng",
  teamKey: "ENG",
  teamName: "Engineering",
  order: 1,
  updatedAt: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "linear_issue_details") {
      return { body: "Steps to reproduce", author: "maya" };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("boardCardToInboxItem", () => {
  it("turns an Azure card into an Inbox work item", () => {
    const item = boardCardToInboxItem(azureCard);
    expect(item).toMatchObject({
      provider: "azuredevops",
      kind: "issue",
      number: 123,
      repo: "TI Banese",
      state: "open",
      projectPath: "",
      labels: [
        { name: "Android", color: "" },
        { name: "PJ", color: "ff0000" },
      ],
      assignees: [{ login: "Luiz Santos" }],
    });
    const card = inboxComposerCard(item);
    expect(card.identifier).toBe("#123");
    expect(card.source).toBe("TI Banese");
    expect(card.prompt).toContain("#123 Fix DARF payment");
    expect(
      boardCardToInboxItem({ ...azureCard, stateCategory: "done" }).state,
    ).toBe("closed");
  });

  it("keys Azure items like the Inbox does", () => {
    // What the Inbox builds from `azure_devops_list_work_items` for the same item.
    const fromInbox: InboxItem = {
      provider: "azuredevops",
      kind: "issue",
      number: 123,
      title: "Fix DARF payment",
      url: azureCard.url,
      state: "Active",
      updatedAt: azureCard.updatedAt,
      labels: [],
      assignees: [],
      draft: false,
      repo: "TI Banese",
      projectPath: "/Users/me/app",
    };
    expect(inboxItemKey(boardCardToInboxItem(azureCard))).toBe(
      inboxItemKey(fromInbox),
    );
  });

  it("turns a Linear card into an Inbox issue", async () => {
    const item = boardCardToInboxItem(linearCard);
    expect(item).toMatchObject({
      provider: "linear",
      kind: "linear",
      id: "issue-uuid",
      identifier: "ENG-12",
      stateType: "started",
      teamId: "eng",
      teamName: "Engineering",
      projectName: "Auth",
      repo: "ENG",
      projectPath: "",
      labels: [{ name: "Bug", color: "eb5757" }],
    });
    expect(inboxItemKey(item)).toBe("linear:eng-12");
    expect(inboxComposerCard(item).identifier).toBe("ENG-12");
    expect(await inboxTrackerDescription(item)).toBe("Steps to reproduce");
    expect(invoke).toHaveBeenCalledWith("linear_issue_details", {
      id: "issue-uuid",
    });
  });
});
