import { describe, expect, it } from "vitest";
import type { AzurePipeline, AzurePipelineRun } from "./azurePipelines";
import {
  allPipelines,
  branchLabel,
  commitKey,
  filterPipelines,
  filterRuns,
  folderLabel,
  formatDuration,
  formatRunDate,
  isRunActive,
  missingRunTitles,
  newPipelineWebUrl,
  organizationName,
  pipelineWebUrl,
  pipelinesWebUrl,
  pullRequestKey,
  recentPipelines,
  runDurationMs,
  runRequestedFor,
  runState,
  runTitle,
  runWebUrl,
  triggerLabel,
} from "./pipelineFormat";

const SHA = "c58ec7a1c58ec7a1c58ec7a1c58ec7a1c58ec7a1";

function run(overrides: Partial<AzurePipelineRun> = {}): AzurePipelineRun {
  return {
    id: 7,
    number: "20261016.1",
    pipelineId: 60,
    pipelineName: "OnboardingApp Fastlane Homologacao",
    status: "completed",
    result: "succeeded",
    reason: "individualCI",
    sourceBranch: "refs/heads/main",
    sourceVersion: SHA,
    repositoryId: "repo-1",
    repositoryType: "TfsGit",
    requestedFor: "Luiz Santos",
    queueTime: "2026-10-16T20:30:00Z",
    startTime: "2026-10-16T20:30:05Z",
    finishTime: "2026-10-16T20:30:53Z",
    url: "https://dev.azure.com/org/p/_build/results?buildId=7",
    triggerInfo: {},
    ...overrides,
  };
}

function pipeline(
  id: number,
  name: string,
  latestRun: AzurePipelineRun | null,
  folder = "\\",
): AzurePipeline {
  return { id, name, folder, url: "", queueStatus: "enabled", latestRun };
}

describe("run state", () => {
  it("maps Azure status and result to the list's status icon", () => {
    expect(runState(null)).toBe("none");
    expect(runState(run())).toBe("succeeded");
    expect(runState(run({ result: "partiallySucceeded" }))).toBe(
      "partiallySucceeded",
    );
    expect(runState(run({ result: "failed" }))).toBe("failed");
    expect(runState(run({ result: "canceled" }))).toBe("canceled");
    expect(runState(run({ status: "inProgress", result: "" }))).toBe(
      "running",
    );
    expect(runState(run({ status: "cancelling", result: "" }))).toBe(
      "running",
    );
    expect(runState(run({ status: "notStarted", result: "" }))).toBe("queued");
    expect(isRunActive(run({ status: "postponed", result: "" }))).toBe(true);
    expect(isRunActive(run())).toBe(false);
  });
});

describe("trigger and branch labels", () => {
  it("words the trigger like the web list", () => {
    expect(triggerLabel(run())).toBe("Individual CI");
    expect(triggerLabel(run({ reason: "schedule" }))).toBe("Scheduled");
    expect(triggerLabel(run({ reason: "pullRequest" }))).toBe("PR automated");
    expect(triggerLabel(run({ reason: "resourceTrigger" }))).toBe(
      "Automatically triggered",
    );
    expect(triggerLabel(run({ reason: "manual" }))).toBe("Manually run");
    expect(triggerLabel(run({ reason: "somethingNew" }))).toBe("somethingNew");
  });

  it("hides the Azure DevOps service identity", () => {
    expect(runRequestedFor(run())).toBe("Luiz Santos");
    expect(
      runRequestedFor(
        run({ requestedFor: "Microsoft.VisualStudio.Services.TFS" }),
      ),
    ).toBe("");
    expect(
      runRequestedFor(
        run({ requestedFor: "Mobile Desty Build Service (BaneseAgile)" }),
      ),
    ).toBe("");
    expect(
      runRequestedFor(run({ requestedFor: "Project Collection Build Service" })),
    ).toBe("");
  });

  it("shortens branch, pull request and tag refs", () => {
    expect(branchLabel("refs/heads/feature/US1/x")).toEqual({
      kind: "branch",
      label: "feature/US1/x",
    });
    expect(branchLabel("refs/pull/40574/merge")).toEqual({
      kind: "pullRequest",
      label: "40574",
    });
    expect(branchLabel("refs/tags/v1.2")).toEqual({
      kind: "tag",
      label: "v1.2",
    });
    expect(branchLabel("abc")).toEqual({ kind: "ref", label: "abc" });
  });
});

describe("durations and dates", () => {
  it("formats durations like the web", () => {
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(689_000)).toBe("11m 29s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("counts a running run up to now and skips unstarted runs", () => {
    expect(runDurationMs(run())).toBe(48_000);
    const now = Date.parse("2026-10-16T20:31:05Z");
    expect(
      runDurationMs(run({ status: "inProgress", finishTime: "" }), now),
    ).toBe(60_000);
    expect(runDurationMs(run({ startTime: "" }))).toBeNull();
  });

  it("dates runs as a time, Yesterday, a weekday or a date", () => {
    const now = new Date(2026, 9, 17, 9, 0).getTime();
    const at = (days: number, hour = 14) =>
      new Date(2026, 9, 17 - days, hour, 5).toISOString();
    expect(formatRunDate(at(0, 8), now)).toBe("8:05 AM");
    expect(formatRunDate(at(1), now)).toBe("Yesterday");
    expect(formatRunDate(at(3), now)).toBe("Wednesday");
    expect(formatRunDate(at(30), now)).toBe("Sep 17");
    expect(formatRunDate(new Date(2025, 0, 2).toISOString(), now)).toBe(
      "Jan 2, 2025",
    );
    expect(formatRunDate("", now)).toBe("");
  });
});

