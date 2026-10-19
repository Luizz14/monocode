import { describe, expect, it } from "vitest";
import {
  applyBoardMoves,
  boardReducer,
  initialBoardState,
  pendingBoardMoveKeys,
  type BoardState,
} from "./boardState";
import type { BoardCard, BoardSnapshot } from "./boardTypes";

function card(id: number, columnId: string, state = "Active"): BoardCard {
  return {
    provider: "azuredevops",
    key: `azuredevops:${id}`,
    id: String(id),
    ref: `#${id}`,
    number: id,
    title: `Item ${id}`,
    url: "",
    type: "Bug",
    state,
    stateCategory: "inProgress",
    columnId,
    tags: [],
    project: "TI Banese",
    order: id,
    updatedAt: "2026-10-01T00:00:00Z",
  };
}

function snapshot(cards: BoardCard[], fetchedAt = 1): BoardSnapshot {
  return {
    configId: "a1",
    queryKey: "q",
    provider: "azuredevops",
    columns: [],
    cards,
    truncated: false,
    doneHidden: true,
    webUrl: null,
    fetchedAt,
    limit: 500,
  };
}

function run(
  state: BoardState,
  ...actions: Parameters<typeof boardReducer>[1][]
) {
  return actions.reduce(boardReducer, state);
}

const base = snapshot([card(1, "accepted"), card(2, "accepted")]);
const loaded = run(
  initialBoardState("a1|q"),
  { type: "load-start", seq: 1 },
  { type: "load-success", seq: 1, snapshot: base },
);

describe("boardReducer loads", () => {
  it("starts loading when nothing is cached", () => {
    expect(initialBoardState("a1|q").loading).toBe(true);
    expect(initialBoardState("a1|q", base).loading).toBe(false);
    expect(initialBoardState(null).loading).toBe(false);
  });

  it("revalidates over data already shown", () => {
    const state = run(loaded, { type: "load-start", seq: 2 });
    expect(state).toMatchObject({
      loading: false,
      revalidating: true,
      snapshot: base,
    });
  });

  it("ignores answers from older loads", () => {
    const newer = snapshot([card(1, "closed")], 2);
    const state = run(
      loaded,
      { type: "load-start", seq: 2 },
      { type: "load-start", seq: 3 },
      { type: "load-success", seq: 3, snapshot: newer },
      { type: "load-success", seq: 2, snapshot: base },
      { type: "load-error", seq: 2, error: "late" },
    );
    expect(state.snapshot).toBe(newer);
    expect(state.error).toBeNull();
  });

  it("keeps data on a failed revalidation and reports the error", () => {
    const state = run(
      loaded,
      { type: "load-start", seq: 2 },
      { type: "load-error", seq: 2, error: "Network down", code: "provider" },
    );
    expect(state).toMatchObject({
      snapshot: base,
      loading: false,
      revalidating: false,
      error: "Network down",
      errorCode: "provider",
    });
    expect(run(state, { type: "dismiss-error" }).error).toBeNull();
  });

  it("reports a failed first load without data", () => {
    const state = run(
      initialBoardState("a1|q"),
      { type: "load-start", seq: 1 },
      {
        type: "load-error",
        seq: 1,
        error: "Connect Azure DevOps in Settings",
        code: "not-connected",
      },
    );
    expect(state).toMatchObject({
      snapshot: null,
      loading: false,
      error: "Connect Azure DevOps in Settings",
      errorCode: "not-connected",
    });
  });
});

