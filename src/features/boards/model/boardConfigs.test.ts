// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_BOARD_KEY,
  BOARDS_CHANGE_EVENT,
  DEFAULT_AUTO_TASK_TITLE,
  MAX_AUTO_TASK_TITLE_LENGTH,
  BOARDS_KEY,
  MAX_BOARDS,
  boardConfigIssue,
  boardQueryKey,
  duplicateBoardConfig,
  getBoardsSnapshot,
  loadActiveBoardId,
  loadBoardConfigs,
  newBoardConfig,
  parseBoardConfig,
  removeBoardConfig,
  saveActiveBoardId,
  saveBoardConfigs,
  subscribeBoardConfigs,
  upsertBoardConfig,
} from "./boardConfigs";
import type { AzureBoardConfig, LinearBoardConfig } from "./boardTypes";

const azure: AzureBoardConfig = {
  v: 1,
  id: "a1",
  name: "SUTEC Flutter",
  createdAt: 1700000000000,
  provider: "azuredevops",
  filters: {
    project: "TI Banese",
    team: "SUTEC App Banese",
    backlogLevel: { id: "Microsoft.RequirementCategory", name: "Stories" },
    areaPaths: [
      {
        path: "TI Banese\\SUTEC App Banese Frontend Manutenção",
        includeChildren: false,
      },
    ],
    iteration: { kind: "current" },
    text: "flutter",
    assignedToMe: false,
    includeDone: false,
  },
  autoTask: { enabled: true, title: "Em implementação" },
  localColumns: [
    { id: "code-review", title: "Aguardando code review" },
    { id: "homologacao", title: "Em homologação" },
  ],
};

const linear: LinearBoardConfig = {
  v: 1,
  id: "l1",
  name: "ENG",
  createdAt: 1700000000001,
  provider: "linear",
  filters: {
    teamIds: ["eng", "des"],
    activeCycleOnly: true,
    assignedToMe: false,
    text: "",
    includeDone: true,
  },
};

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  // Drops anything kept in memory while storage refused writes.
  saveBoardConfigs([]);
  saveActiveBoardId(null);
});

