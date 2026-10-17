// @vitest-environment happy-dom
import {
  act,
  createElement,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropVerdict } from "../model/boardColumns";
import {
  BOARD_DRAGGING_CLASS,
  BOARD_DRAG_PREVIEW_CLASS,
  BOARD_LOST_POINTERUP_MS,
  useBoardDrag,
  type UseBoardDrag,
} from "./useBoardDrag";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let result: UseBoardDrag;
let board: HTMLElement;
let button: HTMLButtonElement;
let columns: Record<string, HTMLElement>;
const onDrop = vi.fn();
const verdict = vi.fn((_cardKey: string, columnId: string): DropVerdict =>
  columnId === "todo"
    ? { kind: "same" }
    : columnId === "review"
      ? { kind: "disallowed", reason: "No “Review” state for Bug" }
      : { kind: "ok" },
);

function Probe(props: {
  scroller: RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  result = useBoardDrag({
    scroller: props.scroller,
    verdict,
    onDrop,
    enabled: props.enabled,
  });
  return null;
}

/** Columns are 100 px wide side by side: todo, doing, review. */
function columnAt(x: number): HTMLElement | null {
  if (x < 100) return columns.todo!;
  if (x < 200) return columns.doing!;
  if (x < 300) return columns.review!;
  return null;
}

function press(x = 10, y = 10) {
  act(() =>
    result.onCardPointerDown("azuredevops:1", {
      button: 0,
      pointerId: 1,
      clientX: x,
      clientY: y,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      currentTarget: button,
    } as unknown as ReactPointerEvent<HTMLElement>),
  );
}

function move(x: number, y = 10, init: PointerEventInit = {}) {
  act(() => {
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        clientX: x,
        clientY: y,
        ...init,
      }),
    );
  });
}

function release(x: number, y = 10) {
  act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", { pointerId: 1, clientX: x, clientY: y }),
    );
  });
}

function preview(): HTMLElement | null {
  return document.body.querySelector(`.${BOARD_DRAG_PREVIEW_CLASS}`);
}

async function nextFrame() {
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

beforeEach(() => {
  onDrop.mockReset();
  verdict.mockClear();
  board = document.createElement("div");
  columns = {};
  for (const id of ["todo", "doing", "review"]) {
    const column = document.createElement("section");
    column.setAttribute("data-board-column", id);
    board.append(column);
    columns[id] = column;
  }
  const card = document.createElement("li");
  card.setAttribute("data-board-card", "");
  card.id = "card-1";
  button = document.createElement("button");
  button.id = "card-1-button";
  button.tabIndex = 0;
  button.textContent = "Bug #1 Fix login";
  card.append(button);
  columns.todo!.append(card);
  document.body.append(board);
  document.elementFromPoint = (x: number) => columnAt(x);
  const scroller = { current: board };
  root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe, { scroller })));
});

afterEach(() => {
  act(() => result.cancel());
  act(() => root.unmount());
  board.remove();
  for (const element of document.body.querySelectorAll(
    `.${BOARD_DRAG_PREVIEW_CLASS}`,
  )) {
    element.remove();
  }
  vi.useRealTimers();
});

describe("useBoardDrag", () => {
  it("starts after 5 px and clones a safe preview", () => {
    press();
    move(13);
    expect(preview()).toBeNull();
    expect(result.drag).toBeNull();
    move(16);
    const clone = preview()!;
    expect(clone).not.toBeNull();
    expect(clone.textContent).toBe("Bug #1 Fix login");
    expect(clone.querySelector("[id]")).toBeNull();
    expect(clone.id).toBe("");
    expect(clone.hasAttribute("inert")).toBe(true);
    expect(clone.getAttribute("aria-hidden")).toBe("true");
    expect(clone.querySelector("[tabindex]")).toBeNull();
    expect(clone.hasAttribute("data-board-dragging")).toBe(false);
    expect(button.closest("li")!.dataset.boardDragging).toBe("true");
    expect(
      document.documentElement.classList.contains(BOARD_DRAGGING_CLASS),
    ).toBe(true);
    expect(result.drag).toEqual({
      cardKey: "azuredevops:1",
      overColumnId: "todo",
      verdict: { kind: "same" },
    });
  });

  it("drops on an allowed column", async () => {
    press();
    move(150);
    expect(result.drag?.overColumnId).toBe("doing");
    expect(document.documentElement.dataset.boardDrop).toBe("ok");
    release(150);
    expect(onDrop).toHaveBeenCalledWith("azuredevops:1", "doing");
    expect(result.drag).toBeNull();
    expect(document.documentElement.dataset.boardDrop).toBeUndefined();
    expect(
      document.documentElement.classList.contains(BOARD_DRAGGING_CLASS),
    ).toBe(false);
    // The preview stays one more frame so the card can render in place.
    expect(preview()).not.toBeNull();
    await nextFrame();
    expect(preview()).toBeNull();
  });

  it("does not drop on a disallowed column", () => {
    press();
    move(250);
    expect(result.drag?.verdict).toEqual({
      kind: "disallowed",
      reason: "No “Review” state for Bug",
    });
    expect(document.documentElement.dataset.boardDrop).toBe("disallowed");
    release(250);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("does not drop outside the columns or back on its own column", () => {
    press();
    move(400);
    expect(result.drag?.overColumnId).toBeNull();
    release(400);
    press();
    move(50, 40);
    release(50, 40);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancels on Escape", () => {
    press();
    move(150);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.drag).toBeNull();
    release(150);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancels on blur and pointercancel", () => {
    press();
    move(150);
    act(() => window.dispatchEvent(new Event("blur")));
    expect(result.drag).toBeNull();
    press();
    move(150);
    act(() =>
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
    );
    expect(result.drag).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("swallows the click that follows a drag, once", () => {
    press();
    move(150);
    release(150);
    expect(result.consumeClick()).toBe(true);
    expect(result.consumeClick()).toBe(false);
    press();
    release(10);
    expect(result.consumeClick()).toBe(false);
  });

  it("cancels when the pointerup is lost", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    press();
    move(150, 10, { pointerType: "mouse", buttons: 1 });
    expect(result.drag).not.toBeNull();
    move(160, 10, { pointerType: "mouse", buttons: 0 });
    act(() => vi.advanceTimersByTime(BOARD_LOST_POINTERUP_MS - 10));
    expect(result.drag).not.toBeNull();
    act(() => vi.advanceTimersByTime(20));
    expect(result.drag).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("keeps a quick release that arrives within the grace period", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    press();
    move(150, 10, { pointerType: "mouse", buttons: 1 });
    move(150, 10, { pointerType: "mouse", buttons: 0 });
    release(150);
    act(() => vi.advanceTimersByTime(BOARD_LOST_POINTERUP_MS * 2));
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("ignores presses while disabled and cancels a running drag", async () => {
    const scroller = { current: board };
    press();
    move(150);
    act(() => root.render(createElement(Probe, { scroller, enabled: false })));
    expect(result.drag).toBeNull();
    await nextFrame();
    expect(preview()).toBeNull();
    press();
    move(150);
    expect(preview()).toBeNull();
    expect(result.drag).toBeNull();
  });
});
