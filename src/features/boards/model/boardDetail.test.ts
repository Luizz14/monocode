import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureWorkItemDetail } from "./azureBoards";
import {
  BOARD_DETAIL_FRESH_MS,
  clearBoardDetailCache,
  formatDetailDate,
  guessStateCategory,
  invalidateBoardDetail,
  loadBoardDetail,
  peekBoardDetail,
  peekStaleBoardDetail,
  relatedStateCategory,
  shortPath,
} from "./boardDetail";
import type { AzureStateInfo } from "./boardTypes";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function detail(overrides: Partial<AzureWorkItemDetail>): AzureWorkItemDetail {
  return {
    id: 376073,
    rev: 41,
    workItemType: "User Story",
    title: "Menu ajuda",
    state: "Accepted",
    reason: "",
    project: "TI Banese",
    assignedTo: null,
    createdBy: null,
    changedBy: null,
    createdDate: "",
    changedDate: "",
    areaPath: "",
    iterationPath: "",
    tags: [],
    commentCount: 0,
    descriptionHtml: "",
    sections: [],
    planning: [],
    storyPoints: null,
    priority: null,
    relations: {
      parent: null,
      children: [],
      related: [],
      pullRequests: 0,
      commits: 0,
      attachments: [],
      truncated: false,
    },
    url: "",
    ...overrides,
  };
}

beforeEach(() => {
  clearBoardDetailCache();
  vi.mocked(invoke).mockReset();
});

describe("loadBoardDetail", () => {
  it("fetches once per project and id and serves the cache while fresh", async () => {
    vi.mocked(invoke).mockResolvedValue(detail({ rev: 1 }));
    const [a, b] = await Promise.all([
      loadBoardDetail("TI Banese", 376073),
      loadBoardDetail("TI Banese ", 376073),
    ]);
    expect(a).toBe(b);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("azure_boards_work_item", {
      project: "TI Banese",
      id: 376073,
    });
    expect(peekBoardDetail("TI Banese", 376073)).toBe(a);
    await loadBoardDetail("TI Banese", 376073);
    expect(invoke).toHaveBeenCalledTimes(1);
    await loadBoardDetail("TI Banese", 1);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("refetches when stale, forced or invalidated, keeping the stale value to show", async () => {
    vi.mocked(invoke).mockResolvedValue(detail({ rev: 1 }));
    await loadBoardDetail("P", 1);
    expect(
      peekBoardDetail("P", 1, Date.now() + BOARD_DETAIL_FRESH_MS + 1),
    ).toBeNull();
    expect(peekStaleBoardDetail("P", 1)?.rev).toBe(1);
    vi.mocked(invoke).mockResolvedValue(detail({ rev: 2 }));
    expect((await loadBoardDetail("P", 1, { force: true })).rev).toBe(2);
    invalidateBoardDetail("P", 1);
    expect(peekBoardDetail("P", 1)).toBeNull();
    expect(peekStaleBoardDetail("P", 1)).toBeNull();
    vi.mocked(invoke).mockResolvedValue(detail({ rev: 3 }));
    expect((await loadBoardDetail("P", 1)).rev).toBe(3);
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("does not cache an answer that a clear overtook, nor a failure", async () => {
    let resolve!: (value: AzureWorkItemDetail) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise<AzureWorkItemDetail>((res) => {
        resolve = res;
      }),
    );
    const pending = loadBoardDetail("P", 1);
    clearBoardDetailCache();
    resolve(detail({ rev: 9 }));
    expect((await pending).rev).toBe(9);
    expect(peekBoardDetail("P", 1)).toBeNull();

    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    await expect(loadBoardDetail("P", 2)).rejects.toThrow("boom");
    expect(peekBoardDetail("P", 2)).toBeNull();
    vi.mocked(invoke).mockResolvedValue(detail({ rev: 1 }));
    await loadBoardDetail("P", 2);
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});

describe("detail helpers", () => {
  const info: AzureStateInfo = {
    "User Story": {
      Accepted: { name: "Accepted", category: "resolved" },
    },
  };

  it("takes the category from the board's types, then child types, then the name", () => {
    expect(
      relatedStateCategory({ workItemType: "User Story", state: "Accepted" }, info),
    ).toBe("resolved");
    const childTypes = new Map([["Task", new Map([["Completed", "Completed"]])]]);
    expect(
      relatedStateCategory(
        { workItemType: "Task", state: "Completed" },
        info,
        childTypes,
      ),
    ).toBe("done");
    expect(
      relatedStateCategory(
        { workItemType: "Feature", state: "Em Desenvolvimento" },
        info,
      ),
    ).toBe("inProgress");
    expect(
      relatedStateCategory({ workItemType: "constructor", state: "toString" }, info),
    ).toBe("unknown");
    expect(guessStateCategory("Defined")).toBe("todo");
    expect(guessStateCategory("Removed")).toBe("canceled");
    expect(guessStateCategory("Whatever")).toBe("unknown");
  });

  it("formats dates and paths", () => {
    expect(formatDetailDate("")).toBe("");
    expect(formatDetailDate("not a date")).toBe("not a date");
    expect(formatDetailDate("2026-10-14T13:27:41.983Z")).toMatch(/2026/);
    expect(formatDetailDate("2026-10-14T13:27:41.983Z", { time: false })).not.toMatch(
      /:/,
    );
    expect(shortPath("TI Banese\\2026_R4\\S01 - R4_2026")).toBe(
      "2026_R4 \\ S01 - R4_2026",
    );
    expect(shortPath("TI Banese")).toBe("TI Banese");
  });
});
