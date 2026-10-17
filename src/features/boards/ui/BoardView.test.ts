// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AzureBoardItem,
  AzureBoardLayout,
  AzureTeamSetup,
  AzureWorkItemTypeStates,
} from "../model/azureBoards";
import {
  ACTIVE_BOARD_KEY,
  BOARDS_KEY,
  newBoardConfig,
} from "../model/boardConfigs";
import { clearBoardCaches } from "../model/boardSnapshot";
import type { AzureBoardConfig } from "../model/boardTypes";
import { BoardView } from "./BoardView";

const invoke = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

const types: AzureWorkItemTypeStates[] = [
  {
    name: "User Story",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
      { name: "Closed", color: "339933", category: "Completed" },
    ],
  },
  {
    name: "Bug",
    states: [
      { name: "New", color: "b2b2b2", category: "Proposed" },
      { name: "Active", color: "007acc", category: "InProgress" },
      { name: "Resolved", color: "ff9d00", category: "Resolved" },
    ],
  },
];

const layout: AzureBoardLayout = {
  id: "board-1",
  name: "Stories",
  columnField: "WEF_ABC_Kanban.Column",
  doneField: null,
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
      name: "Active",
      itemLimit: 1,
      stateMappings: { "User Story": "Active", Bug: "Active" },
      isSplit: false,
      columnType: "inProgress",
    },
    {
      id: "c3",
      name: "Closed",
      itemLimit: 0,
      stateMappings: { "User Story": "Closed" },
      isSplit: false,
      columnType: "outgoing",
    },
  ],
};

const setup: AzureTeamSetup = {
  backlogLevels: [
    {
      id: "Microsoft.RequirementCategory",
      name: "Stories",
      rank: 1,
      kind: "requirement",
      workItemTypes: ["User Story", "Bug"],
      defaultWorkItemType: "User Story",
      isHidden: false,
    },
  ],
  orderField: "Microsoft.VSTS.Common.StackRank",
  effortField: "Microsoft.VSTS.Scheduling.StoryPoints",
  bugsBehavior: "asRequirements",
  teamAreas: [{ path: "Proj\\Team", includeChildren: true }],
  defaultArea: "Proj\\Team",
  iterations: [],
  currentIteration: {
    id: "it-42",
    name: "Sprint 42",
    path: "Proj\\Sprint 42",
    startDate: null,
    finishDate: null,
    timeFrame: "current",
  },
};

function item(overrides: Partial<AzureBoardItem>): AzureBoardItem {
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
    areaPath: "Proj\\Team",
    iterationPath: "Proj\\Sprint 42",
    changedDate: "2026-10-10T00:00:00Z",
    boardColumn: null,
    boardColumnDone: false,
    project: "Proj",
    url: `https://dev.azure.com/org/Proj/_workitems/edit/${overrides.id ?? 1}`,
    ...overrides,
  };
}

const items: AzureBoardItem[] = [
  item({ id: 10, title: "Story ten", boardColumn: "Active", effort: 5 }),
  item({ id: 11, title: "Story eleven", boardColumn: "Active" }),
  item({
    id: 20,
    workItemType: "Bug",
    title: "Crash on login",
    state: "New",
    boardColumn: "New",
    tags: ["Android"],
  }),
];

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

let azureConnected: boolean;
let moveResult: Deferred<AzureBoardItem> | null;

function route(command: string): unknown {
  switch (command) {
    case "azure_devops_status":
      return azureConnected
        ? {
            connected: true,
            url: "https://dev.azure.com/org",
            organization: "https://dev.azure.com/org",
          }
        : { connected: false, url: "", organization: "" };
    case "linear_status":
      return { connected: false };
    case "azure_boards_team_setup":
      return setup;
    case "azure_boards_board":
      return { board: layout, types };
    case "azure_boards_query":
      return { items, truncated: false };
    case "azure_devops_projects":
      return [{ id: "p1", name: "Proj" }];
    case "azure_boards_teams":
      return [{ id: "t1", name: "Team" }];
    case "azure_boards_areas":
      return ["Proj\\Team"];
    case "azure_boards_move":
      if (moveResult) return moveResult.promise;
      throw new Error("Unexpected move");
    default:
      throw new Error(`Unexpected command: ${command}`);
  }
}

function azureBoard(): AzureBoardConfig {
  return {
    ...newBoardConfig("azuredevops", {
      project: "Proj",
      team: "Team",
      backlogLevel: { id: "Microsoft.RequirementCategory", name: "Stories" },
    }),
    id: "board-a",
    name: "Team · Stories",
  };
}

function storeBoards(configs: AzureBoardConfig[]) {
  localStorage.setItem(BOARDS_KEY, JSON.stringify(configs));
  if (configs[0]) localStorage.setItem(ACTIVE_BOARD_KEY, configs[0].id);
}

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let onOpenIntegrations: ReturnType<typeof vi.fn>;

async function flush() {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () =>
    root.render(
      createElement(BoardView, {
        besideRail: true,
        onClose,
        onOpenIntegrations,
        onStart: vi.fn(),
      }),
    ),
  );
  await flush();
}

function column(title: string): HTMLElement {
  const found = [
    ...container.querySelectorAll<HTMLElement>("[data-board-column]"),
  ].find((section) => section.querySelector("h3")?.textContent === title);
  if (!found) throw new Error(`No column ${title}`);
  return found;
}

function card(ref: string): HTMLButtonElement {
  const found = [
    ...container.querySelectorAll<HTMLButtonElement>("button[data-card-key]"),
  ].find((button) => button.textContent?.includes(ref));
  if (!found) throw new Error(`No card ${ref}`);
  return found;
}

