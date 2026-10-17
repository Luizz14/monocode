import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AZURE_NO_AREA_NOTICE,
  azureBoardMeta,
  azureBoardWebUrl,
  azureCardColumnId,
  azureItemToCard,
  azureQueryArgs,
  azureStateInfo,
  azureTeamSetup,
  buildAzureBoardColumns,
  buildAzureStateColumns,
  clearAzureBoardsCache,
  pickBacklogLevel,
  resolveAzureMove,
  type AzureBoardItem,
  type AzureBoardLayout,
  type AzureBoardMeta,
  type AzureTeamSetup,
  type AzureWorkItemTypeStates,
} from "./azureBoards";
import type { AzureBoardFilters, BoardCard } from "./boardTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const types: AzureWorkItemTypeStates[] = [
  {
    name: "User Story",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
      { name: "Resolved", color: "ff9d00", category: "Resolved" },
      { name: "Closed", color: "339933", category: "Completed" },
      { name: "Removed", color: "ffffff", category: "Removed" },
    ],
  },
  {
    name: "Bug",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
      { name: "Closed", color: "339933", category: "Completed" },
    ],
  },
];

const layout: AzureBoardLayout = {
  id: "board-1",
  name: "Stories",
  columnField: "WEF_ABC_Kanban.Column",
  doneField: "WEF_ABC_Kanban.Column.Done",
  columns: [
    {
      id: "c1",
      name: "New",
      itemLimit: 0,
      stateMappings: { "User Story": "New", Bug: "New" },
      isSplit: false,
      columnType: "incoming",
    },
    {
      id: "c2",
      name: "Accepted",
      itemLimit: 5,
      stateMappings: { "User Story": "Active", Bug: "Active" },
      isSplit: false,
      columnType: "inProgress",
    },
    {
      id: "c3",
      name: "In Progress",
      itemLimit: 3,
      stateMappings: { "User Story": "Active", Bug: "Active" },
      isSplit: true,
      columnType: "inProgress",
    },
    {
      id: "c4",
      name: "Review",
      itemLimit: 0,
      stateMappings: { "User Story": "Resolved" },
      isSplit: false,
      columnType: "inProgress",
    },
    {
      id: "c5",
      name: "Closed",
      itemLimit: 0,
      stateMappings: { "User Story": "Closed", Bug: "Closed" },
      isSplit: false,
      columnType: "outgoing",
    },
  ],
};

const info = azureStateInfo(types);
const columns = buildAzureBoardColumns(layout, info);
const fields = {
  columnField: layout.columnField,
  doneField: layout.doneField,
};

/** Same shape as the Rust `AzureBoardItem` camelCase serialization test. */
function item(overrides: Partial<AzureBoardItem> = {}): AzureBoardItem {
  return {
    id: 193,
    rev: 7,
    workItemType: "Bug",
    title: "Flutter - PJ - Fix DARF payment",
    state: "Active",
    reason: "Approved",
    assignedTo: {
      displayName: "Luiz Santos",
      uniqueName: "luiz@example.com",
      imageUrl: "https://dev.azure.com/_apis/GraphProfile/avatar",
    },
    tags: ["Android", " PJ ", ""],
    effort: 5,
    order: 1999.5,
    priority: 2,
    areaPath: "TI Banese\\SUTEC App Banese Frontend Manutenção",
    iterationPath: "TI Banese\\Sprint 42",
    changedDate: "2026-10-10T12:00:00Z",
    boardColumn: "In Progress",
    boardColumnDone: false,
    project: "TI Banese",
    url: "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/193",
    ...overrides,
  };
}

function card(overrides: Partial<AzureBoardItem> = {}): BoardCard {
  return azureItemToCard(item(overrides), columns, info, 0);
}

