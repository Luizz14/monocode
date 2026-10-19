// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AZUREDEVOPS_CHANGE_EVENT } from "../../inbox/model/azureDevOps";
import {
  clearPendingInboxSelfActivity,
  consumeInboxSelfActivity,
} from "../../inbox/model/inboxSelfActivity";
import { LINEAR_CHANGE_EVENT } from "../../inbox/model/linear";
import type {
  AzureBoardChildren,
  AzureBoardItem,
  AzureBoardLayout,
  AzureTeamSetup,
  AzureWorkItemTypeStates,
} from "./azureBoards";
import {
  applyAzureUrlImport,
  parseAzureBoardUrl,
  resolveAzureAreaHints,
} from "./azureBoardUrl";
import { groupCardsByColumn } from "./boardColumns";
import { newBoardConfig } from "./boardConfigs";
import { commitBoardMove } from "./boardMoves";
import {
  BoardLoadError,
  boardSnapshotIsFresh,
  clearBoardCaches,
  forgetBoardSnapshot,
  loadBoardSnapshot,
  patchCachedBoardCard,
  peekBoardSnapshot,
} from "./boardSnapshot";
import type { AzureBoardConfig, LinearBoardConfig } from "./boardTypes";
import type { LinearBoardIssue, LinearBoardStateRow } from "./linearBoards";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const types: AzureWorkItemTypeStates[] = [
  {
    name: "User Story",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
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
      isSplit: false,
      columnType: "inProgress",
    },
    {
      id: "c4",
      name: "Closed",
      itemLimit: 0,
      stateMappings: { "User Story": "Closed" },
      isSplit: false,
      columnType: "outgoing",
    },
  ],
};

const AREA = "TI Banese\\SUTEC App Banese Frontend Manutenção";

