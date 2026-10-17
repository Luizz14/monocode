import { invoke } from "@tauri-apps/api/core";
import {
  commitKey,
  missingRunTitles,
  pullRequestKey,
  type RunTitleLookup,
} from "./pipelineFormat";

/** Azure Pipelines over the Azure DevOps connection set up in Settings > Inbox. */

export type AzurePipelinesProject = { id: string; name: string };

export type AzurePipelineRun = {
  id: number;
  number: string;
  pipelineId: number;
  pipelineName: string;
  /** `notStarted`, `inProgress`, `cancelling`, `postponed` or `completed`. */
  status: string;
  /** Empty until the run completes. */
  result: string;
  reason: string;
  sourceBranch: string;
  sourceVersion: string;
  repositoryId: string;
  repositoryType: string;
  requestedFor: string;
  queueTime: string;
  startTime: string;
  finishTime: string;
  url: string;
  triggerInfo: Record<string, string>;
};

export type AzurePipeline = {
  id: number;
  name: string;
  folder: string;
  url: string;
  queueStatus: string;
  latestRun: AzurePipelineRun | null;
};

export type AzurePipelineDefinition = {
  id: number;
  name: string;
  folder: string;
  url: string;
  queueStatus: string;
  /** Empty for classic pipelines. */
  yamlFilename: string;
  repository: {
    id: string;
    name: string;
    kind: string;
    defaultBranch: string;
  };
  /** Variables marked "Settable at queue time". */
  variables: { name: string; value: string; isSecret: boolean }[];
};

export type QueuePipelineRun = {
  pipelineId: number;
  branch: string;
  templateParameters: Record<string, string>;
  variables: Record<string, string>;
};

const pipelinesByProject = new Map<string, AzurePipeline[]>();
const titlesByProject = new Map<string, Map<string, string>>();
/** Lookups that came back empty, so a refresh does not ask for them again. */
const missingByProject = new Map<string, Set<string>>();

export function clearAzurePipelinesCache() {
  pipelinesByProject.clear();
  titlesByProject.clear();
  missingByProject.clear();
}

export function listAzurePipelinesProjects(): Promise<AzurePipelinesProject[]> {
  return invoke<AzurePipelinesProject[]>("azure_devops_projects");
}

export function peekAzurePipelines(project: string): AzurePipeline[] | null {
  return pipelinesByProject.get(project) ?? null;
}

export async function listAzurePipelines(
  project: string,
): Promise<AzurePipeline[]> {
  const pipelines = await invoke<AzurePipeline[]>("azure_pipelines_list", {
    project,
  });
  pipelinesByProject.set(project, pipelines);
  return pipelines;
}

export function listAzurePipelineRuns(
  project: string,
  options: { pipelineId?: number; limit?: number } = {},
): Promise<AzurePipelineRun[]> {
  return invoke<AzurePipelineRun[]>("azure_pipelines_runs", {
    project,
    pipelineId: options.pipelineId,
    limit: options.limit,
  });
}

export function getAzurePipelineRun(
  project: string,
  runId: number,
): Promise<AzurePipelineRun> {
  return invoke<AzurePipelineRun>("azure_pipelines_run", { project, runId });
}

export function getAzurePipelineDefinition(
  project: string,
  pipelineId: number,
): Promise<AzurePipelineDefinition> {
  return invoke<AzurePipelineDefinition>("azure_pipelines_definition", {
    project,
    pipelineId,
  });
}

export function listAzurePipelineBranches(
  project: string,
  repositoryId: string,
): Promise<string[]> {
  return invoke<string[]>("azure_pipelines_branches", {
    project,
    repositoryId,
  });
}

export function readAzurePipelineFile(
  project: string,
  repositoryId: string,
  path: string,
  branch: string,
): Promise<string> {
  return invoke<string>("azure_pipelines_file", {
    project,
    repositoryId,
    path,
    branch,
  });
}

/** Queues a real run in Azure DevOps. Only call it from an explicit user action. */
export function queueAzurePipelineRun(
  project: string,
  request: QueuePipelineRun,
): Promise<AzurePipelineRun> {
  return invoke<AzurePipelineRun>("azure_pipelines_queue", {
    project,
    pipelineId: request.pipelineId,
    branch: request.branch,
    templateParameters: request.templateParameters,
    variables: request.variables,
  });
}

// ---- Run titles ----

type RunTitlesResponse = {
  commits: { repositoryId: string; commitId: string; message: string }[];
  pullRequests: { repositoryId: string; number: number; title: string }[];
};

const NO_TITLES: RunTitleLookup = new Map();

/** Commit messages and PR titles already fetched for the project. */
export function peekRunTitles(project: string): RunTitleLookup {
  return titlesByProject.get(project) ?? NO_TITLES;
}

/**
 * Fetches the run titles not looked up yet. Resolves to a new lookup when
 * any arrived, or to the current one when there was nothing new.
 */
export async function loadRunTitles(
  project: string,
  runs: readonly AzurePipelineRun[],
): Promise<RunTitleLookup> {
  const titles = titlesByProject.get(project) ?? new Map<string, string>();
  const missing = missingByProject.get(project) ?? new Set<string>();
  const wanted = missingRunTitles(runs, {
    has: (key) => titles.has(key) || missing.has(key),
  });
  if (!wanted.commits.length && !wanted.pullRequests.length) {
    return peekRunTitles(project);
  }
  const response = await invoke<RunTitlesResponse>(
    "azure_pipelines_run_titles",
    { project, ...wanted },
  );
  const next = new Map(titles);
  for (const commit of response.commits) {
    next.set(commitKey(commit.repositoryId, commit.commitId), commit.message);
  }
  for (const pr of response.pullRequests) {
    next.set(pullRequestKey(pr.repositoryId, pr.number), pr.title);
  }
  for (const commit of wanted.commits) {
    const key = commitKey(commit.repositoryId, commit.commitId);
    if (!next.has(key)) missing.add(key);
  }
  for (const pr of wanted.pullRequests) {
    const key = pullRequestKey(pr.repositoryId, pr.number);
    if (!next.has(key)) missing.add(key);
  }
  titlesByProject.set(project, next);
  missingByProject.set(project, missing);
  return next;
}