describe("run titles", () => {
  it("prefers the PR title, then the CI message, then the commit message", () => {
    const titles = new Map([
      [commitKey("repo-1", SHA.toUpperCase()), "Atualização das dependências"],
      [pullRequestKey("repo-1", 40574), "feat: [US-383311] Cartão adicional"],
    ]);
    expect(runTitle(run(), titles)).toBe(
      "#20261016.1 • Atualização das dependências",
    );
    expect(
      runTitle(
        run({
          reason: "pullRequest",
          sourceBranch: "refs/pull/40574/merge",
          triggerInfo: { "pr.number": "40574" },
        }),
        titles,
      ),
    ).toBe("#20261016.1 • feat: [US-383311] Cartão adicional");
    expect(
      runTitle(run({ triggerInfo: { "ci.message": "fix: x\n\nbody" } }), titles),
    ).toBe("#20261016.1 • fix: x");
    expect(runTitle(run({ sourceVersion: "" }), new Map())).toBe(
      "#20261016.1",
    );
  });

  it("asks only for titles it does not know yet", () => {
    const known = new Set([commitKey("repo-1", SHA)]);
    const wanted = missingRunTitles(
      [
        run(),
        run({ id: 8, sourceVersion: "d".repeat(40) }),
        run({ id: 9, sourceVersion: "d".repeat(40) }),
        run({
          id: 10,
          reason: "pullRequest",
          triggerInfo: { "pr.number": "12" },
        }),
        run({ id: 11, repositoryType: "GitHub", sourceVersion: "e".repeat(40) }),
        run({ id: 12, triggerInfo: { "ci.message": "inline" } }),
      ],
      known,
    );
    expect(wanted).toEqual({
      commits: [{ repositoryId: "repo-1", commitId: "d".repeat(40) }],
      pullRequests: [{ repositoryId: "repo-1", number: 12 }],
    });
  });
});

describe("pipeline lists", () => {
  const banese = pipeline(
    1,
    "Cria Tags CartaoElo",
    run({ queueTime: "2026-10-16T10:00:00Z" }),
  );
  const desty = pipeline(
    2,
    "atualizar-dependências-CartaoElo",
    run({ queueTime: "2026-10-16T12:00:00Z" }),
    "\\Mobile\\Release",
  );
  const never = pipeline(3, "Never run", null);

  it("lists recently run pipelines newest first and skips the never-run ones", () => {
    expect(recentPipelines([banese, never, desty]).map((p) => p.id)).toEqual([
      2, 1,
    ]);
  });

  it("sorts All by folder, then name", () => {
    expect(allPipelines([desty, never, banese]).map((p) => p.id)).toEqual([
      1, 3, 2,
    ]);
    expect(folderLabel("\\Mobile\\Release")).toBe("Mobile/Release");
    expect(folderLabel("\\")).toBe("");
  });

  it("filters by name and folder ignoring case and accents", () => {
    expect(
      filterPipelines([banese, desty, never], "DEPENDENCIAS").map((p) => p.id),
    ).toEqual([2]);
    expect(
      filterPipelines([banese, desty, never], "release elo").map((p) => p.id),
    ).toEqual([2]);
    expect(filterPipelines([banese, desty], "  ")).toHaveLength(2);
  });

  it("filters runs by pipeline, number, branch and title", () => {
    const runs = [
      run(),
      run({ id: 8, pipelineName: "Other", sourceBranch: "refs/heads/develop" }),
    ];
    expect(filterRuns(runs, "develop", new Map()).map((r) => r.id)).toEqual([
      8,
    ]);
    expect(filterRuns(runs, "fastlane", new Map()).map((r) => r.id)).toEqual([
      7,
    ]);
  });
});

describe("web links", () => {
  const org = "https://dev.azure.com/BaneseAgile/";

  it("names the organization from its URL", () => {
    expect(organizationName(org)).toBe("BaneseAgile");
  });

  it("builds pipeline and run links, preferring the API's own", () => {
    expect(pipelinesWebUrl(org, "Mobile Banese")).toBe(
      "https://dev.azure.com/BaneseAgile/Mobile%20Banese/_build",
    );
    expect(pipelinesWebUrl(org, "Mobile Desty", "runs")).toBe(
      "https://dev.azure.com/BaneseAgile/Mobile%20Desty/_build?view=runs",
    );
    expect(newPipelineWebUrl(org, "Mobile Desty")).toBe(
      "https://dev.azure.com/BaneseAgile/Mobile%20Desty/_apps/hub/ms.vss-build-web.ci-designer-hub",
    );
    expect(pipelineWebUrl(org, "Mobile Desty", { id: 60, url: "" })).toBe(
      "https://dev.azure.com/BaneseAgile/Mobile%20Desty/_build?definitionId=60",
    );
    expect(runWebUrl(org, "Mobile Desty", { id: 9, url: "" })).toBe(
      "https://dev.azure.com/BaneseAgile/Mobile%20Desty/_build/results?buildId=9",
    );
    expect(runWebUrl(org, "p", { id: 9, url: "https://x/y" })).toBe(
      "https://x/y",
    );
  });
});
