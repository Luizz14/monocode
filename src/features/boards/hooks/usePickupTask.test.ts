// @vitest-environment happy-dom
import { invoke } from "@tauri-apps/api/core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureChildCreated } from "../model/azureBoards";
import { newBoardConfig } from "../model/boardConfigs";
import { clearBoardDetailCache } from "../model/boardDetail";
import type {
  AzureBoardConfig,
  BoardCard,
  BoardColumn,
  BoardSnapshot,
} from "../model/boardTypes";
import {
  PICKUP_TOAST_MS,
  usePickupTask,
  type UsePickupTask,
} from "./usePickupTask";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const proposed: BoardCard = {
  provider: "azuredevops",
  key: "azuredevops:376073",
  id: "376073",
  ref: "#376073",
  number: 376073,
  title: "Menu ajuda",
  url: "https://dev.azure.com/org/Proj/_workitems/edit/376073",
  type: "User Story",
  state: "New",
  stateCategory: "todo",
  columnId: "az:new",
  tags: [],
  project: "Proj",
  area: "Proj\\Team",
  iteration: "Proj\\Sprint 1",
  order: 1,
  updatedAt: "2026-10-01T00:00:00Z",
};

const active: BoardCard = {
  ...proposed,
  state: "Active",
  stateCategory: "inProgress",
  columnId: "az:active",
};

const work: BoardColumn = {
  id: "az:active",
  title: "Active",
  category: "inProgress",
  target: { provider: "none" },
};

const created: AzureChildCreated = {
  created: true,
  child: {
    id: 386900,
    parentId: 376073,
    workItemType: "Task",
    title: "Em implementação",
    state: "Defined",
    assignedTo: {
      id: "u-me",
      displayName: "Luiz",
      uniqueName: "luiz@example.com",
      imageUrl: null,
    },
    changedDate: "2026-10-19T12:00:00Z",
    url: "https://dev.azure.com/org/Proj/_workitems/edit/386900",
  },
};