function liveRegion(): string {
  return container.querySelector('[role="status"]')?.textContent ?? "";
}

function pressKey(target: EventTarget, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  clearBoardCaches();
  azureConnected = true;
  moveResult = null;
  invoke.mockReset();
  invoke.mockImplementation(async (command: string) => route(command));
  openUrl.mockClear();
  onClose = vi.fn();
  onOpenIntegrations = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("BoardView", () => {
  it("shows the empty state with a way to start each board", async () => {
    await render();
    expect(container.textContent).toContain("Organize work items on a board");
    const azure = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "New Azure DevOps board",
    );
    expect(azure).toBeDefined();
    // Linear isn't connected, so its button connects instead.
    const linear = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Linear",
    )!;
    act(() => linear.click());
    expect(onOpenIntegrations).toHaveBeenCalledWith("linear");

    act(() => azure!.click());
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "New Azure DevOps board",
    );
  });

  it("offers to connect when the board's provider is disconnected", async () => {
    azureConnected = false;
    storeBoards([azureBoard()]);
    await render();
    expect(container.textContent).toContain("Azure DevOps isn't connected");
    expect(invoke).not.toHaveBeenCalledWith(
      "azure_boards_query",
      expect.anything(),
    );
    const connect = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect Azure DevOps",
    )!;
    act(() => connect.click());
    expect(onOpenIntegrations).toHaveBeenCalledWith("azuredevops");
  });

  it("renders columns with counts and flags a column over its WIP limit", async () => {
    storeBoards([azureBoard()]);
    await render();
    const titles = [
      ...container.querySelectorAll("[data-board-column] h3"),
    ].map((heading) => heading.textContent);
    expect(titles).toEqual(["New", "Active", "Closed"]);

    const active = column("Active");
    expect(active.getAttribute("aria-label")).toBe(
      "Active, 2 items, over the limit of 1",
    );
    const pill = active.querySelector("header > span:last-child")!;
    expect(pill.textContent).toBe("2/1");
    expect(pill.className).toContain("text-red-400");
    expect(
      column("New").querySelector("header > span:last-child")!.textContent,
    ).toBe("1");
    expect(column("Closed").textContent).toContain(
      "Done items are hidden by this board's filter.",
    );
    expect(container.textContent).toContain("Sprint 42");
    expect(container.textContent).toContain("3 items");
  });

  it("moves a card with Alt+Right and announces it once the provider answers", async () => {
    storeBoards([azureBoard()]);
    await render();
    moveResult = deferred();
    const bug = card("#20");
    const event = pressKey(bug, { key: "ArrowRight", altKey: true });
    expect(event.defaultPrevented).toBe(true);
    await flush();

    const moving = card("#20");
    expect(moving.getAttribute("aria-busy")).toBe("true");
    expect(column("Active").contains(moving)).toBe(true);
    expect(invoke).toHaveBeenCalledWith("azure_boards_move", {
      request: expect.objectContaining({
        id: 20,
        state: "Active",
        column: "Active",
      }),
    });

    await act(async () =>
      moveResult!.resolve(
        item({
          id: 20,
          workItemType: "Bug",
          title: "Crash on login",
          state: "Active",
          boardColumn: "Active",
        }),
      ),
    );
    await flush();
    expect(card("#20").getAttribute("aria-busy")).toBeNull();
    expect(liveRegion()).toContain("Moved #20 to Active");
  });

  it("reverts a failed move and shows the error on the card", async () => {
    storeBoards([azureBoard()]);
    await render();
    moveResult = deferred();
    pressKey(card("#20"), { key: "ArrowRight", altKey: true });
    await flush();
    expect(column("Active").contains(card("#20"))).toBe(true);

    await act(async () =>
      moveResult!.reject(new Error("TF401320: Rule error for field")),
    );
    await flush();
    const reverted = card("#20");
    expect(column("New").contains(reverted)).toBe(true);
    const alert = reverted
      .closest("[data-board-card]")!
      .querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("TF401320");
    expect(liveRegion()).toContain("Couldn't move #20");
  });

  it("disables columns a Bug can't move to in “Move to…”", async () => {
    storeBoards([azureBoard()]);
    await render();
    act(() => card("#20").click());
    await flush();
    const moveTo = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("Move to…"))!;
    expect(moveTo).toBeDefined();
    act(() => moveTo.click());
    await flush();
    const options = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemcheckbox"]',
      ),
    ];
    const closed = options.find((button) =>
      button.textContent?.startsWith("Closed"),
    )!;
    expect(closed.disabled).toBe(true);
    expect(closed.textContent).toContain("No “Closed” state for Bug");
    const current = options.find((button) =>
      button.textContent?.startsWith("New"),
    )!;
    expect(current.getAttribute("aria-checked")).toBe("true");
    const active = options.find((button) =>
      button.textContent?.startsWith("Active"),
    )!;
    expect(active.disabled).toBe(false);
  });

  it("closes the open menu on the first Escape and Boards on the second", async () => {
    storeBoards([azureBoard()]);
    await render();
    act(() => card("#20").click());
    await flush();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    pressKey(window, { key: "Escape" });
    await flush();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressKey(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the card filter before leaving on Escape", async () => {
    storeBoards([azureBoard()]);
    await render();
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter cards"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(input, "crash");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    expect(container.textContent).toContain("1 item");

    pressKey(window, { key: "Escape" });
    await flush();
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });
});
