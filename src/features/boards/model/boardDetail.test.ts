import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AzureWorkItemDetail } from "./azureBoards";
import {
  ATTACHMENT_CACHE_MAX,
  BOARD_DETAIL_FRESH_MS,
  azureOrgBase,
  clearBoardDetailCache,
  formatBytes,
  formatDetailDate,
  guessStateCategory,
  invalidateBoardDetail,
  isImageAttachment,
  isOrgAttachmentUrl,
  loadAttachmentDataUrl,
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

describe("loadAttachmentDataUrl", () => {
  const preview = { mimeType: "image/png", dataBase64: "AAAA" };

  it("builds a data URL and shares one download per URL", async () => {
    vi.mocked(invoke).mockResolvedValue(preview);
    const [a, b] = await Promise.all([
      loadAttachmentDataUrl("https://dev.azure.com/o/p/_apis/wit/attachments/a"),
      loadAttachmentDataUrl("https://dev.azure.com/o/p/_apis/wit/attachments/a"),
    ]);
    expect(a).toBe("data:image/png;base64,AAAA");
    expect(b).toBe(a);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("azure_boards_attachment_preview", {
      url: "https://dev.azure.com/o/p/_apis/wit/attachments/a",
    });
    await loadAttachmentDataUrl("https://x/a");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("passes the file name along when it is known", async () => {
    vi.mocked(invoke).mockResolvedValue(preview);
    await loadAttachmentDataUrl("https://x/_apis/wit/attachments/n", "tela.png");
    expect(invoke).toHaveBeenCalledWith("azure_boards_attachment_preview", {
      url: "https://x/_apis/wit/attachments/n",
      name: "tela.png",
    });
  });

  it("does not keep a failure, so the next ask retries", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Attachment is too large to preview");
    await expect(loadAttachmentDataUrl("https://x/a")).rejects.toBe(
      "Attachment is too large to preview",
    );
    vi.mocked(invoke).mockResolvedValue(preview);
    expect(await loadAttachmentDataUrl("https://x/a")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps at most 40 images, dropping the oldest, and a clear drops them all", async () => {
    vi.mocked(invoke).mockResolvedValue(preview);
    expect(ATTACHMENT_CACHE_MAX).toBe(40);
    for (let index = 0; index < ATTACHMENT_CACHE_MAX; index += 1) {
      await loadAttachmentDataUrl(`https://x/${index}`);
    }
    expect(invoke).toHaveBeenCalledTimes(40);
    // Touching the oldest makes the next one the one to go.
    await loadAttachmentDataUrl("https://x/0");
    await loadAttachmentDataUrl("https://x/40");
    expect(invoke).toHaveBeenCalledTimes(41);
    await loadAttachmentDataUrl("https://x/0");
    expect(invoke).toHaveBeenCalledTimes(41);
    await loadAttachmentDataUrl("https://x/1");
    expect(invoke).toHaveBeenCalledTimes(42);

    clearBoardDetailCache();
    await loadAttachmentDataUrl("https://x/0");
    expect(invoke).toHaveBeenCalledTimes(43);
  });
});

describe("detail helpers", () => {
  it("tells images from other attachments, never treating SVG as an image", () => {
    for (const name of ["a.png", "a.PNG", "x.y.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp"]) {
      expect(isImageAttachment(name), name).toBe(true);
    }
    for (const name of ["menu ajuda.mp4", "logo.svg", "png", "notes.txt", "", "a.png.exe"]) {
      expect(isImageAttachment(name), name).toBe(false);
    }
  });

  it("finds the organization behind a work item URL and what it may inline", () => {
    expect(azureOrgBase("https://dev.azure.com/org/Proj%20X/_workitems/edit/10")).toBe(
      "https://dev.azure.com/org",
    );
    expect(azureOrgBase("https://org.visualstudio.com/Proj/_workitems/edit/10")).toBe(
      "https://org.visualstudio.com",
    );
    expect(azureOrgBase("https://dev.azure.com/org/Proj/_boards")).toBeNull();
    expect(azureOrgBase("")).toBeNull();
    const base = "https://dev.azure.com/org";
    const attachment = `${base}/guid/_apis/wit/attachments/abc?fileName=a.png`;
    expect(isOrgAttachmentUrl(attachment, base)).toBe(true);
    expect(isOrgAttachmentUrl(attachment.replace("/org/", "/ORG/"), base)).toBe(true);
    expect(isOrgAttachmentUrl(attachment.replace("/org/", "/org2/"), base)).toBe(false);
    expect(isOrgAttachmentUrl("https://evil.example.com/_apis/wit/attachments/a", base)).toBe(
      false,
    );
    expect(isOrgAttachmentUrl(`${base}/guid/_apis/wit/workitems/1`, base)).toBe(false);
    expect(isOrgAttachmentUrl(attachment, null)).toBe(false);
  });

  it("formats sizes in binary steps", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(526_336)).toBe("514 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
    expect(formatBytes(33_030_144)).toBe("31.5 MB");
    expect(formatBytes(32_352_348)).toBe("30.9 MB");
    expect(formatBytes(1024 ** 3)).toBe("1 GB");
  });

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
