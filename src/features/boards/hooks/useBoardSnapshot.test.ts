// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBoardConfig } from "../model/boardConfigs";
import { clearBoardCaches, loadBoardSnapshot } from "../model/boardSnapshot";
import type { LinearBoardConfig } from "../model/boardTypes";
import type {
  LinearBoardIssue,
  LinearBoardStateRow,
} from "../model/linearBoards";
import {
  BOARD_POLL_MS,
  useBoardSnapshot,
  type BoardMoveOutcome,
  type UseBoardSnapshot,
} from "./useBoardSnapshot";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const rows: LinearBoardStateRow[] = [
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
    id: "d-todo",
    name: "To do",
    type: "unstarted",
    color: "#e2e2e2",
    position: 0,
    teamId: "des",
    teamKey: "DES",
    teamName: "Design",
  },
  {
    id: "d-doing",
    name: "Doing",
    type: "started",
    color: "#f2c94c",
    position: 1,
    teamId: "des",
    teamKey: "DES",
    teamName: "Design",
  },
];

function issue(
  teamId: string,
  overrides: Partial<LinearBoardIssue> = {},
): LinearBoardIssue {
  const team = rows.find((row) => row.teamId === teamId)!;
  return {
    id: `${teamId}-1`,
    identifier: `${team.teamKey}-1`,
    number: 1,
    title: `${team.teamName} issue`,
    url: "https://linear.app/acme/issue/X-1/x",
    stateId: `${teamId[0]}-todo`,
    stateName: "Todo",
    stateType: "unstarted",
    stateColor: "#e2e2e2",
    teamId,
    teamKey: team.teamKey,
    teamName: team.teamName,
    projectName: "",
    priority: 0,
    priorityLabel: "No priority",
    estimate: null,
    sortOrder: 0,
    cycle: null,
    labels: [],
    assignee: null,
    updatedAt: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** When set, the next issues/move calls wait on these instead of answering. */
let issueGate: Map<string, Deferred<void>>;
let moveGate: Deferred<void> | null;
let moveFails: string | null;

function config(teamId: string, id = `board-${teamId}`): LinearBoardConfig {
  return { ...newBoardConfig("linear", { teamIds: [teamId] }), id };
}

function issueCalls(): number {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "linear_boards_issues")
    .length;
}

let container: HTMLDivElement;
let root: Root;
let result: UseBoardSnapshot;
let visibility: DocumentVisibilityState;

function Probe(props: { config: LinearBoardConfig; paused?: boolean }) {
  result = useBoardSnapshot(props.config, { paused: props.paused });
  return null;
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

async function render(props: { config: LinearBoardConfig; paused?: boolean }) {
  await act(async () => root.render(createElement(Probe, props)));
  await flush();
}

beforeEach(() => {
  clearBoardCaches();
  issueGate = new Map();
  moveGate = null;
  moveFails = null;
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case "linear_status":
        return { connected: true };
      case "linear_boards_states":
        return rows;
      case "linear_boards_issues": {
        const { query } = args as { query: { teamIds: string[] } };
        const teamId = query.teamIds[0]!;
        const gate = issueGate.get(teamId);
        if (gate) {
          issueGate.delete(teamId);
          await gate.promise;
        }
        return { items: [issue(teamId)], truncated: false };
      }
      case "linear_boards_move": {
        if (moveGate) await moveGate.promise;
        if (moveFails) throw new Error(moveFails);
        const { stateId } = args as { stateId: string };
        return issue("eng", {
          stateId,
          stateName: "In Progress",
          stateType: "started",
        });
      }
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe("useBoardSnapshot", () => {
  it("shows a fresh cached snapshot without fetching", async () => {
    const board = config("eng");
    const cached = await loadBoardSnapshot(board);
    vi.mocked(invoke).mockClear();
    await render({ config: board });
    expect(result.snapshot).toBe(cached);
    expect(result.loading).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(result.grouped.get("ln:e-todo")!.map((card) => card.ref)).toEqual([
      "ENG-1",
    ]);
  });

  it("ignores an answer for a board that is no longer shown", async () => {
    const slow = deferred<void>();
    issueGate.set("eng", slow);
    await render({ config: config("eng") });
    expect(result.loading).toBe(true);
    await render({ config: config("des") });
    expect(result.snapshot?.configId).toBe("board-des");
    slow.resolve();
    await flush();
    expect(result.snapshot?.configId).toBe("board-des");
    expect(result.snapshot?.cards.map((card) => card.ref)).toEqual(["DES-1"]);
  });

  it("moves optimistically and reverts with an error on failure", async () => {
    const board = config("eng");
    await render({ config: board });
    const card = result.snapshot!.cards[0]!;
    moveGate = deferred<void>();
    moveFails = "Linear refused the update";
    let outcome!: Promise<BoardMoveOutcome>;
    await act(async () => {
      outcome = result.moveCard(card, "ln:e-doing");
    });
    expect(result.snapshot!.cards[0]!.columnId).toBe("ln:e-doing");
    expect(result.grouped.get("ln:e-doing")!.map((entry) => entry.key)).toEqual(
      [card.key],
    );
    expect(result.pending.has(card.key)).toBe(true);

    let second!: BoardMoveOutcome;
    await act(async () => {
      second = await result.moveCard(card, "ln:e-todo");
    });
    expect(second).toEqual({ status: "pending" });

    moveGate.resolve();
    await act(async () => {
      expect(await outcome).toEqual({
        status: "failed",
        error: "Linear refused the update",
      });
    });
    expect(result.snapshot!.cards[0]!.columnId).toBe("ln:e-todo");
    expect(result.pending.size).toBe(0);
    expect(result.moveErrors).toEqual({
      [card.key]: "Linear refused the update",
    });
    await act(async () => result.dismissMoveError(card.key));
    expect(result.moveErrors).toEqual({});
  });

  it("keeps the provider's card after a successful move", async () => {
    await render({ config: config("eng") });
    const card = result.snapshot!.cards[0]!;
    let outcome!: BoardMoveOutcome;
    await act(async () => {
      outcome = await result.moveCard(card, "ln:e-doing");
    });
    expect(outcome).toMatchObject({
      status: "moved",
      column: { id: "ln:e-doing" },
    });
    expect(result.snapshot!.cards[0]).toMatchObject({
      columnId: "ln:e-doing",
      stateId: "e-doing",
    });
    expect(result.pending.size).toBe(0);
    expect(
      await result.moveCard(result.snapshot!.cards[0]!, "ln:e-doing"),
    ).toEqual({
      status: "same",
    });
  });

  describe("polling", () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          "setInterval",
          "clearInterval",
          "setTimeout",
          "clearTimeout",
          "Date",
        ],
      });
    });

    it("polls every two minutes while visible", async () => {
      await render({ config: config("eng") });
      expect(issueCalls()).toBe(1);
      await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS));
      await flush();
      expect(issueCalls()).toBe(2);
      await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS));
      await flush();
      expect(issueCalls()).toBe(3);
    });

    it("does not poll while hidden", async () => {
      await render({ config: config("eng") });
      visibility = "hidden";
      await act(async () =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS * 3));
      await flush();
      expect(issueCalls()).toBe(1);
      visibility = "visible";
      // Coming back revalidates stale data once.
      await act(async () =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await flush();
      expect(issueCalls()).toBe(2);
    });

    it("does not poll while paused", async () => {
      const board = config("eng");
      await render({ config: board, paused: true });
      await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS * 3));
      await flush();
      expect(issueCalls()).toBe(1);
      await act(async () => window.dispatchEvent(new Event("focus")));
      await flush();
      expect(issueCalls()).toBe(1);
      await render({ config: board, paused: false });
      await act(async () => vi.advanceTimersByTime(BOARD_POLL_MS));
      await flush();
      expect(issueCalls()).toBe(2);
    });
  });
});
