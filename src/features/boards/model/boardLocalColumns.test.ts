// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { dropVerdict } from "./boardColumns";
import { newBoardConfig } from "./boardConfigs";
import {
  applyLocalBoard,
  buildLocalColumns,
  insertLocalColumns,
  isLocalColumnId,
  loadLocalPlacements,
  localColumnId,
  prunedPlacements,
  saveLocalPlacements,
} from "./boardLocalColumns";
import type {
  AzureBoardConfig,
  BoardCard,
  BoardColumn,
  BoardSnapshot,
} from "./boardTypes";

function column(overrides: Partial<BoardColumn>): BoardColumn {
  return {
    id: "c",
    title: "C",
    category: "inProgress",
    target: {
      provider: "azuredevops",
      stateMappings: { "User Story": "Active" },
      boardColumn: null,
      split: null,
    },
    ...overrides,
  };
}

const newColumn = column({
  id: "az:new",
  title: "New",
  category: "todo",
  target: {
    provider: "azuredevops",
    stateMappings: { "User Story": "New" },
    boardColumn: null,
    split: null,
  },
});
const active = column({ id: "az:active", title: "Active" });
const review = column({
  id: "az:review",
  title: "Review",
  target: {
    provider: "azuredevops",
    stateMappings: { "User Story": "Review" },
    boardColumn: null,
    split: null,
  },
});
const closed = column({
  id: "az:closed",
  title: "Closed",
  category: "done",
  target: {
    provider: "azuredevops",
    stateMappings: { "User Story": "Closed" },
    boardColumn: null,
    split: null,
  },
});
const other = column({
  id: "other",
  title: "Other",
  category: "unknown",
  target: { provider: "none" },
});

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    provider: "azuredevops",
    key: `azuredevops:${overrides.number ?? 1}`,
    id: String(overrides.number ?? 1),
    ref: `#${overrides.number ?? 1}`,
    number: overrides.number ?? 1,
    title: "Story",
    url: "",
    type: "User Story",
    state: "Active",
    stateCategory: "inProgress",
    columnId: "az:active",
    tags: [],
    project: "P",
    order: 0,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const config: AzureBoardConfig = {
  ...newBoardConfig("azuredevops", { project: "P", team: "T" }),
  id: "board-1",
};
const locals = buildLocalColumns(config.localColumns);

function snapshot(cards: BoardCard[], columns: BoardColumn[]): BoardSnapshot {
  return {
    configId: "board-1",
    queryKey: "q",
    provider: "azuredevops",
    columns,
    cards,
    truncated: false,
    doneHidden: true,
    webUrl: null,
    fetchedAt: 0,
    limit: 500,
  };
}

beforeEach(() => localStorage.clear());