const setup: AzureTeamSetup = {
  backlogLevels: [
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
  teamAreas: [{ path: "TI Banese\\SUTEC App Banese", includeChildren: true }],
  defaultArea: "TI Banese\\SUTEC App Banese",
  iterations: [],
  currentIteration: {
    id: "it-42",
    name: "Sprint 42",
    path: "TI Banese\\Sprint 42",
    startDate: "2026-10-06T00:00:00Z",
    finishDate: "2026-10-17T00:00:00Z",
    timeFrame: "current",
  },
};

function azureItem(overrides: Partial<AzureBoardItem>): AzureBoardItem {
  return {
    id: 1,
    rev: 1,
    workItemType: "User Story",
    title: "Item",
    state: "Active",
    reason: null,
    assignedTo: null,
    tags: [],
    effort: null,
    order: null,
    priority: null,
    areaPath: AREA,
    iterationPath: "TI Banese\\Sprint 42",
    changedDate: "2026-10-10T00:00:00Z",
    boardColumn: null,
    boardColumnDone: false,
    project: "TI Banese",
    url: "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/1",
    ...overrides,
  };
}

const azureItems: AzureBoardItem[] = [
  azureItem({
    id: 211,
    title:
      'Flutter - PJ - Incluir validação de localização no pagamento de "DARF"',
    boardColumn: "In Progress",
    effort: 5,
    tags: ["Android", "PJ"],
  }),
  azureItem({
    id: 193,
    workItemType: "Bug",
    title: "Flutter - crash on login",
    boardColumn: "Accepted",
  }),
];

const linearRows: LinearBoardStateRow[] = [
  {
    id: "e-todo",
    name: "Todo",
    type: "unstarted",
    color: "#e2e2e2",
    position: 0,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-doing",
    name: "In Progress",
    type: "started",
    color: "#f2c94c",
    position: 1,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-done",
    name: "Done",
    type: "completed",
    color: "#5e6ad2",
    position: 2,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
];

function linearIssue(
  overrides: Partial<LinearBoardIssue> = {},
): LinearBoardIssue {
  return {
    id: "issue-uuid",
    identifier: "ENG-12",
    number: 12,
    title: "Fix auth",
    url: "https://linear.app/acme/issue/ENG-12/fix-auth",
    stateId: "e-todo",
    stateName: "Todo",
    stateType: "unstarted",
    stateColor: "#e2e2e2",
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
    projectName: "",
    priority: 0,
    priorityLabel: "No priority",
    estimate: null,
    sortOrder: 1,
    cycle: null,
    labels: [],
    assignee: null,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

let azureConnected: boolean;
let linearIsConnected: boolean;
let board: AzureBoardLayout | null;
let teamSetup: AzureTeamSetup;
let movedItem: AzureBoardItem;
let childrenResult: AzureBoardChildren | Error;

const azureChildren: AzureBoardChildren = {
  items: [
    {
      id: 386818,
      parentId: 211,
      workItemType: "Task",
      title: "Em implementação",
      state: "Completed",
      assignedTo: {
        id: "u-me",
        displayName: "Luiz Gustavo Moura",
        uniqueName: "luiz@example.com",
        imageUrl: null,
      },
      changedDate: "2026-10-16T17:18:16Z",
      url: "https://dev.azure.com/BaneseAgile/TI%20Banese/_workitems/edit/386818",
    },
    {
      id: 386819,
      parentId: 211,
      workItemType: "Task",
      title: "Revisão",
      state: "Removed",
      assignedTo: {
        id: "u-t",
        displayName: "Tiago",
        uniqueName: "",
        imageUrl: null,
      },
      changedDate: "2026-10-17T10:00:00Z",
      url: "",
    },
  ],
  types: [
    {
      name: "Task",
      states: [
        { name: "Defined", color: "b2b2b2", category: "Proposed" },
        { name: "In Progress", color: "007acc", category: "InProgress" },
        { name: "Completed", color: "339933", category: "Completed" },
        { name: "Removed", color: "ffffff", category: "Removed" },
      ],
    },
  ],
  truncated: false,
};

const azureFilters = {
  project: "TI Banese",
  team: "SUTEC App Banese",
  backlogLevel: { id: "Microsoft.RequirementCategory", name: "Stories" },
  areaPaths: [{ path: AREA, includeChildren: false }],
  iteration: { kind: "current" as const },
  text: "flutter",
  assignedToMe: false,
  includeDone: false,
};

function azureConfig(
  overrides: Partial<AzureBoardConfig["filters"]> = {},
): AzureBoardConfig {
  return {
    ...newBoardConfig("azuredevops", { ...azureFilters, ...overrides }),
    id: "azure-board",
  };
}

function linearConfig(): LinearBoardConfig {
  return {
    ...newBoardConfig("linear", { teamIds: ["eng"] }),
    id: "linear-board",
  };
}

function commands(): string[] {
  return vi.mocked(invoke).mock.calls.map(([command]) => command);
}

beforeEach(() => {
  clearBoardCaches();
  childrenResult = azureChildren;
  clearPendingInboxSelfActivity();
  azureConnected = true;
  linearIsConnected = true;
  board = layout;
  teamSetup = setup;
  movedItem = azureItem({
    id: 193,
    workItemType: "Bug",
    state: "Active",
    boardColumn: "In Progress",
  });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case "azure_devops_status":
        return {
          connected: azureConnected,
          url: "https://dev.azure.com/BaneseAgile",
          organization: "https://dev.azure.com/baneseagile",
        };
      case "azure_boards_team_setup":
        return teamSetup;
      case "azure_boards_board":
        return { board, types };
      case "azure_boards_query":
        return { items: azureItems, truncated: false };
      case "azure_boards_children":
        if (childrenResult instanceof Error) throw childrenResult;
        return childrenResult;
      case "azure_boards_me":
        return {
          id: "u-me",
          displayName: "Luiz Gustavo Moura",
          uniqueName: "luiz@example.com",
        };
      case "azure_boards_areas":
        return [AREA];
      case "azure_boards_move":
        return movedItem;
      case "linear_status":
        return { connected: linearIsConnected };
      case "linear_boards_states":
        return linearRows;
      case "linear_boards_issues":
        return { items: [linearIssue()], truncated: true };
      case "linear_boards_move": {
        const { stateId } = args as { id: string; stateId: string };
        const row = linearRows.find((entry) => entry.id === stateId)!;
        return linearIssue({
          stateId,
          stateName: row.name,
          stateType: row.type,
        });
      }
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

describe("loadBoardSnapshot for Azure DevOps", () => {
  it("calls the commands in order with the contract's arguments", async () => {
    const snapshot = await loadBoardSnapshot(azureConfig());
    expect(commands()).toEqual([
      "azure_devops_status",
      "azure_boards_team_setup",
      "azure_boards_board",
      "azure_boards_query",
      "azure_boards_children",
      "azure_boards_me",
    ]);
    expect(invoke).toHaveBeenCalledWith("azure_boards_children", {
      project: "TI Banese",
      parentIds: [211, 193],
    });
    expect(invoke).toHaveBeenCalledWith("azure_boards_team_setup", {
      project: "TI Banese",
      team: "SUTEC App Banese",
    });
    expect(invoke).toHaveBeenCalledWith("azure_boards_board", {
      project: "TI Banese",
      team: "SUTEC App Banese",
      backlogLevel: "Stories",
      workItemTypes: ["User Story"],
    });
    expect(invoke).toHaveBeenCalledWith("azure_boards_query", {
      query: expect.objectContaining({ project: "TI Banese", types }),
    });
    expect(snapshot).toMatchObject({
      configId: "azure-board",
      provider: "azuredevops",
      iterationLabel: "Sprint 42",
      doneHidden: true,
      truncated: false,
      limit: 500,
      webUrl:
        "https://dev.azure.com/BaneseAgile/TI%20Banese/_boards/board/t/SUTEC%20App%20Banese/Stories",
      azure: {
        project: "TI Banese",
        team: "SUTEC App Banese",
        backlogLevel: "Stories",
        columnField: "WEF_ABC_Kanban.Column",
        doneField: "WEF_ABC_Kanban.Column.Done",
      },
    });
    expect(snapshot.iterationTitle).toContain("TI Banese\\Sprint 42");
    expect(snapshot.azure?.me).toEqual({
      id: "u-me",
      name: "Luiz Gustavo Moura",
      isMe: true,
    });
    const [story, bug] = snapshot.cards;
    // The story is held by whoever is on its children; the removed child is
    // ignored and the connected user is marked.
    expect(story!.owners).toMatchObject({
      primary: { id: "u-me", name: "Luiz Gustavo Moura", isMe: true },
      others: [],
      source: "children",
    });
    expect(story!.children?.map((child) => child.id)).toEqual([
      386819, 386818,
    ]);
    expect(story!.children?.[0]?.stateCategory).toBe("canceled");
    expect(bug!.children).toEqual([]);
    expect(bug!.owners).toBeUndefined();
  });

  it("keeps the board usable when the children request fails", async () => {
    childrenResult = new Error("TF400898");
    const snapshot = await loadBoardSnapshot(azureConfig());
    const [story] = snapshot.cards;
    expect(story!.children).toBeUndefined();
    expect(story!.owners).toBeUndefined();
    expect(snapshot.azure?.me?.id).toBe("u-me");
    expect(snapshot.azure?.childrenTruncated).toBeUndefined();
  });

  it("skips the children request for an empty board and flags truncation", async () => {
    childrenResult = { ...azureChildren, truncated: true };
    const snapshot = await loadBoardSnapshot(azureConfig());
    expect(snapshot.azure?.childrenTruncated).toBe(true);
    vi.mocked(invoke).mockClear();
    teamSetup = { ...setup, currentIteration: null };
    await loadBoardSnapshot(azureConfig(), "all");
    expect(commands()).not.toContain("azure_boards_children");
  });

  it("uses state columns when the team has no board", async () => {
    board = null;
    const snapshot = await loadBoardSnapshot(azureConfig());
    expect(snapshot.columns.map((column) => column.id)).toEqual([
      "az-state:New",
      "az-state:Active",
      "az-state:Closed",
    ]);
    expect(snapshot.cards.map((card) => card.columnId)).toEqual([
      "az-state:Active",
      "az-state:Active",
    ]);
    expect(invoke).toHaveBeenCalledWith("azure_boards_query", {
      query: expect.objectContaining({ columnField: null, doneField: null }),
    });
  });

  it("shows a notice and skips the query without a current iteration", async () => {
    teamSetup = { ...setup, currentIteration: null };
    const snapshot = await loadBoardSnapshot(azureConfig());
    expect(snapshot.notice).toBe("This team has no current iteration");
    expect(snapshot.cards).toEqual([]);
    expect(commands()).not.toContain("azure_boards_query");
  });

  it("shows a notice and skips the query without any area", async () => {
    teamSetup = { ...setup, teamAreas: [] };
    const snapshot = await loadBoardSnapshot(azureConfig({ areaPaths: [] }));
    expect(snapshot.notice).toBe(
      "This team doesn't scope by area. Pick areas for this board.",
    );
    expect(commands()).not.toContain("azure_boards_query");
  });

  it("refuses an incomplete config without calling anything", async () => {
    await expect(
      loadBoardSnapshot(azureConfig({ team: "" })),
    ).rejects.toMatchObject({
      code: "incomplete",
      message: "Pick a team",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stops at the status check when disconnected", async () => {
    azureConnected = false;
    const error = await loadBoardSnapshot(azureConfig()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BoardLoadError);
    expect(error).toMatchObject({
      code: "not-connected",
      provider: "azuredevops",
    });
    expect(commands()).toEqual(["azure_devops_status"]);
  });
});

describe("snapshot cache", () => {
  it("reuses a cached snapshot and refetches on request", async () => {
    const config = azureConfig();
    const first = await loadBoardSnapshot(config);
    expect(peekBoardSnapshot(config)).toBe(first);
    expect(boardSnapshotIsFresh(first)).toBe(true);
    expect(boardSnapshotIsFresh(first, first.fetchedAt + 3 * 60_000)).toBe(
      false,
    );
    vi.mocked(invoke).mockClear();
    expect(await loadBoardSnapshot(config)).toBe(first);
    expect(invoke).not.toHaveBeenCalled();
    await loadBoardSnapshot(config, "items");
    // The user's identity stays cached across item refreshes.
    expect(commands()).toEqual([
      "azure_devops_status",
      "azure_boards_query",
      "azure_boards_children",
    ]);
    vi.mocked(invoke).mockClear();
    await loadBoardSnapshot(config, "all");
    expect(commands()).toEqual([
      "azure_devops_status",
      "azure_boards_team_setup",
      "azure_boards_board",
      "azure_boards_query",
      "azure_boards_children",
      "azure_boards_me",
    ]);
  });

  it("does not serve a snapshot for a different query", async () => {
    const config = azureConfig();
    await loadBoardSnapshot(config);
    expect(peekBoardSnapshot({ ...config, name: "Renamed" })).not.toBeNull();
    expect(
      peekBoardSnapshot({
        ...config,
        filters: { ...config.filters, includeDone: true },
      }),
    ).toBeNull();
  });

  it("patches and forgets cached cards", async () => {
    const config = azureConfig();
    const first = await loadBoardSnapshot(config);
    const moved = { ...first.cards[0]!, title: "Patched" };
    patchCachedBoardCard(config.id, moved);
    expect(peekBoardSnapshot(config)!.cards[0]!.title).toBe("Patched");
    forgetBoardSnapshot(config.id);
    expect(peekBoardSnapshot(config)).toBeNull();
  });

  it("clears on provider change events", async () => {
    const azure = azureConfig();
    const linear = linearConfig();
    await loadBoardSnapshot(azure);
    await loadBoardSnapshot(linear);
    window.dispatchEvent(new Event(AZUREDEVOPS_CHANGE_EVENT));
    expect(peekBoardSnapshot(azure)).toBeNull();
    expect(peekBoardSnapshot(linear)).not.toBeNull();
    vi.mocked(invoke).mockClear();
    await loadBoardSnapshot(azure);
    // Team setup and board metadata were dropped too.
    expect(commands()).toContain("azure_boards_team_setup");
    window.dispatchEvent(new Event(LINEAR_CHANGE_EVENT));
    expect(peekBoardSnapshot(linear)).toBeNull();
    expect(peekBoardSnapshot(azure)).not.toBeNull();
  });

  it("does not cache a load that a clear overtook", async () => {
    const config = azureConfig();
    let release!: () => void;
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "azure_boards_query") {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return original(command, args);
    });
    const pending = loadBoardSnapshot(config);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    clearBoardCaches("azuredevops");
    release();
    await pending;
    expect(peekBoardSnapshot(config)).toBeNull();
  });
});

describe("loadBoardSnapshot for Linear", () => {
  it("loads states and issues together", async () => {
    const snapshot = await loadBoardSnapshot(linearConfig());
    expect(commands()).toEqual([
      "linear_status",
      "linear_boards_states",
      "linear_boards_issues",
    ]);
    expect(invoke).toHaveBeenCalledWith("linear_boards_states", {
      teamIds: ["eng"],
    });
    expect(invoke).toHaveBeenCalledWith("linear_boards_issues", {
      query: {
        teamIds: ["eng"],
        assignedToMe: false,
        activeCycleOnly: false,
        includeDone: false,
        limit: 250,
      },
    });
    expect(snapshot).toMatchObject({
      provider: "linear",
      truncated: true,
      limit: 250,
      webUrl: "https://linear.app/acme/team/ENG/active",
      linear: { multiTeam: false },
    });
    expect(snapshot.columns.map((column) => column.id)).toEqual([
      "ln:e-todo",
      "ln:e-doing",
      "ln:e-done",
    ]);
    expect(snapshot.cards[0]!.columnId).toBe("ln:e-todo");
  });

  it("stops when Linear is disconnected", async () => {
    linearIsConnected = false;
    await expect(loadBoardSnapshot(linearConfig())).rejects.toMatchObject({
      code: "not-connected",
    });
    expect(commands()).toEqual(["linear_status"]);
  });
});

describe("commitBoardMove", () => {
  it("moves an Azure card and records self activity", async () => {
    const snapshot = await loadBoardSnapshot(azureConfig());
    const bug = snapshot.cards.find((card) => card.number === 193)!;
    expect(bug.columnId).toBe("az:c2");
    const target = snapshot.columns.find((column) => column.id === "az:c3")!;
    const moved = await commitBoardMove(snapshot, bug, target);
    expect(invoke).toHaveBeenCalledWith("azure_boards_move", {
      request: {
        project: "TI Banese",
        id: 193,
        state: null,
        columnField: "WEF_ABC_Kanban.Column",
        column: "In Progress",
        doneField: null,
        done: null,
        orderField: "Microsoft.VSTS.Common.StackRank",
        effortField: "Microsoft.VSTS.Scheduling.StoryPoints",
      },
    });
    expect(moved.columnId).toBe("az:c3");
    expect(moved.order).toBe(bug.order);
    expect(
      consumeInboxSelfActivity({
        provider: "azuredevops",
        kind: "issue",
        repo: "TI Banese",
        number: 193,
        projectPath: "",
      }),
    ).toBe(true);
  });

  it("places the card where the server's state says", async () => {
    const snapshot = await loadBoardSnapshot(azureConfig());
    const story = snapshot.cards.find((card) => card.number === 211)!;
    movedItem = azureItem({ id: 211, state: "New", boardColumn: "New" });
    const moved = await commitBoardMove(
      snapshot,
      story,
      snapshot.columns.find((column) => column.id === "az:c4")!,
    );
    expect(moved.columnId).toBe("az:c1");
  });

  it("refuses a column that does not map the card's type", async () => {
    const snapshot = await loadBoardSnapshot(azureConfig());
    const bug = snapshot.cards.find((card) => card.number === 193)!;
    await expect(
      commitBoardMove(
        snapshot,
        bug,
        snapshot.columns.find((column) => column.id === "az:c4")!,
      ),
    ).rejects.toThrow("Can't move to “Closed”");
    expect(commands()).not.toContain("azure_boards_move");
  });

  it("moves a Linear issue and records self activity", async () => {
    const snapshot = await loadBoardSnapshot(linearConfig());
    const moved = await commitBoardMove(
      snapshot,
      snapshot.cards[0]!,
      snapshot.columns[1]!,
    );
    expect(invoke).toHaveBeenCalledWith("linear_boards_move", {
      id: "issue-uuid",
      stateId: "e-doing",
    });
    expect(moved).toMatchObject({
      columnId: "ln:e-doing",
      state: "In Progress",
    });
    expect(
      consumeInboxSelfActivity({
        provider: "linear",
        kind: "linear",
        id: "issue-uuid",
        number: 12,
        projectPath: "",
      }),
    ).toBe(true);
  });
});

describe("end to end from the user's link", () => {
  it("imports the link, queries with it and places cards", async () => {
    const link =
      "https://dev.azure.com/BaneseAgile/TI%20Banese/_backlogs/backlog/SUTEC%20App%20Banese/Stories" +
      "?text=flutter&System.AreaPath=SUTEC%20App%20Banese%20Frontend%20Manuten%C3%A7%C3%A3o" +
      "&System.IterationPath=%40CurrentIteration(%27%5BTI%20Banese%5D%5CSUTEC%20App%20Banese%20%3Cid%3Ax%3E%27)";
    const parsed = parseAzureBoardUrl(link)!;
    const draft = newBoardConfig("azuredevops");
    const resolved = resolveAzureAreaHints(parsed.areaPathHints, [
      "TI Banese",
      "TI Banese\\SUTEC App Banese",
      AREA,
    ]);
    const config: AzureBoardConfig = {
      ...draft,
      filters: applyAzureUrlImport(draft.filters, parsed, resolved),
    };

    const snapshot = await loadBoardSnapshot(config);
    expect(invoke).toHaveBeenCalledWith("azure_boards_query", {
      query: {
        project: "TI Banese",
        team: "SUTEC App Banese",
        types,
        areaPaths: [{ path: AREA, includeChildren: false }],
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
    const grouped = groupCardsByColumn(snapshot.columns, snapshot.cards);
    expect(grouped.get("az:c2")!.map((card) => card.ref)).toEqual(["#193"]);
    expect(grouped.get("az:c3")!.map((card) => card.title)).toEqual([
      'Flutter - PJ - Incluir validação de localização no pagamento de "DARF"',
    ]);
    expect(grouped.get("az:c3")![0]).toMatchObject({
      type: "User Story",
      effort: 5,
      tags: [{ name: "Android" }, { name: "PJ" }],
    });
  });
});