const setup: AzureTeamSetup = {
  backlogLevels: [
    {
      id: "Microsoft.FeatureCategory",
      name: "Features",
      rank: 2,
      kind: "portfolio",
      workItemTypes: ["Feature"],
      defaultWorkItemType: "Feature",
      isHidden: false,
    },
    {
      id: "Microsoft.RequirementCategory",
      name: "Stories",
      rank: 1,
      kind: "requirement",
      workItemTypes: ["User Story"],
      defaultWorkItemType: "User Story",
      isHidden: false,
    },
  ],
  orderField: "Microsoft.VSTS.Common.StackRank",
  effortField: "Microsoft.VSTS.Scheduling.StoryPoints",
  bugsBehavior: "asRequirements",
  teamAreas: [{ path: "TI Banese\\SUTEC", includeChildren: true }],
  defaultArea: "TI Banese\\SUTEC",
  iterations: [],
  currentIteration: null,
};

const filters: AzureBoardFilters = {
  project: " TI Banese ",
  team: "SUTEC App Banese",
  backlogLevel: { id: "Microsoft.RequirementCategory", name: "Stories" },
  areaPaths: [],
  iteration: { kind: "current" },
  text: "flutter",
  assignedToMe: false,
  includeDone: false,
};

describe("Azure board columns", () => {
  it("keeps board order and splits Doing and Done halves", () => {
    expect(columns.map((column) => column.id)).toEqual([
      "az:c1",
      "az:c2",
      "az:c3:doing",
      "az:c3:done",
      "az:c4",
      "az:c5",
    ]);
    const [doing, done] = [columns[2]!, columns[3]!];
    expect(doing).toMatchObject({
      groupId: "az:c3",
      title: "In Progress",
      subtitle: "Doing",
      wipLimit: 3,
      category: "inProgress",
      color: "#007acc",
      target: {
        provider: "azuredevops",
        boardColumn: "In Progress",
        split: "doing",
      },
    });
    expect(done).toMatchObject({
      groupId: "az:c3",
      subtitle: "Done",
      wipLimit: 3,
      target: { split: "done" },
    });
  });

  it("carries WIP limits and categories", () => {
    expect(columns[0]).not.toHaveProperty("wipLimit");
    expect(columns[1]!.wipLimit).toBe(5);
    expect(columns[0]!.category).toBe("todo");
    expect(columns[4]!.category).toBe("resolved");
    expect(columns[5]!.category).toBe("done");
  });

  it("falls back to one column per state, ordered by category, without Removed", () => {
    const fallback = buildAzureStateColumns(types, info);
    expect(fallback.map((column) => column.id)).toEqual([
      "az-state:New",
      "az-state:Active",
      "az-state:Resolved",
      "az-state:Closed",
    ]);
    expect(fallback[0]!.target).toEqual({
      provider: "azuredevops",
      stateMappings: { "User Story": "New", Bug: "New" },
      boardColumn: null,
      split: null,
    });
    expect(fallback[2]!.target).toMatchObject({
      stateMappings: { "User Story": "Resolved" },
    });
  });
});

describe("azureCardColumnId", () => {
  it("uses the board column when it maps the state", () => {
    expect(azureCardColumnId(item(), columns)).toBe("az:c3:doing");
  });

  it("picks the Done half from boardColumnDone", () => {
    expect(azureCardColumnId(item({ boardColumnDone: true }), columns)).toBe(
      "az:c3:done",
    );
  });

  it("ignores a board column that no longer maps the state", () => {
    expect(
      azureCardColumnId(item({ boardColumn: "New", state: "Active" }), columns),
    ).toBe("az:c2");
  });

  it("falls back to the first column mapping the type's state", () => {
    expect(azureCardColumnId(item({ boardColumn: null }), columns)).toBe(
      "az:c2",
    );
  });

  it("falls back to any column mapping the state", () => {
    expect(
      azureCardColumnId(
        item({ boardColumn: null, workItemType: "Task", state: "Resolved" }),
        columns,
      ),
    ).toBe("az:c4");
  });

  it("lands in Other when nothing maps the state", () => {
    expect(
      azureCardColumnId(item({ boardColumn: null, state: "Blocked" }), columns),
    ).toBe("other");
  });
});

