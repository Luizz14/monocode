import type { AzurePipelinesProject } from "./azurePipelines";

const PROJECT_KEY = "monocode:pipelines:project";
const RECENT_PROJECTS_KEY = "monocode:pipelines:recent-projects";
const MAX_RECENT_PROJECTS = 4;

/**
 * The project to show: the remembered one while it still exists, otherwise
 * the most recently used one that does, otherwise the first project.
 */
export function chooseProject(
  projects: readonly AzurePipelinesProject[],
  remembered: string | null,
  recent: readonly string[] = [],
): string | null {
  const names = new Set(projects.map((project) => project.name));
  for (const name of [remembered, ...recent]) {
    if (name && names.has(name)) return name;
  }
  return projects[0]?.name ?? null;
}

/** Most recent first, without duplicates, capped. */
export function rememberRecentProject(
  recent: readonly string[],
  name: string,
  max = MAX_RECENT_PROJECTS,
): string[] {
  return [name, ...recent.filter((entry) => entry !== name)].slice(0, max);
}

/**
 * Recently used projects first, in the order they were used, so switching
 * back and forth between two projects stays at the top of the picker.
 */
export function orderProjects(
  projects: readonly AzurePipelinesProject[],
  recent: readonly string[],
): AzurePipelinesProject[] {
  const rank = new Map(recent.map((name, index) => [name, index]));
  return [...projects].sort((a, b) => {
    const left = rank.get(a.name) ?? Number.POSITIVE_INFINITY;
    const right = rank.get(b.name) ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left - right;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export function loadPipelinesProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

export function loadRecentPipelineProjects(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/** Remembers the project and returns the updated recent list. */
export function savePipelinesProject(name: string): string[] {
  const recent = rememberRecentProject(loadRecentPipelineProjects(), name);
  try {
    localStorage.setItem(PROJECT_KEY, name);
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
  } catch {
    // Storage is best effort; the view still switches.
  }
  return recent;
}

export function shortBranch(ref: string): string {
  const value = ref.trim();
  return value.startsWith("refs/heads/")
    ? value.slice("refs/heads/".length)
    : value;
}

/** Mirrors the host's branch check so the Run button can disable early. */
export function isValidBranch(branch: string): boolean {
  const value = branch.trim();
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\s\p{Cc}]/u.test(value) &&
    !value.includes("..") &&
    !value.startsWith("/") &&
    !value.endsWith("/")
  );
}

/** Starts the Run dialog on the repository's default branch, like the web. */
export function initialRunBranch(
  defaultBranch: string,
  branches: readonly string[] = [],
): string {
  const fromRepository = shortBranch(defaultBranch);
  if (fromRepository) return fromRepository;
  for (const common of ["main", "master", "develop"]) {
    if (branches.includes(common)) return common;
  }
  return branches[0] ?? "main";
}

const COMMON_BRANCHES = ["main", "master", "develop", "development"];

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/**
 * Branches for the picker: the default branch, then the usual long-lived
 * ones, then the rest by name. A query keeps branches containing every word.
 */
export function orderBranches(
  branches: readonly string[],
  defaultBranch: string,
  query = "",
): string[] {
  const preferred = shortBranch(defaultBranch);
  const rank = (branch: string) => {
    if (branch === preferred) return 0;
    const common = COMMON_BRANCHES.indexOf(branch);
    return common === -1 ? COMMON_BRANCHES.length + 1 : common + 1;
  };
  const words = fold(query).split(/\s+/).filter(Boolean);
  return [...new Set(branches)]
    .filter((branch) => {
      const haystack = fold(branch);
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
