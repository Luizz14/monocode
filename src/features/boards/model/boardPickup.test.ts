import { describe, expect, it } from "vitest";
import { newBoardConfig } from "./boardConfigs";
import { pickupDecision, pickupTitle } from "./boardPickup";
import type {
  AzureBoardConfig,
  BoardCard,
  BoardCardChild,
  BoardColumn,
  BoardConfig,
} from "./boardTypes";

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    provider: "azuredevops",
    key: "azuredevops:20",
    id: "20",
    ref: "#20",
    number: 20,
    title: "Crash on login",
    url: "",
    type: "User Story",
    state: "New",
    stateCategory: "todo",
    columnId: "az:c1",
    tags: [],
    project: "Proj",
    order: 1,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function column(overrides: Partial<BoardColumn> = {}): BoardColumn {
  return {
    id: "az:c2",
    title: "Active",
    category: "inProgress",
    target: { provider: "none" },
    ...overrides,
  };
}

function child(overrides: Partial<BoardCardChild> = {}): BoardCardChild {
  return {
    id: 5,
    title: "Em implementação",
    type: "Task",
    state: "In Progress",
    stateCategory: "inProgress",
    assignee: { id: "u-me", name: "Luiz", isMe: true },
    updatedAt: "2026-10-01T00:00:00Z",
    url: "",
    ...overrides,
  };
}

const config: AzureBoardConfig = newBoardConfig("azuredevops");

describe("pickupDecision", () => {
  it("creates when a Proposed item moves into a work column", () => {
    expect(pickupDecision(card(), column(), config)).toEqual({
      kind: "create",
    });
  });

  it("takes backlog and triage as Proposed too, and any non-child type", () => {
    for (const stateCategory of ["backlog", "triage"] as const) {
      expect(
        pickupDecision(card({ stateCategory }), column(), config).kind,
      ).toBe("create");
    }
    for (const type of ["Bug", "Feature", "Epic", undefined]) {
      expect(pickupDecision(card({ type }), column(), config).kind).toBe(
        "create",
      );
    }
  });

  it("skips other providers", () => {
    const linear = newBoardConfig("linear");
    expect(pickupDecision(card(), column(), linear)).toEqual({
      kind: "skip",
      reason: "provider",
    });
    expect(
      pickupDecision(card({ provider: "linear" }), column(), config),
    ).toEqual({ kind: "skip", reason: "provider" });
  });

  it("skips when the board has it turned off", () => {
    const off: BoardConfig = {
      ...config,
      autoTask: { enabled: false, title: "Em implementação" },
    };
    expect(pickupDecision(card(), column(), off)).toEqual({
      kind: "skip",
      reason: "disabled",
    });
  });

  it("skips Tasks, Tests and Issues, whatever their case", () => {
    for (const type of ["Task", "task", " Test ", "Test Case", "ISSUE"]) {
      expect(pickupDecision(card({ type }), column(), config)).toEqual({
        kind: "skip",
        reason: "child-type",
      });
    }
  });

  it("skips an item that was already underway", () => {
    for (const stateCategory of [
      "inProgress",
      "resolved",
      "done",
      "canceled",
      "unknown",
    ] as const) {
      expect(pickupDecision(card({ stateCategory }), column(), config)).toEqual(
        {
          kind: "skip",
          reason: "not-proposed",
        },
      );
    }
  });

  it("skips moves that do not land in a work column", () => {
    for (const category of ["todo", "resolved", "done", "canceled"] as const) {
      expect(pickupDecision(card(), column({ category }), config)).toEqual({
        kind: "skip",
        reason: "not-work-column",
      });
    }
  });

  it("skips a move that did not leave its column", () => {
    expect(
      pickupDecision(card({ columnId: "az:c2" }), column(), config),
    ).toEqual({ kind: "skip", reason: "not-moved" });
  });

  it("skips when I already hold an unfinished child", () => {
    const decide = (children: BoardCardChild[]) =>
      pickupDecision(card({ children }), column(), config);
    expect(decide([child()])).toEqual({ kind: "skip", reason: "already-mine" });
    expect(decide([child({ stateCategory: "todo" })]).kind).toBe("skip");
    // A finished one of mine, or someone else's, does not count.
    expect(decide([child({ stateCategory: "done" })]).kind).toBe("create");
    expect(decide([child({ stateCategory: "canceled" })]).kind).toBe("create");
    expect(
      decide([child({ assignee: { id: "u-t", name: "Tiago" } })]).kind,
    ).toBe("create");
    expect(decide([child({ assignee: undefined })]).kind).toBe("create");
    expect(decide([]).kind).toBe("create");
  });

  it("reports the first reason in the documented order", () => {
    const linear = newBoardConfig("linear");
    expect(
      pickupDecision(
        card({ type: "Task", stateCategory: "done", columnId: "az:c2" }),
        column({ category: "done" }),
        linear,
      ),
    ).toEqual({ kind: "skip", reason: "provider" });
    const off: AzureBoardConfig = {
      ...config,
      autoTask: { enabled: false, title: "x" },
    };
    expect(
      pickupDecision(card({ type: "Task" }), column({ category: "done" }), off),
    ).toEqual({ kind: "skip", reason: "disabled" });
    expect(
      pickupDecision(
        card({ type: "Task", stateCategory: "done" }),
        column({ category: "done" }),
        config,
      ),
    ).toEqual({ kind: "skip", reason: "child-type" });
    expect(
      pickupDecision(
        card({ stateCategory: "done", columnId: "az:c2" }),
        column({ category: "done" }),
        config,
      ),
    ).toEqual({ kind: "skip", reason: "not-proposed" });
    expect(
      pickupDecision(
        card({ columnId: "az:c2" }),
        column({ category: "done" }),
        config,
      ),
    ).toEqual({ kind: "skip", reason: "not-work-column" });
  });
});

describe("pickupTitle", () => {
  it("uses the board's title, trimmed, else the default", () => {
    expect(pickupTitle(config)).toBe("Em implementação");
    expect(
      pickupTitle({ ...config, autoTask: { enabled: true, title: "  Dev  " } }),
    ).toBe("Dev");
    expect(
      pickupTitle({ ...config, autoTask: { enabled: true, title: "   " } }),
    ).toBe("Em implementação");
    expect(pickupTitle(newBoardConfig("linear"))).toBe("Em implementação");
  });
});