describe("board config storage", () => {
  it("round-trips configs and the active id", () => {
    saveBoardConfigs([azure, linear]);
    saveActiveBoardId("l1");
    expect(loadBoardConfigs()).toEqual([azure, linear]);
    expect(loadActiveBoardId()).toBe("l1");
  });

  it("drops invalid entries and duplicate ids", () => {
    localStorage.setItem(
      BOARDS_KEY,
      JSON.stringify([
        azure,
        { ...linear, id: "a1" },
        { ...linear, v: 2 },
        { ...linear, provider: "jira" },
        { ...linear, id: "" },
        { ...linear, filters: null },
        null,
        "board",
        linear,
      ]),
    );
    expect(loadBoardConfigs().map((config) => config.id)).toEqual(["a1", "l1"]);
  });

  it("coerces fields and applies limits", () => {
    const parsed = parseBoardConfig({
      ...azure,
      name: `  ${"x".repeat(120)}  `,
      createdAt: "yesterday",
      filters: {
        project: 42,
        team: " Team ",
        backlogLevel: "Stories",
        areaPaths: [
          { path: "A", includeChildren: "yes" },
          { path: "" },
          { path: "A" },
        ],
        iteration: { kind: "path", path: "  " },
        text: "y".repeat(300),
        assignedToMe: "true",
        includeDone: true,
      },
    });
    expect(parsed).toEqual({
      v: 1,
      id: "a1",
      name: "x".repeat(80),
      createdAt: 0,
      provider: "azuredevops",
      filters: {
        project: "",
        team: "Team",
        backlogLevel: { id: "", name: "" },
        areaPaths: [{ path: "A", includeChildren: false }],
        iteration: { kind: "current" },
        text: "y".repeat(200),
        assignedToMe: false,
        includeDone: true,
      },
      autoTask: { enabled: true, title: "Em implementação" },
      localColumns: azure.localColumns,
    });
    expect(
      parseBoardConfig({
        ...linear,
        name: "",
        filters: { teamIds: ["a", "a", 3, ""] },
      }),
    ).toEqual({
      ...linear,
      name: "Linear board",
      filters: {
        teamIds: ["a"],
        activeCycleOnly: false,
        assignedToMe: false,
        text: "",
        includeDone: false,
      },
    });
  });

  it("gives boards saved before local columns the defaults, and keeps an emptied list empty", () => {
    const { localColumns: _columns, ...old } = azure;
    expect(parseBoardConfig(old)).toEqual(azure);
    const read = (localColumns: unknown) =>
      (parseBoardConfig({ ...old, localColumns }) as AzureBoardConfig)
        .localColumns;
    expect(read([])).toEqual([]);
    expect(
      read([
        { id: "a", title: "  Em teste  " },
        { id: "a", title: "dup" },
        { id: "", title: "no id" },
        { id: "b", title: "" },
        "junk",
        { id: "c", title: "x".repeat(80) },
      ]),
    ).toEqual([
      { id: "a", title: "Em teste" },
      { id: "c", title: "x".repeat(40) },
    ]);
    expect(read(Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, title: `T${i}` })))).toHaveLength(6);
    expect(newBoardConfig("azuredevops").localColumns).toEqual(azure.localColumns);
  });

  it("turns the pickup task on for boards saved before it existed", () => {
    const { autoTask: _autoTask, ...old } = azure;
    expect(parseBoardConfig(old)).toEqual(azure);
    expect(parseBoardConfig({ ...old, autoTask: "yes" })?.provider).toBe(
      "azuredevops",
    );
    expect(
      (parseBoardConfig({ ...old, autoTask: null }) as AzureBoardConfig).autoTask,
    ).toEqual({ enabled: true, title: DEFAULT_AUTO_TASK_TITLE });
  });

  it("reads the pickup task, trimming and bounding its title", () => {
    const read = (autoTask: unknown) =>
      (parseBoardConfig({ ...azure, autoTask }) as AzureBoardConfig).autoTask;
    expect(read({ enabled: false, title: "Dev" })).toEqual({
      enabled: false,
      title: "Dev",
    });
    expect(read({ enabled: true, title: "  Implementar  " })).toEqual({
      enabled: true,
      title: "Implementar",
    });
    expect(read({ title: "   " })).toEqual({
      enabled: true,
      title: DEFAULT_AUTO_TASK_TITLE,
    });
    expect(read({ enabled: "no", title: 7 })).toEqual({
      enabled: true,
      title: DEFAULT_AUTO_TASK_TITLE,
    });
    expect(read({ title: "t".repeat(300) }).title).toBe(
      "t".repeat(MAX_AUTO_TASK_TITLE_LENGTH),
    );
  });

  it("round-trips the pickup task settings", () => {
    const off: AzureBoardConfig = {
      ...azure,
      autoTask: { enabled: false, title: "Desenvolvimento" },
    };
    saveBoardConfigs([off, linear]);
    expect(loadBoardConfigs()).toEqual([off, linear]);
    const copy = duplicateBoardConfig([off], "a1")!.copy as AzureBoardConfig;
    expect(copy.autoTask).toEqual(off.autoTask);
    expect(copy.autoTask).not.toBe(off.autoTask);
  });

  it("survives corrupt JSON", () => {
    localStorage.setItem(BOARDS_KEY, "{not json");
    expect(loadBoardConfigs()).toEqual([]);
    localStorage.setItem(BOARDS_KEY, JSON.stringify({ boards: [] }));
    expect(loadBoardConfigs()).toEqual([]);
  });

  it("keeps at most 50 boards", () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...linear,
      id: `l${index}`,
    }));
    localStorage.setItem(BOARDS_KEY, JSON.stringify(many));
    expect(loadBoardConfigs()).toHaveLength(MAX_BOARDS);
    const full = loadBoardConfigs();
    expect(() => upsertBoardConfig(full, { ...linear, id: "new" })).toThrow(
      "up to 50 boards",
    );
    expect(
      upsertBoardConfig(full, { ...linear, id: "l3", name: "Edited" })[3]!.name,
    ).toBe("Edited");
    expect(duplicateBoardConfig(full, "l1")).toBeNull();
  });

  it("falls back from a stale active id to the first board", () => {
    saveBoardConfigs([azure, linear]);
    localStorage.setItem(ACTIVE_BOARD_KEY, "deleted-board");
    expect(loadActiveBoardId()).toBe("a1");
    expect(getBoardsSnapshot().activeId).toBe("a1");
    saveBoardConfigs([]);
    expect(loadActiveBoardId()).toBeNull();
  });

  it("notifies on its own event and on storage from other windows", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeBoardConfigs(onChange);
    saveBoardConfigs([azure]);
    expect(onChange).toHaveBeenCalledTimes(1);
    saveActiveBoardId("a1");
    expect(onChange).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new StorageEvent("storage", { key: BOARDS_KEY }));
    expect(onChange).toHaveBeenCalledTimes(3);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "monocode.other" }),
    );
    expect(onChange).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(onChange).toHaveBeenCalledTimes(4);
    unsubscribe();
    window.dispatchEvent(new Event(BOARDS_CHANGE_EVENT));
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("returns the same snapshot until storage changes", () => {
    saveBoardConfigs([azure]);
    const first = getBoardsSnapshot();
    expect(getBoardsSnapshot()).toBe(first);
    saveActiveBoardId("a1");
    const second = getBoardsSnapshot();
    expect(second).not.toBe(first);
    expect(second.configs).toEqual(first.configs);
    expect(getBoardsSnapshot()).toBe(second);
  });

  it("keeps edits for this window when storage refuses them", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    saveBoardConfigs([linear]);
    expect(loadBoardConfigs()).toEqual([linear]);
  });
});