describe("azureItemToCard", () => {
  it("builds a card from the serialized command output", () => {
    expect(azureItemToCard(item(), columns, info, 4)).toEqual({
      provider: "azuredevops",
      key: "azuredevops:193",
      id: "193",
      ref: "#193",
      number: 193,
      title: "Flutter - PJ - Fix DARF payment",
      url: "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/193",
      type: "Bug",
      state: "Active",
      stateCategory: "inProgress",
      stateColor: "#007acc",
      columnId: "az:c3:doing",
      boardColumn: "In Progress",
      boardColumnDone: false,
      assignee: { name: "Luiz Santos" },
      effort: 5,
      tags: [{ name: "Android" }, { name: "PJ" }],
      priority: { value: 2, label: "Priority 2" },
      iteration: "TI Banese\\Sprint 42",
      area: "TI Banese\\SUTEC App Banese Frontend Manutenção",
      project: "TI Banese",
      order: 4,
      updatedAt: "2026-10-10T12:00:00Z",
      rev: 7,
    });
  });

  it("leaves out missing optional values", () => {
    const result = azureItemToCard(
      item({
        assignedTo: null,
        effort: null,
        priority: null,
        boardColumn: null,
      }),
      columns,
      info,
      0,
    );
    expect(result).not.toHaveProperty("assignee");
    expect(result).not.toHaveProperty("effort");
    expect(result).not.toHaveProperty("priority");
    expect(result).not.toHaveProperty("boardColumn");
  });
});

describe("resolveAzureMove", () => {
  const byId = (id: string) => columns.find((column) => column.id === id)!;

  it("writes state and column", () => {
    expect(resolveAzureMove(card(), byId("az:c5"), fields)).toEqual({
      state: "Closed",
      column: "Closed",
      done: null,
    });
  });

  it("keeps an unchanged state out", () => {
    expect(resolveAzureMove(card(), byId("az:c2"), fields)).toEqual({
      state: null,
      column: "Accepted",
      done: null,
    });
  });

  it("rejects a column without a state for the type", () => {
    expect(resolveAzureMove(card(), byId("az:c4"), fields)).toEqual({
      error: "not-allowed",
    });
  });

  it("rejects the current column", () => {
    expect(resolveAzureMove(card(), byId("az:c3:doing"), fields)).toEqual({
      error: "same-column",
    });
  });

  it("sets done on the Done half", () => {
    expect(resolveAzureMove(card(), byId("az:c3:done"), fields)).toEqual({
      state: null,
      column: null,
      done: true,
    });
  });

  it("clears done when leaving a Done half for a plain column", () => {
    expect(
      resolveAzureMove(card({ boardColumnDone: true }), byId("az:c5"), fields),
    ).toEqual({ state: "Closed", column: "Closed", done: false });
  });

  it("never touches done without a done field", () => {
    expect(
      resolveAzureMove(card({ boardColumnDone: true }), byId("az:c5"), {
        columnField: layout.columnField,
        doneField: null,
      }),
    ).toEqual({ state: "Closed", column: "Closed", done: null });
    expect(
      resolveAzureMove(card(), byId("az:c3:done"), {
        columnField: layout.columnField,
        doneField: null,
      }),
    ).toEqual({ error: "same-column" });
  });

  it("moves between state fallback columns by state only", () => {
    const fallback = buildAzureStateColumns(types, info);
    const fallbackCard = azureItemToCard(
      item({ boardColumn: null }),
      fallback,
      info,
      0,
    );
    expect(fallbackCard.columnId).toBe("az-state:Active");
    expect(
      resolveAzureMove(fallbackCard, fallback[3]!, {
        columnField: null,
        doneField: null,
      }),
    ).toEqual({ state: "Closed", column: null, done: null });
  });
});

