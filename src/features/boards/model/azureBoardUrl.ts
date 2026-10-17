import type {
  AzureAreaFilter,
  AzureBoardFilters,
  AzureIterationFilter,
} from "./boardTypes";

/** What an Azure DevOps backlog, board or sprint link says about a board. */
export type AzureBoardUrlImport = {
  /** Organization name as written in the link, such as `BaneseAgile`. */
  organization: string;
  /** `https://dev.azure.com/{org}` or `https://{org}.visualstudio.com`. */
  orgUrl: string;
  project: string;
  team: string | null;
  /** Backlog level name from the route, such as `Stories`. */
  backlogLevelName: string | null;
  text: string | null;
  /** `System.AreaPath` values; may be full paths or just the leaf. */
  areaPathHints: string[];
  iteration: AzureIterationFilter | null;
  assignedToMe: boolean;
};

export const AZURE_URL_INVALID_MESSAGE =
  "That isn't an Azure DevOps backlog or board link.";

function nfc(value: string): string {
  return value.normalize("NFC");
}

function decodeSegment(segment: string): string {
  try {
    return nfc(decodeURIComponent(segment));
  } catch {
    return nfc(segment);
  }
}

function parseUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** Org name and the path segments after it, or `null` for other hosts. */
function orgAndSegments(
  url: URL,
): { organization: string; orgUrl: string; segments: string[] } | null {
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (host === "dev.azure.com") {
    const organization = segments.shift();
    if (!organization) return null;
    return {
      organization,
      orgUrl: `https://dev.azure.com/${encodeURIComponent(organization)}`,
      segments,
    };
  }
  if (host.endsWith(".visualstudio.com")) {
    const organization = url.hostname.slice(0, -".visualstudio.com".length);
    if (!organization || organization.includes(".")) return null;
    if (segments[0]?.toLowerCase() === "defaultcollection") segments.shift();
    return {
      organization,
      orgUrl: `https://${organization.toLowerCase()}.visualstudio.com`,
      segments,
    };
  }
  return null;
}

function routeParts(segments: readonly string[]): {
  team: string | null;
  level: string | null;
} {
  const at = (index: number) => segments[index]?.trim() || null;
  const backlogs = segments.indexOf("_backlogs");
  if (backlogs !== -1 && segments[backlogs + 1] === "backlog") {
    return { team: at(backlogs + 2), level: at(backlogs + 3) };
  }
  const boards = segments.indexOf("_boards");
  if (boards !== -1 && segments[boards + 1] === "board") {
    const offset = segments[boards + 2] === "t" ? 3 : 2;
    return { team: at(boards + offset), level: at(boards + offset + 1) };
  }
  const sprints = segments.indexOf("_sprints");
  if (sprints !== -1) return { team: at(sprints + 2), level: null };
  return { team: null, level: null };
}

/**
 * Reads an Azure DevOps backlog (`_backlogs/backlog/{team}/{level}`), board
 * (`_boards/board/[t/]{team}/{level}`), sprint (`_sprints/{view}/{team}/…`) or
 * project link, on dev.azure.com or `*.visualstudio.com`, with or without a
 * scheme. `null` when it is none of those.
 */
export function parseAzureBoardUrl(raw: string): AzureBoardUrlImport | null {
  const url = parseUrl(raw);
  if (!url) return null;
  const org = orgAndSegments(url);
  if (!org) return null;
  const project = org.segments[0]?.trim();
  if (!project || project.startsWith("_")) return null;
  const { team, level } = routeParts(org.segments.slice(1));

  let text: string | null = null;
  const areaPathHints: string[] = [];
  let iteration: AzureIterationFilter | null = null;
  let assignedToMe = false;
  for (const [rawKey, rawValue] of url.searchParams) {
    const key = rawKey.toLowerCase();
    const value = nfc(rawValue).trim();
    if (key === "text") {
      if (value) text = value;
    } else if (key === "system.areapath") {
      if (value && !areaPathHints.includes(value)) areaPathHints.push(value);
    } else if (key === "system.iterationpath") {
      if (value.toLowerCase().startsWith("@currentiteration")) {
        iteration = { kind: "current" };
      } else if (value) {
        iteration = { kind: "path", path: value };
      }
    } else if (key === "system.assignedto") {
      if (value.toLowerCase() === "@me") assignedToMe = true;
    }
  }

  return {
    organization: org.organization,
    orgUrl: org.orgUrl,
    project,
    team,
    backlogLevelName: level,
    text,
    areaPathHints,
    iteration,
    assignedToMe,
  };
}

