import type { AzurePipeline, AzurePipelineRun } from "./azurePipelines";

export type RunState =
  | "succeeded"
  | "partiallySucceeded"
  | "failed"
  | "canceled"
  | "running"
  | "queued"
  | "none";

const RUN_STATE_LABELS: Record<RunState, string> = {
  succeeded: "Succeeded",
  partiallySucceeded: "Partially succeeded",
  failed: "Failed",
  canceled: "Canceled",
  running: "In progress",
  queued: "Queued",
  none: "Never run",
};

export function runState(run: AzurePipelineRun | null | undefined): RunState {
  if (!run) return "none";
  if (run.status === "completed") {
    switch (run.result) {
      case "succeeded":
        return "succeeded";
      case "partiallySucceeded":
        return "partiallySucceeded";
      case "canceled":
        return "canceled";
      default:
        return "failed";
    }
  }
  if (run.status === "inProgress" || run.status === "cancelling") {
    return "running";
  }
  return "queued";
}

export function runStateLabel(state: RunState): string {
  return RUN_STATE_LABELS[state];
}

/** Still queued or running, so its status and duration will change. */
export function isRunActive(run: AzurePipelineRun | null | undefined) {
  const state = runState(run);
  return state === "running" || state === "queued";
}

const TRIGGER_LABELS: Record<string, string> = {
  individualCI: "Individual CI",
  batchedCI: "Batched CI",
  schedule: "Scheduled",
  manual: "Manually run",
  userCreated: "Manually run",
  pullRequest: "PR automated",
  resourceTrigger: "Automatically triggered",
  buildCompletion: "Automatically triggered",
  triggered: "Automatically triggered",
  validateShelveset: "Gated check-in",
  checkInShelveset: "Gated check-in",
};

/** How the run started, worded like the Azure DevOps web list. */
export function triggerLabel(run: AzurePipelineRun): string {
  return TRIGGER_LABELS[run.reason] ?? (run.reason || "Run");
}

/**
 * The person the run is for. Scheduled and pipeline-triggered runs are queued
 * by service identities (the Azure DevOps service, or a project's
 * "Build Service"), which the web shows only as an avatar.
 */
export function runRequestedFor(run: AzurePipelineRun): string {
  const name = run.requestedFor.trim();
  if (!name || name.startsWith("Microsoft.VisualStudio.")) return "";
  if (/\bBuild Service\b/.test(name)) return "";
  return name;
}

export type BranchLabel = {
  kind: "branch" | "pullRequest" | "tag" | "ref";
  label: string;
};

export function branchLabel(ref: string): BranchLabel {
  const value = ref.trim();
  if (value.startsWith("refs/heads/")) {
    return { kind: "branch", label: value.slice("refs/heads/".length) };
  }
  const pullRequest = /^refs\/pull\/(\d+)\//.exec(value);
  if (pullRequest) return { kind: "pullRequest", label: pullRequest[1] };
  if (value.startsWith("refs/tags/")) {
    return { kind: "tag", label: value.slice("refs/tags/".length) };
  }
  return { kind: "ref", label: value };
}

function time(iso: string): number | null {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : null;
}

/** Elapsed run time; a running run counts up to `now`. */
export function runDurationMs(
  run: AzurePipelineRun,
  now: number = Date.now(),
): number | null {
  const start = time(run.startTime);
  if (start === null) return null;
  const end = time(run.finishTime) ?? (isRunActive(run) ? now : null);
  if (end === null) return null;
  return Math.max(0, end - start);
}

