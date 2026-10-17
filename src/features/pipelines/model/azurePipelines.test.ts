import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAzurePipelinesCache,
  listAzurePipelines,
  loadRunTitles,
  peekAzurePipelines,
  peekRunTitles,
  queueAzurePipelineRun,
  type AzurePipelineRun,
} from "./azurePipelines";
import { runTitle } from "./pipelineFormat";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = vi.mocked(invoke);

function run(id: number, sha: string): AzurePipelineRun {
  return {
    id,
    number: `2026101${id}.1`,
    pipelineId: 1,
    pipelineName: "Cria Tags CartaoElo",
    status: "completed",
    result: "succeeded",
    reason: "individualCI",
    sourceBranch: "refs/heads/main",
    sourceVersion: sha,
    repositoryId: "repo",
    repositoryType: "TfsGit",
    requestedFor: "",
    queueTime: "",
    startTime: "",
    finishTime: "",
    url: "",
    triggerInfo: {},
  };
}

beforeEach(() => {
  clearAzurePipelinesCache();
  mockedInvoke.mockReset();
});

describe("pipeline lists", () => {
  it("keeps the last list per project for an instant switch back", async () => {
    mockedInvoke.mockResolvedValueOnce([{ id: 1, name: "A" }]);
    expect(peekAzurePipelines("Mobile Banese")).toBeNull();
    await listAzurePipelines("Mobile Banese");
    expect(mockedInvoke).toHaveBeenCalledWith("azure_pipelines_list", {
      project: "Mobile Banese",
    });
    expect(peekAzurePipelines("Mobile Banese")).toEqual([{ id: 1, name: "A" }]);
    expect(peekAzurePipelines("Mobile Desty")).toBeNull();
  });
});

describe("run titles", () => {
  const first = run(1, "a".repeat(40));
  const second = run(2, "b".repeat(40));

  it("fetches each commit once per project and remembers misses", async () => {
    mockedInvoke.mockResolvedValueOnce({
      commits: [
        { repositoryId: "repo", commitId: "a".repeat(40), message: "Atualiza" },
      ],
      pullRequests: [],
    });
    const titles = await loadRunTitles("Mobile Desty", [first, second]);
    expect(mockedInvoke).toHaveBeenCalledWith("azure_pipelines_run_titles", {
      project: "Mobile Desty",
      commits: [
        { repositoryId: "repo", commitId: "a".repeat(40) },
        { repositoryId: "repo", commitId: "b".repeat(40) },
      ],
      pullRequests: [],
    });
    expect(runTitle(first, titles)).toBe("#20261011.1 • Atualiza");
    expect(runTitle(second, titles)).toBe("#20261012.1");
    expect(peekRunTitles("Mobile Desty")).toBe(titles);

    // Both commits are now known or known-missing: no second request.
    expect(await loadRunTitles("Mobile Desty", [first, second])).toBe(titles);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(peekRunTitles("Mobile Banese").size).toBe(0);
  });
});

describe("queueing a run", () => {
  it("passes the branch, parameters and variables through unchanged", async () => {
    mockedInvoke.mockResolvedValueOnce(run(9, "c".repeat(40)));
    const queued = await queueAzurePipelineRun("Mobile Banese", {
      pipelineId: 60,
      branch: "feature/x",
      templateParameters: { environment: "prod" },
      variables: {},
    });
    expect(mockedInvoke).toHaveBeenCalledWith("azure_pipelines_queue", {
      project: "Mobile Banese",
      pipelineId: 60,
      branch: "feature/x",
      templateParameters: { environment: "prod" },
      variables: {},
    });
    expect(queued.id).toBe(9);
  });
});