function snapshotOf(card: BoardCard): BoardSnapshot {
  return {
    configId: "b1",
    queryKey: "q",
    provider: "azuredevops",
    columns: [work],
    cards: [card],
    truncated: false,
    doneHidden: true,
    webUrl: null,
    fetchedAt: 1,
    limit: 500,
    azure: {
      project: "Proj",
      team: "Team",
      backlogLevel: "Stories",
      columnField: null,
      doneField: null,
      orderField: null,
      effortField: null,
      stateInfo: {},
      me: { id: "u-me", name: "Luiz", isMe: true },
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let result: UsePickupTask;
let config: AzureBoardConfig;
let snapshot: BoardSnapshot;
let patchCard: ReturnType<typeof vi.fn>;
let announce: ReturnType<typeof vi.fn>;

function Probe() {
  result = usePickupTask({ config, snapshot, patchCard, announce });
  return null;
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

function commands(name: string) {
  return vi.mocked(invoke).mock.calls.filter(([command]) => command === name);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  clearBoardDetailCache();
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "azure_boards_create_child") return created;
    if (command === "azure_boards_delete_work_item") return null;
    throw new Error(`Unexpected command: ${command}`);
  });
  config = newBoardConfig("azuredevops");
  snapshot = snapshotOf(active);
  patchCard = vi.fn();
  announce = vi.fn();
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(createElement(Probe)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("usePickupTask", () => {
  it("makes the task, patches the card with it and announces", async () => {
    await act(async () => result.afterMove(proposed, work, active));
    await settle();
    expect(commands("azure_boards_create_child")).toEqual([
      [
        "azure_boards_create_child",
        {
          request: {
            project: "Proj",
            parentId: 376073,
            title: "Em implementação",
            areaPath: "Proj\\Team",
            iterationPath: "Proj\\Sprint 1",
            workItemType: "Task",
          },
        },
      ],
    ]);
    const patched = patchCard.mock.calls[0]![0] as BoardCard;
    expect(patched.children).toEqual([
      expect.objectContaining({
        id: 386900,
        type: "Task",
        stateCategory: "todo",
        assignee: expect.objectContaining({ name: "Luiz", isMe: true }),
      }),
    ]);
    expect(patched.owners?.source).toBe("children");
    expect(patched.owners?.primary.isMe).toBe(true);
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0]).toMatchObject({
      kind: "created",
      cardRef: "#376073",
    });
    expect(announce).toHaveBeenCalledWith("Created Task #386900 for #376073");
  });

  it("does nothing when the rule says skip", async () => {
    await act(async () =>
      result.afterMove(
        { ...proposed, stateCategory: "inProgress" },
        work,
        active,
      ),
    );
    await settle();
    expect(invoke).not.toHaveBeenCalled();
    expect(result.toasts).toEqual([]);
    expect(patchCard).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("runs one creation per card at a time", async () => {
    let finish!: (value: AzureChildCreated) => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve as (value: AzureChildCreated) => void;
        }),
    );
    await act(async () => {
      result.afterMove(proposed, work, active);
      result.afterMove(proposed, work, active);
    });
    expect(commands("azure_boards_create_child")).toHaveLength(1);
    await act(async () => finish(created));
    await settle();
    expect(result.toasts).toHaveLength(1);
    expect(patchCard).toHaveBeenCalledTimes(1);
  });

  it("clears a finished toast after ten seconds but keeps an error", async () => {
    await act(async () => result.afterMove(proposed, work, active));
    await settle();
    await act(async () => {
      vi.advanceTimersByTime(PICKUP_TOAST_MS - 1);
    });
    expect(result.toasts).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(result.toasts).toEqual([]);

    vi.mocked(invoke).mockRejectedValue("TF401320: Rule error");
    await act(async () => result.afterMove(proposed, work, active));
    await settle();
    expect(result.toasts[0]).toMatchObject({
      kind: "error",
      message: "TF401320: Rule error",
    });
    expect(announce).toHaveBeenLastCalledWith(
      "Couldn't create a task for #376073: TF401320: Rule error",
    );
    await act(async () => {
      vi.advanceTimersByTime(PICKUP_TOAST_MS * 6);
    });
    expect(result.toasts).toHaveLength(1);
    act(() => result.dismiss(result.toasts[0]!.id));
    expect(result.toasts).toEqual([]);
  });

  it("retries a failure in place", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("Could not reach Azure DevOps"),
    );
    await act(async () => result.afterMove(proposed, work, active));
    await settle();
    const failed = result.toasts[0]!;
    expect(failed.kind).toBe("error");
    await act(async () => result.retry(failed.id));
    await settle();
    expect(result.toasts).toHaveLength(1);
    expect(result.toasts[0]).toMatchObject({ id: failed.id, kind: "created" });
    // Retrying something that is no longer an error does nothing.
    await act(async () => result.retry(failed.id));
    expect(commands("azure_boards_create_child")).toHaveLength(2);
  });

  it("undoes only while the toast shows", async () => {
    await act(async () => result.afterMove(proposed, work, active));
    await settle();
    // The board shows the patched card by now.
    snapshot = snapshotOf(patchCard.mock.calls[0]![0] as BoardCard);
    await act(async () => root.render(createElement(Probe)));
    const id = result.toasts[0]!.id;
    await act(async () => result.undo(id));
    await settle();
    expect(commands("azure_boards_delete_work_item")).toEqual([
      ["azure_boards_delete_work_item", { project: "Proj", id: 386900 }],
    ]);
    const restored = patchCard.mock.calls[1]![0] as BoardCard;
    expect(restored.children).toEqual([]);
    expect(restored.owners).toBeUndefined();
    expect(result.toasts[0]).toMatchObject({ kind: "undone" });
    await act(async () => result.undo(id));
    expect(commands("azure_boards_delete_work_item")).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(PICKUP_TOAST_MS);
    });
    expect(result.toasts).toEqual([]);
    await act(async () => result.undo(id));
    expect(commands("azure_boards_delete_work_item")).toHaveLength(1);
  });
});