/** `48s`, `1m 1s`, `11m 29s`, `2h 5m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** When the run was queued: a time today, then `Yesterday`, a weekday, a date. */
export function formatRunDate(
  iso: string,
  now: number = Date.now(),
  locale = "en-US",
): string {
  const at = time(iso);
  if (at === null) return "";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  const date = new Date(at);
  if (days <= 0) {
    return date.toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString(locale, { weekday: "long" });
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function pullRequestNumber(run: AzurePipelineRun): number | null {
  const fromTrigger = Number(run.triggerInfo["pr.number"]);
  if (Number.isInteger(fromTrigger) && fromTrigger > 0) return fromTrigger;
  const branch = branchLabel(run.sourceBranch);
  if (branch.kind !== "pullRequest") return null;
  const fromRef = Number(branch.label);
  return Number.isInteger(fromRef) && fromRef > 0 ? fromRef : null;
}

/** Titles looked up from Azure, keyed by `commitKey` and `pullRequestKey`. */
export type RunTitleLookup = ReadonlyMap<string, string>;

export function commitKey(repositoryId: string, commitId: string): string {
  return `commit:${repositoryId.toLowerCase()}:${commitId.toLowerCase()}`;
}

export function pullRequestKey(repositoryId: string, number: number): string {
  return `pr:${repositoryId.toLowerCase()}:${number}`;
}

/**
 * The run's headline after `#number`: the pull request title for PR runs,
 * otherwise the commit message, like the Azure DevOps web list.
 */
export function runMessage(
  run: AzurePipelineRun,
  titles: RunTitleLookup,
): string {
  const pr = pullRequestNumber(run);
  if (pr !== null) {
    const title = titles.get(pullRequestKey(run.repositoryId, pr));
    if (title) return title;
  }
  const ciMessage = run.triggerInfo["ci.message"]?.split("\n")[0]?.trim();
  if (ciMessage) return ciMessage;
  return run.sourceVersion
    ? (titles.get(commitKey(run.repositoryId, run.sourceVersion)) ?? "")
    : "";
}

export function runTitle(run: AzurePipelineRun, titles: RunTitleLookup) {
  const message = runMessage(run, titles);
  const number = run.number ? `#${run.number}` : `#${run.id}`;
  return message ? `${number} • ${message}` : number;
}

/** Commits and pull requests whose titles are not looked up yet. */
export function missingRunTitles(
  runs: readonly AzurePipelineRun[],
  known: { has: (key: string) => boolean },
): {
  commits: { repositoryId: string; commitId: string }[];
  pullRequests: { repositoryId: string; number: number }[];
} {
  const commits = new Map<string, { repositoryId: string; commitId: string }>();
  const pullRequests = new Map<
    string,
    { repositoryId: string; number: number }
  >();
  for (const run of runs) {
    // Only Azure Repos have commit and pull request APIs on this connection.
    if (run.repositoryType !== "TfsGit" || !run.repositoryId) continue;
    const pr = pullRequestNumber(run);
    if (pr !== null) {
      const key = pullRequestKey(run.repositoryId, pr);
      if (!known.has(key)) {
        pullRequests.set(key, { repositoryId: run.repositoryId, number: pr });
      }
      continue;
    }
    if (run.triggerInfo["ci.message"] || !run.sourceVersion) continue;
    const key = commitKey(run.repositoryId, run.sourceVersion);
    if (!known.has(key)) {
      commits.set(key, {
        repositoryId: run.repositoryId,
        commitId: run.sourceVersion,
      });
    }
  }
  return { commits: [...commits.values()], pullRequests: [...pullRequests.values()] };
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Name and folder filter; accents and case are ignored. */
export function filterPipelines(
  pipelines: readonly AzurePipeline[],
  query: string,
): AzurePipeline[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...pipelines];
  return pipelines.filter((pipeline) => {
    const haystack = fold(`${pipeline.name}\n${pipeline.folder}`);
    return words.every((word) => haystack.includes(word));
  });
}

export function filterRuns(
  runs: readonly AzurePipelineRun[],
  query: string,
  titles: RunTitleLookup,
): AzurePipelineRun[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [...runs];
  return runs.filter((run) => {
    const haystack = fold(
      `${run.pipelineName}\n${run.number}\n${runMessage(run, titles)}\n${branchLabel(run.sourceBranch).label}`,
    );
    return words.every((word) => haystack.includes(word));
  });
}

function runSortTime(run: AzurePipelineRun): number {
  return time(run.queueTime) ?? time(run.startTime) ?? 0;
}

/** Pipelines that have run, most recent first. */
export function recentPipelines(
  pipelines: readonly AzurePipeline[],
): AzurePipeline[] {
  return pipelines
    .filter((pipeline) => pipeline.latestRun)
    .sort(
      (a, b) => runSortTime(b.latestRun!) - runSortTime(a.latestRun!),
    );
}

/** Every pipeline, grouped by folder, then by name. */
export function allPipelines(
  pipelines: readonly AzurePipeline[],
): AzurePipeline[] {
  return [...pipelines].sort(
    (a, b) =>
      folderLabel(a.folder).localeCompare(folderLabel(b.folder)) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** `\Mobile\Release` reads as `Mobile/Release`; the root folder is empty. */
export function folderLabel(folder: string): string {
  return folder
    .split("\\")
    .filter(Boolean)
    .join("/");
}

export function organizationName(orgUrl: string): string {
  const trimmed = orgUrl.trim().replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function projectWebBase(orgUrl: string, project: string): string {
  return `${orgUrl.trim().replace(/\/+$/, "")}/${encodeURIComponent(project)}`;
}

export function pipelinesWebUrl(
  orgUrl: string,
  project: string,
  view: "recent" | "all" | "runs" = "recent",
): string {
  const base = `${projectWebBase(orgUrl, project)}/_build`;
  return view === "recent" ? base : `${base}?view=${view}`;
}

export function newPipelineWebUrl(orgUrl: string, project: string): string {
  return `${projectWebBase(orgUrl, project)}/_apps/hub/ms.vss-build-web.ci-designer-hub`;
}

export function pipelineWebUrl(
  orgUrl: string,
  project: string,
  pipeline: { id: number; url: string },
): string {
  return (
    pipeline.url ||
    `${projectWebBase(orgUrl, project)}/_build?definitionId=${pipeline.id}`
  );
}

export function runWebUrl(
  orgUrl: string,
  project: string,
  run: { id: number; url: string },
): string {
  return (
    run.url ||
    `${projectWebBase(orgUrl, project)}/_build/results?buildId=${run.id}`
  );
}