describe("azureQueryArgs", () => {
  const meta: AzureBoardMeta = { board: layout, types };

  it("defaults to the team's areas and passes types intact", () => {
    const result = azureQueryArgs(filters, setup, meta);
    expect(result).toEqual({
      query: {
        project: "TI Banese",
        team: "SUTEC App Banese",
        types,
        areaPaths: [{ path: "TI Banese\\SUTEC", includeChildren: true }],
        iteration: { kind: "current" },
        assignedToMe: false,
        includeDone: false,
        orderField: "Microsoft.VSTS.Common.StackRank",
        effortField: "Microsoft.VSTS.Scheduling.StoryPoints",
        columnField: "WEF_ABC_Kanban.Column",
        doneField: "WEF_ABC_Kanban.Column.Done",
        limit: 500,
      },
    });
    expect("query" in result && result.query.types).toBe(types);
  });

  it("sends null instead of empty strings", () => {
    const result = azureQueryArgs(
      {
        ...filters,
        areaPaths: [{ path: "TI Banese\\Other", includeChildren: false }],
      },
      { ...setup, orderField: "", effortField: null },
      { board: null, types },
    );
    expect(result).toMatchObject({
      query: {
        areaPaths: [{ path: "TI Banese\\Other", includeChildren: false }],
        orderField: null,
        effortField: null,
        columnField: null,
        doneField: null,
      },
    });
  });

  it("refuses to query without areas or team areas", () => {
    expect(azureQueryArgs(filters, { ...setup, teamAreas: [] }, meta)).toEqual({
      error: AZURE_NO_AREA_NOTICE,
    });
  });
});

describe("Azure command wrappers", () => {
  beforeEach(() => {
    clearAzureBoardsCache();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "azure_boards_team_setup") return setup;
      if (command === "azure_boards_board") return { board: layout, types };
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("caches team setup and shares a request in flight", async () => {
    const [a, b] = await Promise.all([
      azureTeamSetup("TI Banese", "SUTEC"),
      azureTeamSetup(" TI Banese ", "SUTEC"),
    ]);
    expect(a).toBe(b);
    await azureTeamSetup("TI Banese", "SUTEC");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("azure_boards_team_setup", {
      project: "TI Banese",
      team: "SUTEC",
    });
    await azureTeamSetup("TI Banese", "SUTEC", { force: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("passes the level name and types to the board command", async () => {
    await azureBoardMeta("TI Banese", "SUTEC", setup.backlogLevels[1]!);
    expect(invoke).toHaveBeenCalledWith("azure_boards_board", {
      project: "TI Banese",
      team: "SUTEC",
      backlogLevel: "Stories",
      workItemTypes: ["User Story"],
    });
  });
});

describe("Azure helpers", () => {
  it("picks a backlog level by id, then name", () => {
    expect(
      pickBacklogLevel(setup.backlogLevels, { id: "x", name: "stories" })?.id,
    ).toBe("Microsoft.RequirementCategory");
    expect(
      pickBacklogLevel(setup.backlogLevels, {
        id: "Microsoft.FeatureCategory",
        name: "Stories",
      })?.name,
    ).toBe("Features");
    expect(
      pickBacklogLevel(setup.backlogLevels, { id: "", name: "" })?.name,
    ).toBe("Stories");
    expect(
      pickBacklogLevel(setup.backlogLevels, { id: "x", name: "y" }),
    ).toBeNull();
  });

  it("builds the web board URL", () => {
    expect(
      azureBoardWebUrl(
        "https://dev.azure.com/BaneseAgile/",
        "TI Banese",
        "SUTEC App Banese",
        "Stories",
      ),
    ).toBe(
      "https://dev.azure.com/BaneseAgile/TI%20Banese/_boards/board/t/SUTEC%20App%20Banese/Stories",
    );
    expect(azureBoardWebUrl("", "p", "t", "l")).toBeNull();
  });
});