/**
 * Lower-case organization name from an org URL (`https://dev.azure.com/x`,
 * `https://x.visualstudio.com`) or a bare name.
 */
export function azureOrgName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!trimmed.includes("/") && !trimmed.includes(".")) {
    return trimmed.toLowerCase();
  }
  const url = parseUrl(trimmed);
  if (!url) return trimmed.toLowerCase();
  const org = orgAndSegments(url);
  return org ? org.organization.toLowerCase() : trimmed.toLowerCase();
}

/** Whether two org URLs or names point at the same organization. */
export function sameAzureOrg(a: string, b: string): boolean {
  const left = azureOrgName(a);
  return left !== "" && left === azureOrgName(b);
}

// ---------------------------------------------------------------------------
// Area hints
// ---------------------------------------------------------------------------

export type AzureAreaResolution = {
  /** Matched areas, `includeChildren: false`. */
  areas: AzureAreaFilter[];
  /** Hints that matched several areas; all of them were selected. */
  ambiguous: string[];
  /** Hints that matched nothing. */
  unresolved: string[];
};

/** NFC and case-insensitive; accents still count. */
function areaKey(value: string): string {
  return nfc(value).trim().toLowerCase();
}

function segmentsOf(path: string): string[] {
  return path.split("\\").filter(Boolean);
}

function under(path: string, root: string): boolean {
  const a = areaKey(path);
  const b = areaKey(root);
  return a === b || a.startsWith(`${b}\\`);
}

/**
 * Maps link area hints onto the project's area paths: full path first, then
 * the path without the project, then the leaf. A leaf found in several places
 * is narrowed to those under `preferUnder` (the team's areas); if that still
 * leaves several, all are selected and the hint is reported as ambiguous.
 */
export function resolveAzureAreaHints(
  hints: readonly string[],
  areas: readonly string[],
  preferUnder: readonly string[] = [],
): AzureAreaResolution {
  const picked: string[] = [];
  const ambiguous: string[] = [];
  const unresolved: string[] = [];
  const add = (path: string) => {
    if (!picked.includes(path)) picked.push(path);
  };
  for (const hint of hints) {
    const key = areaKey(hint);
    if (!key) continue;
    const full = areas.find((area) => areaKey(area) === key);
    if (full) {
      add(full);
      continue;
    }
    const withoutProject = areas.find(
      (area) => areaKey(segmentsOf(area).slice(1).join("\\")) === key,
    );
    if (withoutProject) {
      add(withoutProject);
      continue;
    }
    const hintLeaf = areaKey(segmentsOf(hint).pop() ?? hint);
    const leaves = areas.filter(
      (area) => areaKey(segmentsOf(area).pop() ?? "") === hintLeaf,
    );
    if (leaves.length === 0) {
      unresolved.push(hint);
      continue;
    }
    if (leaves.length === 1) {
      add(leaves[0]!);
      continue;
    }
    const preferred = leaves.filter((area) =>
      preferUnder.some((root) => under(area, root)),
    );
    if (preferred.length === 1) {
      add(preferred[0]!);
      continue;
    }
    ambiguous.push(hint);
    for (const area of preferred.length > 0 ? preferred : leaves) add(area);
  }
  return {
    areas: picked.map((path) => ({ path, includeChildren: false })),
    ambiguous,
    unresolved,
  };
}

/**
 * Filters with the link applied. The link decides project, text, areas and
 * "assigned to me"; team, level and iteration are kept when it leaves them
 * out, unless the project or team changed underneath them. Without
 * `resolved`, area hints are not applied and the team's areas are used.
 */
export function applyAzureUrlImport(
  filters: AzureBoardFilters,
  parsed: AzureBoardUrlImport,
  resolved?: AzureAreaResolution,
): AzureBoardFilters {
  const projectChanged = areaKey(parsed.project) !== areaKey(filters.project);
  const team = parsed.team ?? (projectChanged ? "" : filters.team);
  const teamChanged = projectChanged || areaKey(team) !== areaKey(filters.team);
  return {
    ...filters,
    project: parsed.project,
    team,
    backlogLevel: parsed.backlogLevelName
      ? { id: "", name: parsed.backlogLevelName }
      : teamChanged
        ? { id: "", name: "" }
        : filters.backlogLevel,
    areaPaths: resolved ? resolved.areas : [],
    iteration:
      parsed.iteration ??
      (teamChanged ? { kind: "current" } : filters.iteration),
    text: parsed.text ?? "",
    assignedToMe: parsed.assignedToMe,
  };
}
