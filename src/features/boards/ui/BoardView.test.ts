// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AzureBoardChildren,
  AzureBoardItem,
  AzureBoardLayout,
  AzureTeamSetup,
  AzureWorkItemDetail,
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

const me = {
  id: "u-me",
  displayName: "Luiz Gustavo Moura",
  uniqueName: "luiz@example.com",
};

const children: AzureBoardChildren = {
  items: [
    {
      id: 386818,
      parentId: 10,
      workItemType: "Task",
      title: "Em implementação",
      state: "Completed",
      assignedTo: { ...me, imageUrl: null },
      changedDate: "2026-10-16T17:18:16Z",
      url: "https://dev.azure.com/org/Proj/_workitems/edit/386818",
    },
    {
      id: 386819,
      parentId: 10,
      workItemType: "Task",
      title: "Revisão",
      state: "In Progress",
      assignedTo: {
        id: "u-t",
        displayName: "Tiago Mendonca",
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
      ],
    },
  ],
  truncated: false,
};

function detailFor(id: number): AzureWorkItemDetail {
  const base = items.find((entry) => entry.id === id)!;
  return {
    id,
    rev: base.rev,
    workItemType: base.workItemType,
    title: base.title,
    state: base.state,
    reason: "Implementation started",
    project: "Proj",
    assignedTo: null,
    createdBy: {
      id: "u-v",
      displayName: "Vanessa Alves",
      uniqueName: "",
      imageUrl: null,
    },
    changedBy: {
      id: "u-m",
      displayName: "Marco Henrique",
      uniqueName: "",
      imageUrl: null,
    },
    createdDate: "2026-08-31T19:06:04Z",
    changedDate: "2026-10-14T13:27:41Z",
    areaPath: "Proj\\Team",
    iterationPath: "Proj\\Sprint 42",
    tags: ["Android", "PF"],
    commentCount: 2,
    descriptionHtml:
      '<div><p><b>Como</b> cliente logado</p><script>alert(1)</script><a href="https://docs.example.com/x">doc</a>' +
      '<img src="https://dev.azure.com/org/guid/_apis/wit/attachments/att-3?fileName=inline.png" alt=""></div>',
    sections: [
      {
        referenceName: "Custom.AC",
        label: "Critérios de Aceite",
        html: "<ul><li>Exibir menu</li></ul>",
      },
    ],
    planning: [
      {
        referenceName: "Microsoft.VSTS.Scheduling.StoryPoints",
        label: "Story Points",
        value: "2",
        kind: "number",
      },
      {
        referenceName: "Custom.Area",
        label: "Área Demandante",
        value: "Canais",
        kind: "text",
      },
    ],
    storyPoints: 2,
    priority: 2,
    relations: {
      parent: {
        id: 359655,
        link: "Parent",
        workItemType: "Feature",
        title: "AppBanese - Menu Ajuda",
        state: "Em Desenvolvimento",
        assignedTo: null,
        changedDate: "2026-10-08T00:00:00Z",
        url: "https://dev.azure.com/org/Proj/_workitems/edit/359655",
      },
      children: children.items
        .filter((child) => child.parentId === id)
        .map((child) => ({
          id: child.id,
          link: "Child",
          workItemType: child.workItemType,
          title: child.title,
          state: child.state,
          assignedTo: child.assignedTo,
          changedDate: child.changedDate,
          url: child.url,
        })),
      related: [],
      pullRequests: 2,
      commits: 1,
      attachments: [
        {
          id: "att-1",
          name: "tela.png",
          url: "https://dev.azure.com/org/guid/_apis/wit/attachments/att-1",
          size: 526336,
          createdDate: "2026-10-13T16:47:10.147Z",
          comment: "Layout novo",
        },
        {
          id: "att-2",
          name: "menu ajuda.mp4",
          url: "https://dev.azure.com/org/guid/_apis/wit/attachments/att-2",
          size: 33030144,
          createdDate: "2026-10-14T09:00:00.000Z",
          comment: "",
        },
      ],
      truncated: false,
    },
    url: base.url,
  };
}