describe("board list operations", () => {
  it("upserts, removes and duplicates", () => {
    const list = upsertBoardConfig([azure], linear);
    expect(list.map((config) => config.id)).toEqual(["a1", "l1"]);
    expect(removeBoardConfig(list, "a1").map((config) => config.id)).toEqual([
      "l1",
    ]);
    const result = duplicateBoardConfig(list, "a1", 5)!;
    expect(result.configs.map((config) => config.id)).toEqual([
      "a1",
      result.copy.id,
      "l1",
    ]);
    expect(result.copy).toMatchObject({
      name: "SUTEC Flutter copy",
      createdAt: 5,
      filters: azure.filters,
    });
    expect(result.copy.id).not.toBe("a1");
    expect(result.copy.filters).not.toBe(azure.filters);
    expect(duplicateBoardConfig(list, "missing")).toBeNull();
  });

  it("creates new boards with defaults", () => {
    const created = newBoardConfig("azuredevops", { project: "Web" });
    expect(created).toMatchObject({
      v: 1,
      provider: "azuredevops",
      name: "Azure DevOps board",
      filters: {
        project: "Web",
        team: "",
        iteration: { kind: "current" },
        areaPaths: [],
      },
      autoTask: { enabled: true, title: "Em implementação" },
    });
    expect(created.id).toMatch(/\S{8,}/);
    expect(newBoardConfig("linear").filters.teamIds).toEqual([]);
    expect(parseBoardConfig(JSON.parse(JSON.stringify(created)))).toEqual(
      created,
    );
  });
});

describe("board derived values", () => {
  it("ignores name and text in the query key", () => {
    const key = boardQueryKey(azure);
    expect(boardQueryKey({ ...azure, name: "Other" })).toBe(key);
    expect(
      boardQueryKey({ ...azure, filters: { ...azure.filters, text: "x" } }),
    ).toBe(key);
    expect(
      boardQueryKey({
        ...azure,
        filters: { ...azure.filters, includeDone: true },
      }),
    ).not.toBe(key);
    expect(
      boardQueryKey({
        ...linear,
        filters: { ...linear.filters, teamIds: ["des", "eng"] },
      }),
    ).toBe(boardQueryKey(linear));
  });

  it("keeps the pickup task out of the query key", () => {
    const key = boardQueryKey(azure);
    expect(
      boardQueryKey({
        ...azure,
        autoTask: { enabled: false, title: "Outra" },
      }),
    ).toBe(key);
  });

  it("reports what a board still needs", () => {
    expect(boardConfigIssue(azure)).toBeNull();
    expect(
      boardConfigIssue({
        ...azure,
        filters: { ...azure.filters, project: " " },
      }),
    ).toBe("Pick an Azure DevOps project");
    expect(
      boardConfigIssue({ ...azure, filters: { ...azure.filters, team: "" } }),
    ).toBe("Pick a team");
    expect(
      boardConfigIssue({
        ...linear,
        filters: { ...linear.filters, teamIds: [] },
      }),
    ).toBe("Pick at least one Linear team");
    expect(boardConfigIssue(linear)).toBeNull();
  });
});