describe("local columns", () => {
  it("builds MonoCode-only columns from the config", () => {
    expect(locals.map((entry) => [entry.id, entry.title, entry.subtitle])).toEqual([
      ["local:code-review", "Aguardando code review", "MonoCode"],
      ["local:homologacao", "Em homologação", "MonoCode"],
    ]);
    expect(locals[0]!.target).toEqual({ provider: "local", localId: "code-review" });
    expect(isLocalColumnId(localColumnId("x"))).toBe(true);
    expect(isLocalColumnId("az:c1")).toBe(false);
  });

  it("goes after the last in-progress column, else before the finished ones", () => {
    const ids = (columns: BoardColumn[]) => columns.map((entry) => entry.id);
    expect(ids(insertLocalColumns([newColumn, active, review, closed], locals))).toEqual([
      "az:new",
      "az:active",
      "az:review",
      "local:code-review",
      "local:homologacao",
      "az:closed",
    ]);
    expect(ids(insertLocalColumns([newColumn, closed, other], locals))).toEqual([
      "az:new",
      "local:code-review",
      "local:homologacao",
      "az:closed",
      "other",
    ]);
    expect(ids(insertLocalColumns([newColumn], locals))).toEqual([
      "az:new",
      "local:code-review",
      "local:homologacao",
    ]);
    expect(insertLocalColumns([newColumn], [])).toEqual([newColumn]);
  });

  it("shows parked cards in their local column and leaves the rest alone", () => {
    const parked = card({ number: 1 });
    const done = card({ number: 2, state: "Closed", stateCategory: "done", columnId: "az:closed" });
    const free = card({ number: 3 });
    const shown = applyLocalBoard(
      snapshot([parked, done, free], [newColumn, active, closed]),
      config,
      {
        "azuredevops:1": "local:homologacao",
        "azuredevops:2": "local:homologacao",
        "azuredevops:3": "local:gone",
      },
    )!;
    expect(shown.columns.map((entry) => entry.id)).toContain("local:homologacao");
    expect(shown.cards.map((entry) => entry.columnId)).toEqual([
      "local:homologacao",
      "az:closed",
      "az:active",
    ]);
    // Finished cards are never parked; the free card is untouched.
    expect(shown.cards[2]).toBe(free);
    // Linear boards and boards without local columns pass through.
    const linear = newBoardConfig("linear");
    const raw = snapshot([parked], [active]);
    expect(applyLocalBoard(raw, linear, { "azuredevops:1": "local:x" })).toBe(raw);
    expect(applyLocalBoard(raw, { ...config, localColumns: [] }, {})).toBe(raw);
    expect(applyLocalBoard(null, config, {})).toBeNull();
  });

  it("prunes placements for cards that left, finished, or lost their column", () => {
    const placements = {
      "azuredevops:1": "local:homologacao",
      "azuredevops:2": "local:homologacao",
      "azuredevops:3": "local:gone",
      "azuredevops:9": "local:code-review",
    };
    const pruned = prunedPlacements(
      placements,
      snapshot(
        [
          card({ number: 1 }),
          card({ number: 2, state: "Closed", stateCategory: "done" }),
          card({ number: 3 }),
        ],
        [active],
      ),
      config,
    );
    expect(pruned).toEqual({ "azuredevops:1": "local:homologacao" });
    const same = { "azuredevops:1": "local:homologacao" };
    expect(prunedPlacements(same, snapshot([card({ number: 1 })], [active]), config)).toBe(same);
    expect(prunedPlacements(same, null, config)).toBe(same);
  });

  it("round-trips placements through storage and drops junk", () => {
    saveLocalPlacements("board-1", { "azuredevops:1": "local:homologacao" });
    expect(loadLocalPlacements("board-1")).toEqual({
      "azuredevops:1": "local:homologacao",
    });
    localStorage.setItem(
      "monocode.boards.local.board-2",
      JSON.stringify({ a: "local:x", b: "az:c1", c: 3 }),
    );
    expect(loadLocalPlacements("board-2")).toEqual({ a: "local:x" });
    localStorage.setItem("monocode.boards.local.board-3", "[1]");
    expect(loadLocalPlacements("board-3")).toEqual({});
    saveLocalPlacements("board-1", {});
    expect(localStorage.getItem("monocode.boards.local.board-1")).toBeNull();
  });

  it("lets any unfinished card park, and a parked card go home or move on", () => {
    const shown = applyLocalBoard(
      snapshot([card({ number: 1 }), card({ number: 2, state: "Closed", stateCategory: "done", columnId: "az:closed" })], [newColumn, active, closed]),
      config,
      { "azuredevops:1": "local:code-review" },
    )!;
    const parked = shown.cards[0]!;
    const finished = shown.cards[1]!;
    const codeReview = shown.columns.find((entry) => entry.id === "local:code-review")!;
    const homolog = shown.columns.find((entry) => entry.id === "local:homologacao")!;
    expect(dropVerdict(shown, parked, codeReview).kind).toBe("same");
    expect(dropVerdict(shown, parked, homolog).kind).toBe("ok");
    // Back to its own state's column: nothing to write, still a move.
    expect(dropVerdict(shown, parked, active).kind).toBe("ok");
    expect(dropVerdict(shown, parked, closed).kind).toBe("ok");
    expect(dropVerdict(shown, finished, homolog)).toEqual({
      kind: "disallowed",
      reason: "Finished items stay in their column",
    });
  });
});