let azureConnected: boolean;
let moveResult: Deferred<AzureBoardItem> | null;
let detailFails: boolean;
let previewFails: boolean;
let openFails: boolean;

function route(command: string, args?: unknown): unknown {
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
    case "azure_boards_children":
      return children;
    case "azure_boards_me":
      return me;
    case "azure_boards_work_item": {
      if (detailFails) throw new Error("TF401232: Work item does not exist");
      const { id } = args as { project: string; id: number };
      return detailFor(id);
    }
    case "azure_boards_attachment_preview":
      if (previewFails) throw new Error("Attachment is too large to preview");
      return { mimeType: "image/png", dataBase64: "AAAA" };
    case "azure_boards_attachment_open":
      if (openFails) throw new Error("Attachment is too large to open");
      return "/tmp/monocode-ado-attachments/guid/menu ajuda.mp4";
    case "open_path_with_default_app":
      return null;
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

function openMenu(target: HTMLElement) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
  });
}

function detailPane(): HTMLElement | null {
  return container.querySelector<HTMLElement>("[data-board-detail]");
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
  detailFails = false;
  previewFails = false;
  openFails = false;
  invoke.mockImplementation(async (command: string, args?: unknown) =>
    route(command, args),
  );
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
    openMenu(card("#20"));
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
    openMenu(card("#20"));
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

  it("shows who holds a story from its children, the connected user marked", async () => {
    storeBoards([azureBoard()]);
    await render();
    const people = card("#10").querySelector<HTMLElement>(
      '[data-card-people="children"]',
    )!;
    expect(people).not.toBeNull();
    const avatars = [...people.querySelectorAll<HTMLElement>("span[title]")];
    // Tiago's review is still in progress, so he ranks first; Luiz is "me".
    expect(avatars.map((avatar) => avatar.textContent)).toEqual(["TM", "LM"]);
    expect(avatars[0]!.title).toBe("Tiago Mendonca · Revisão (In Progress)");
    expect(avatars[1]!.title).toBe(
      "Luiz Gustavo Moura · Em implementação (Completed)",
    );
    expect(avatars[1]!.dataset.person).toBe("me");
    expect(card("#10").getAttribute("aria-label")).toContain(
      "With Tiago Mendonca, Luiz Gustavo Moura",
    );
    // Cards without children keep the plain Assigned To (none here).
    expect(card("#11").querySelector("[data-card-people]")).toBeNull();
  });

  it("filters to Mine: held through a child, plus Defined cards nobody took", async () => {
    storeBoards([azureBoard()]);
    await render();
    const chip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Mine",
    )!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    act(() => chip.click());
    await flush();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    const refs = [
      ...container.querySelectorAll<HTMLButtonElement>("button[data-card-key]"),
    ].map((button) => button.dataset.cardKey);
    // #20 is a New (Proposed) bug with no children and #10 has my child;
    // #11 is Active with nobody on it, so it is neither mine nor available.
    expect(refs).toEqual(["azuredevops:20", "azuredevops:10"]);
    expect(container.textContent).toContain("2 items");
    act(() => chip.click());
    await flush();
    expect(container.textContent).toContain("3 items");
  });

  it("opens the details pane on click, moves from it, and closes it before the filter on Escape", async () => {
    storeBoards([azureBoard()]);
    await render();
    act(() => card("#10").click());
    await flush();
    const pane = detailPane()!;
    expect(pane).not.toBeNull();
    expect(pane.getAttribute("aria-label")).toBe("#10 details");
    expect(invoke).toHaveBeenCalledWith("azure_boards_work_item", {
      project: "Proj",
      id: 10,
    });
    const text = pane.textContent ?? "";
    expect(text).toContain("Story ten");
    expect(text).toContain("With");
    expect(text).toContain("Tiago Mendonca, Luiz Gustavo Moura");
    expect(text).toContain("2 comments");
    expect(text).toContain("Implementation started");
    expect(text).toContain("Como cliente logado");
    expect(text).not.toContain("alert(1)");
    expect(pane.querySelector("script")).toBeNull();
    expect(text).toContain("Critérios de Aceite");
    expect(text).toContain("Exibir menu");
    expect(text).toContain("Story Points");
    expect(text).toContain("Área Demandante");
    expect(text).toContain("Canais");
    expect(text).toContain("Vanessa Alves");
    expect(text).toContain("AppBanese - Menu Ajuda");
    expect(text).toContain("Em implementação");
    expect(text).toContain("Revisão");
    expect(text).toContain("1 commit");
    expect(text).toContain("Updated by Marco Henrique");

    // Moving from the pane goes through the same path as a drag.
    moveResult = deferred();
    const select = pane.querySelector<HTMLSelectElement>(
      'select[aria-label="Move to column"]',
    )!;
    expect(select.value).toBe("az:c2");
    const closed = [...select.options].find((option) =>
      option.textContent?.startsWith("Closed"),
    )!;
    expect(closed.disabled).toBe(false);
    act(() => {
      select.value = "az:c3";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(invoke).toHaveBeenCalledWith(
      "azure_boards_move",
      expect.objectContaining({
        request: expect.objectContaining({ id: 10, state: "Closed" }),
      }),
    );
    await act(async () =>
      moveResult!.resolve({
        ...items[0]!,
        rev: 2,
        state: "Closed",
        boardColumn: "Closed",
      }),
    );
    await flush();
    expect(column("Closed").contains(card("#10"))).toBe(true);
    expect(liveRegion()).toContain("Moved #10 to Closed");

    // Escape: the pane first, then the filter, then Boards.
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Filter cards"]',
    )!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(input, "story");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await flush();
    pressKey(window, { key: "Escape" });
    await flush();
    expect(detailPane()).toBeNull();
    expect(input.value).toBe("story");
    pressKey(window, { key: "Escape" });
    await flush();
    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens details from the right-click menu and reports a failed load", async () => {
    storeBoards([azureBoard()]);
    await render();
    detailFails = true;
    openMenu(card("#20"));
    await flush();
    const details = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ].find((button) => button.textContent?.includes("View details"))!;
    expect(details).toBeDefined();
    act(() => details.click());
    await flush();
    const pane = detailPane()!;
    expect(pane.getAttribute("aria-label")).toBe("#20 details");
    expect(pane.textContent).toContain("Crash on login");
    expect(pane.querySelector('[role="alert"]')?.textContent).toContain(
      "TF401232",
    );
    // A different card replaces the pane's content.
    act(() => card("#11").click());
    await flush();
    expect(detailPane()?.getAttribute("aria-label")).toBe("#11 details");
    const close = detailPane()!.querySelector<HTMLButtonElement>(
      'button[aria-label="Close details"]',
    )!;
    act(() => close.click());
    await flush();
    expect(detailPane()).toBeNull();
  });
  describe("attachments", () => {
    beforeEach(() => {
      // Every row counts as on screen, so thumbnails load at once.
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(private callback: (entries: unknown[]) => void) {}
          observe() {
            this.callback([{ isIntersecting: true }]);
          }
          disconnect() {}
        },
      );
    });

    async function openDetails(ref = "#10") {
      storeBoards([azureBoard()]);
      await render();
      act(() => card(ref).click());
      await flush();
      return detailPane()!;
    }

    function attachmentRows(pane: HTMLElement): HTMLElement[] {
      const heading = [...pane.querySelectorAll("h3")].find(
        (h) => h.firstElementChild?.textContent === "Attachments",
      );
      return heading
        ? [...heading.closest("section")!.querySelectorAll<HTMLElement>("li")]
        : [];
    }

    it("lists attachments like Azure does, with a thumbnail for images", async () => {
      const pane = await openDetails();
      const rows = attachmentRows(pane);
      expect(rows).toHaveLength(2);
      const section = rows[0]!.closest("section")!;
      expect(section.textContent).toContain("Name");
      expect(section.textContent).toContain("Size");
      expect(section.textContent).toContain("Date Added");
      expect(section.textContent).toContain("Comments");
      expect(rows[0]!.textContent).toContain("tela.png");
      expect(rows[0]!.textContent).toContain("514 KB");
      expect(rows[0]!.textContent).toContain("Layout novo");
      expect(rows[0]!.textContent).toMatch(/2026/);
      expect(rows[1]!.textContent).toContain("menu ajuda.mp4");
      expect(rows[1]!.textContent).toContain("31.5 MB");
      const thumb = rows[0]!.querySelector("img")!;
      expect(thumb.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(thumb.getAttribute("loading")).toBe("lazy");
      // The video is a file: no picture, no download until it is clicked.
      expect(rows[1]!.querySelector("img")).toBeNull();
      expect(invoke).toHaveBeenCalledWith("azure_boards_attachment_preview", {
        url: "https://dev.azure.com/org/guid/_apis/wit/attachments/att-1",
        name: "tela.png",
      });
      expect(invoke).not.toHaveBeenCalledWith(
        "azure_boards_attachment_open",
        expect.anything(),
      );
      // A card whose item has no attachments gets no section.
      expect(pane.textContent).not.toContain("No attachments");
    });

    it("opens an image in the lightbox", async () => {
      const pane = await openDetails();
      const button = attachmentRows(pane)[0]!.querySelector("button")!;
      act(() => button.click());
      await flush();
      const lightbox = document.querySelector<HTMLElement>("[data-image-zoom]")!;
      expect(lightbox.getAttribute("aria-label")).toBe("Image preview: tela.png");
      expect(lightbox.querySelector("img")!.getAttribute("src")).toBe(
        "data:image/png;base64,AAAA",
      );
      pressKey(window, { key: "Escape" });
      await flush();
      expect(document.querySelector("[data-image-zoom]")).toBeNull();
      // Escape went to the lightbox, not to the pane or Boards.
      expect(detailPane()).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("downloads a file and hands it to the default app", async () => {
      const pane = await openDetails();
      const button = attachmentRows(pane)[1]!.querySelector("button")!;
      act(() => button.click());
      await flush();
      expect(invoke).toHaveBeenCalledWith("azure_boards_attachment_open", {
        url: "https://dev.azure.com/org/guid/_apis/wit/attachments/att-2",
        name: "menu ajuda.mp4",
      });
      expect(invoke).toHaveBeenCalledWith("open_path_with_default_app", {
        path: "/tmp/monocode-ado-attachments/guid/menu ajuda.mp4",
      });
      expect(button.getAttribute("aria-busy")).toBe("false");
    });

    it("shows the error on the row when a download fails", async () => {
      openFails = true;
      const pane = await openDetails();
      const row = attachmentRows(pane)[1]!;
      act(() => row.querySelector("button")!.click());
      await flush();
      expect(row.querySelector('[role="alert"]')?.textContent).toContain(
        "Attachment is too large to open",
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "open_path_with_default_app",
        expect.anything(),
      );
    });

    it("falls back to an icon when a thumbnail cannot load", async () => {
      previewFails = true;
      const pane = await openDetails();
      const row = attachmentRows(pane)[0]!;
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector("[data-attachment-skeleton]")).toBeNull();
      expect(row.querySelector("button svg")).not.toBeNull();
    });

    it("shows a description image fetched with the token and zooms it", async () => {
      const pane = await openDetails();
      const image = pane.querySelector<HTMLImageElement>(
        "img[data-attachment-image]",
      )!;
      expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(image.getAttribute("alt")).toBe("inline.png");
      expect(invoke).toHaveBeenCalledWith("azure_boards_attachment_preview", {
        url: "https://dev.azure.com/org/guid/_apis/wit/attachments/att-3?fileName=inline.png",
      });
      act(() => image.click());
      await flush();
      expect(
        document.querySelector("[data-image-zoom]")?.getAttribute("aria-label"),
      ).toBe("Image preview: inline.png");
    });

    it("turns a description image into a link when it cannot load", async () => {
      previewFails = true;
      const pane = await openDetails();
      expect(pane.querySelector("img[data-attachment-image]")).toBeNull();
      expect(pane.querySelector("a[data-attachment]")?.textContent).toBe(
        "Image: inline.png",
      );
    });
  });
});
