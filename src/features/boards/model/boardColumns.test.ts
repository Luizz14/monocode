import { describe, expect, it } from "vitest";
import {
  azureItemToCard,
  azureStateInfo,
  buildAzureBoardColumns,
  type AzureBoardItem,
  type AzureBoardLayout,
  type AzureWorkItemTypeStates,
} from "./azureBoards";
import {
  OTHER_COLUMN_ID,
  adjacentMoveTarget,
  columnLoad,
  dropVerdict,
  groupCardsByColumn,
  resolveBoardMove,
  sortBoardCards,
  withOtherColumn,
} from "./boardColumns";
import { optimisticPlacement } from "./boardMoves";
import type { BoardCard, BoardSnapshot } from "./boardTypes";
import {
  cardAriaLabel,
  columnAriaLabel,
  columnCountLabel,
  focusNeighbor,
} from "./boardView";

const types: AzureWorkItemTypeStates[] = [
  {
    name: "User Story",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
      { name: "Resolved", color: "ff9d00", category: "Resolved" },
      { name: "Closed", color: "339933", category: "Completed" },
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
  id: "b",
  name: "Stories",
  columnField: "WEF_X_Kanban.Column",
  doneField: "WEF_X_Kanban.Column.Done",
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
      name: "Doing",
      itemLimit: 2,
      stateMappings: { "User Story": "Active", Bug: "Active" },
      isSplit: true,
      columnType: "inProgress",
    },
    {
      id: "c3",
      name: "Review",
      itemLimit: 0,
      stateMappings: { "User Story": "Resolved" },
      isSplit: false,
      columnType: "inProgress",
    },
    {
      id: "c4",
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

function item(
  id: number,
  overrides: Partial<AzureBoardItem> = {},
): AzureBoardItem {
  return {
    id,
    rev: 1,
    workItemType: "Bug",
    title: `Item ${id}`,
    state: "Active",
    reason: null,
    assignedTo: null,
    tags: [],
    effort: null,
    order: null,
    priority: null,
    areaPath: "",
    iterationPath: "",
    changedDate: "2026-10-01T00:00:00Z",
    boardColumn: "Doing",
    boardColumnDone: false,
    project: "P",
    url: "",
    ...overrides,
  };
}

const cards: BoardCard[] = [
  azureItemToCard(item(1), columns, info, 0),
  azureItemToCard(item(2, { boardColumnDone: true }), columns, info, 1),
  azureItemToCard(
    item(3, { boardColumnDone: true, workItemType: "User Story" }),
    columns,
    info,
    2,
  ),
  azureItemToCard(
    item(4, { state: "Blocked", boardColumn: null }),
    columns,
    info,
    3,
  ),
];

const snapshot: BoardSnapshot = {
  configId: "a",
  queryKey: "q",
  provider: "azuredevops",
  columns: withOtherColumn(columns, cards),
  cards,
  truncated: false,
  doneHidden: true,
  webUrl: null,
  fetchedAt: 0,
  limit: 500,
  azure: {
    project: "P",
    team: "T",
    backlogLevel: "Stories",
    columnField: layout.columnField,
    doneField: layout.doneField,
    orderField: null,
    effortField: null,
    stateInfo: info,
  },
};

const column = (id: string) =>
  snapshot.columns.find((entry) => entry.id === id)!;

describe("board columns", () => {
  it("adds Other only when a card needs it", () => {
    expect(snapshot.columns.map((entry) => entry.id)).toEqual([
      "az:c1",
      "az:c2:doing",
      "az:c2:done",
      "az:c3",
      "az:c4",
      OTHER_COLUMN_ID,
    ]);
    expect(
      withOtherColumn(columns, cards.slice(0, 3)).map((entry) => entry.id),
    ).not.toContain(OTHER_COLUMN_ID);
  });

  it("sorts by order, then most recent", () => {
    const a = { ...cards[0]!, order: 1, updatedAt: "2026-01-01T00:00:00Z" };
    const b = { ...cards[1]!, order: 1, updatedAt: "2026-02-01T00:00:00Z" };
    const c = { ...cards[2]!, order: 0 };
    expect(sortBoardCards([a, b, c])).toEqual([c, b, a]);
  });

  it("groups cards and counts WIP across split halves", () => {
    const grouped = groupCardsByColumn(snapshot.columns, cards);
    expect(grouped.get("az:c2:doing")!.map((card) => card.number)).toEqual([1]);
    expect(grouped.get("az:c2:done")!.map((card) => card.number)).toEqual([
      2, 3,
    ]);
    expect(grouped.get(OTHER_COLUMN_ID)!.map((card) => card.number)).toEqual([
      4,
    ]);
    expect(grouped.get("az:c1")).toEqual([]);
    const load = columnLoad(column("az:c2:doing"), snapshot.columns, grouped);
    expect(load).toEqual({ count: 1, groupCount: 3, limit: 2, over: true });
    expect(columnCountLabel(load)).toBe("3/2");
    const plain = columnLoad(column("az:c1"), snapshot.columns, grouped);
    expect(plain).toEqual({
      count: 0,
      groupCount: 0,
      limit: null,
      over: false,
    });
    expect(columnCountLabel(plain)).toBe("0");
    expect(columnAriaLabel(column("az:c2:doing"), load)).toBe(
      "Doing, Doing, 1 item, over the limit of 2",
    );
  });
});

describe("drop rules", () => {
  const bug = cards[0]!;

  it("allows mapped columns and explains the rest", () => {
    expect(dropVerdict(snapshot, bug, column("az:c4"))).toEqual({ kind: "ok" });
    expect(dropVerdict(snapshot, bug, column("az:c2:doing"))).toEqual({
      kind: "same",
    });
    expect(dropVerdict(snapshot, bug, column("az:c3"))).toEqual({
      kind: "disallowed",
      reason: "No “Review” state for Bug",
    });
    expect(dropVerdict(snapshot, bug, column(OTHER_COLUMN_ID))).toEqual({
      kind: "disallowed",
      reason: "Cards can't be moved to “Other”",
    });
    expect(dropVerdict(snapshot, bug, column("az:c4"), true)).toEqual({
      kind: "disallowed",
      reason: "This card is still moving",
    });
  });

  it("resolves a provider plan", () => {
    expect(resolveBoardMove(snapshot, bug, column("az:c2:done"))).toEqual({
      plan: { provider: "azuredevops", state: null, column: null, done: true },
    });
  });

  it("finds the next allowed column in each direction", () => {
    expect(adjacentMoveTarget(snapshot, bug, 1)?.id).toBe("az:c2:done");
    expect(adjacentMoveTarget(snapshot, bug, -1)?.id).toBe("az:c1");
    const done = cards[1]!;
    // Review does not take Bugs, so the next stop is Closed.
    expect(adjacentMoveTarget(snapshot, done, 1)?.id).toBe("az:c4");
    const closed = { ...bug, columnId: "az:c4", state: "Closed" };
    expect(adjacentMoveTarget(snapshot, closed, 1)).toBeNull();
  });

  it("predicts the optimistic placement", () => {
    expect(optimisticPlacement(snapshot, bug, column("az:c4"))).toMatchObject({
      columnId: "az:c4",
      state: "Closed",
      stateCategory: "done",
      stateColor: "#339933",
      boardColumn: "Closed",
      boardColumnDone: false,
    });
    expect(
      optimisticPlacement(snapshot, bug, column("az:c2:done")),
    ).toMatchObject({
      columnId: "az:c2:done",
      state: "Active",
      boardColumnDone: true,
    });
  });
});

describe("board view helpers", () => {
  const grid = [["a1", "a2", "a3"], [], ["c1"]];

  it("moves focus within and across columns", () => {
    expect(focusNeighbor(grid, "a2", "up")).toBe("a1");
    expect(focusNeighbor(grid, "a2", "down")).toBe("a3");
    expect(focusNeighbor(grid, "a3", "down")).toBeNull();
    expect(focusNeighbor(grid, "a3", "right")).toBe("c1");
    expect(focusNeighbor(grid, "c1", "left")).toBe("a1");
    expect(focusNeighbor(grid, "c1", "right")).toBeNull();
    expect(focusNeighbor(grid, "a2", "home")).toBe("a1");
    expect(focusNeighbor(grid, "a1", "end")).toBe("a3");
    expect(focusNeighbor(grid, "missing", "down")).toBeNull();
  });

  it("labels cards for assistive tech", () => {
    expect(
      cardAriaLabel(
        { ...cards[0]!, effort: 5, tags: [{ name: "Android" }] },
        { column: column("az:c2:doing"), pending: true },
      ),
    ).toBe(
      "Bug #1: Item 1. In Doing (Doing), state Active. Unassigned. 5 points. Tags Android. Moving.",
    );
  });
});