describe("boardReducer moves", () => {
  const optimistic = card(1, "closed", "Closed");

  it("overlays a pending move", () => {
    const state = run(loaded, { type: "move-start", seq: 2, card: optimistic });
    const view = applyBoardMoves(state.snapshot, state.moves)!;
    expect(view.cards[0]).toBe(optimistic);
    expect(view.cards[1]).toBe(base.cards[1]);
    expect(pendingBoardMoveKeys(state.moves)).toEqual(
      new Set(["azuredevops:1"]),
    );
  });

  it("ignores a second move of a pending card", () => {
    const state = run(loaded, { type: "move-start", seq: 2, card: optimistic });
    expect(
      run(state, { type: "move-start", seq: 3, card: card(1, "new", "New") }),
    ).toBe(state);
  });

  it("reverts and records the error on failure", () => {
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "move-failure", key: "azuredevops:1", error: "TF401320: rule" },
    );
    expect(applyBoardMoves(state.snapshot, state.moves)).toBe(base);
    expect(state.moveErrors).toEqual({ "azuredevops:1": "TF401320: rule" });
    const retried = run(state, {
      type: "move-start",
      seq: 3,
      card: optimistic,
    });
    expect(retried.moveErrors).toEqual({});
    expect(
      run(state, { type: "dismiss-error", key: "azuredevops:1" }).moveErrors,
    ).toEqual({});
  });

  it("shows the column the server picked", () => {
    const fromServer = card(1, "resolved", "Resolved");
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "move-success", seq: 3, card: fromServer },
    );
    const view = applyBoardMoves(state.snapshot, state.moves)!;
    expect(view.cards[0]!.columnId).toBe("resolved");
    expect(pendingBoardMoveKeys(state.moves).size).toBe(0);
  });

  it("keeps a pending move across a refresh", () => {
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "load-start", seq: 3 },
      { type: "load-success", seq: 3, snapshot: snapshot(base.cards, 2) },
    );
    expect(applyBoardMoves(state.snapshot, state.moves)!.cards[0]).toBe(
      optimistic,
    );
  });

  it("keeps a committed move over a load that started before it", () => {
    const fromServer = card(1, "closed", "Closed");
    const state = run(
      loaded,
      { type: "load-start", seq: 2 },
      { type: "move-start", seq: 3, card: optimistic },
      { type: "move-success", seq: 4, card: fromServer },
      { type: "load-success", seq: 2, snapshot: snapshot(base.cards, 2) },
    );
    expect(applyBoardMoves(state.snapshot, state.moves)!.cards[0]).toBe(
      fromServer,
    );
  });

  it("drops a committed move once a later load lands", () => {
    const fromServer = card(1, "closed", "Closed");
    const refreshed = snapshot(
      [card(1, "closed", "Closed"), base.cards[1]!],
      3,
    );
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "move-success", seq: 3, card: fromServer },
      { type: "load-start", seq: 4 },
      { type: "load-success", seq: 4, snapshot: refreshed },
    );
    expect(state.moves).toEqual({});
    expect(applyBoardMoves(state.snapshot, state.moves)).toBe(refreshed);
  });

  it("shows a patched card until a load that started after it lands", () => {
    const patched = { ...card(1, "accepted"), title: "Patched" };
    const patchedState = run(
      loaded,
      { type: "load-start", seq: 2 },
      { type: "card-patch", seq: 3, card: patched },
      // A load that began before the patch cannot know about it.
      { type: "load-success", seq: 2, snapshot: snapshot(base.cards, 2) },
    );
    expect(applyBoardMoves(patchedState.snapshot, patchedState.moves)!.cards[0]).toBe(
      patched,
    );
    expect(pendingBoardMoveKeys(patchedState.moves).size).toBe(0);
    const settled = run(
      patchedState,
      { type: "load-start", seq: 4 },
      { type: "load-success", seq: 4, snapshot: snapshot(base.cards, 3) },
    );
    expect(settled.moves).toEqual({});
    // Patching again replaces the earlier patch.
    const again = { ...patched, title: "Patched twice" };
    expect(
      run(patchedState, { type: "card-patch", seq: 5, card: again }).moves[
        "azuredevops:1"
      ]!.card,
    ).toBe(again);
  });

  it("leaves a card whose move is still in flight alone when patched", () => {
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "card-patch", seq: 3, card: card(1, "accepted") },
    );
    expect(state.moves["azuredevops:1"]!.card).toBe(optimistic);
    expect(pendingBoardMoveKeys(state.moves).size).toBe(1);
  });

  it("starts over on reset", () => {
    const state = run(
      loaded,
      { type: "move-start", seq: 2, card: optimistic },
      { type: "reset", epoch: "b|q", snapshot: null },
    );
    expect(state).toEqual(initialBoardState("b|q"));
  });
});
