import { invoke } from "@tauri-apps/api/core";
import { listLinearTeams, type LinearTeam } from "../../inbox/model/linear";
import {
  OTHER_COLUMN_ID,
  linearStateCategory,
  normalizeHexColor,
  ownValue,
  type BoardCard,
  type BoardColumn,
  type BoardMoveRejection,
  type LinearBoardState,
  type LinearBoardTeam,
  type LinearColumnState,
  type LinearColumnTarget,
} from "./boardTypes";

export { listLinearTeams, type LinearTeam };

// ---------------------------------------------------------------------------
// Wire types (mirror src-tauri/src/linear_boards.rs, camelCase)
// ---------------------------------------------------------------------------

export type LinearBoardStateRow = {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
  teamId: string;
  teamKey: string;
  teamName: string;
};

export type LinearBoardIssue = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  stateId: string;
  stateName: string;
  stateType: string;
  stateColor: string;
  teamId: string;
  teamKey: string;
  teamName: string;
  projectName: string;
  priority: number;
  priorityLabel: string;
  estimate: number | null;
  sortOrder: number;
  cycle: {
    id: string;
    number: number;
    name: string;
    startsAt: string;
    endsAt: string;
  } | null;
  /** Colors come without `#`. */
  labels: { name: string; color: string }[];
  assignee: { login: string; avatarUrl: string } | null;
  updatedAt: string;
};

export type LinearBoardIssuesQuery = {
  teamIds: string[];
  assignedToMe: boolean;
  activeCycleOnly: boolean;
  includeDone: boolean;
  limit: number;
};

export type LinearBoardIssuesResult = {
  items: LinearBoardIssue[];
  truncated: boolean;
};

export const LINEAR_BOARD_LIMIT = 250;

/** Column order of Linear state types. `duplicate` never gets a column. */
export const LINEAR_STATE_TYPE_ORDER = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

const LINEAR_TYPE_TITLES: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
};

function typeRank(type: string): number {
  const index = (LINEAR_STATE_TYPE_ORDER as readonly string[]).indexOf(type);
  return index === -1 ? LINEAR_STATE_TYPE_ORDER.length : index;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60_000;

let cacheGeneration = 0;
const statesCache = new Map<string, { value: LinearBoardTeam[]; at: number }>();
const statesInflight = new Map<string, Promise<LinearBoardTeam[]>>();

export function clearLinearBoardsCache() {
  cacheGeneration += 1;
  statesCache.clear();
  statesInflight.clear();
}

/** Groups the flat, team-ordered state list into teams (Rust keeps the order). */
export function groupLinearStates(
  rows: readonly LinearBoardStateRow[],
): LinearBoardTeam[] {
  const teams = new Map<string, LinearBoardTeam>();
  for (const row of rows) {
    let team = teams.get(row.teamId);
    if (!team) {
      team = {
        id: row.teamId,
        key: row.teamKey,
        name: row.teamName,
        states: [],
      };
      teams.set(row.teamId, team);
    }
    team.states.push({
      id: row.id,
      name: row.name,
      type: row.type,
      color: row.color,
      position: row.position,
    });
  }
  return [...teams.values()];
}

export function linearBoardStates(
  teamIds: readonly string[],
  options?: { force?: boolean },
): Promise<LinearBoardTeam[]> {
  const ids = [...new Set(teamIds)].sort();
  const key = ids.join(",");
  const hit = statesCache.get(key);
  if (!options?.force && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return Promise.resolve(hit.value);
  }
  const running = statesInflight.get(key);
  if (running && !options?.force) return running;
  const generation = cacheGeneration;
  const pending = invoke<LinearBoardStateRow[]>("linear_boards_states", {
    teamIds: ids,
  })
    .then((rows) => {
      const teams = groupLinearStates(rows);
      if (
        generation === cacheGeneration &&
        statesInflight.get(key) === pending
      ) {
        statesCache.set(key, { value: teams, at: Date.now() });
      }
      return teams;
    })
    .finally(() => {
      if (statesInflight.get(key) === pending) statesInflight.delete(key);
    });
  statesInflight.set(key, pending);
  return pending;
}

export function listLinearBoardIssues(
  query: LinearBoardIssuesQuery,
): Promise<LinearBoardIssuesResult> {
  return invoke<LinearBoardIssuesResult>("linear_boards_issues", { query });
}

export function moveLinearCard(
  id: string,
  stateId: string,
): Promise<LinearBoardIssue> {
  return invoke<LinearBoardIssue>("linear_boards_move", { id, stateId });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function columnState(state: LinearBoardState): LinearColumnState {
  return {
    id: state.id,
    name: state.name,
    type: state.type,
    color: state.color,
  };
}

function byTypeThenPosition(a: LinearBoardState, b: LinearBoardState) {
  return typeRank(a.type) - typeRank(b.type) || a.position - b.position;
}

/**
 * One team: its workflow states (`ln:{stateId}`). Several teams: one column
 * per state type (`lt:{type}`), targeting each team's lowest-position state of
 * that type. Duplicate states are left out.
 */
export function buildLinearColumns(
  teams: readonly LinearBoardTeam[],
  teamIds: readonly string[],
): BoardColumn[] {
  const wanted = new Set(teamIds);
  const picked = teams.filter((team) => wanted.has(team.id));
  if (picked.length === 0) return [];
  if (picked.length === 1) {
    const team = picked[0]!;
    return team.states
      .filter((state) => state.type !== "duplicate")
      .slice()
      .sort(byTypeThenPosition)
      .map((state) => ({
        id: `ln:${state.id}`,
        title: state.name,
        color: normalizeHexColor(state.color),
        category: linearStateCategory(state.type),
        target: {
          provider: "linear",
          statesByTeam: { [team.id]: columnState(state) },
        },
      }));
  }
  const byType = new Map<string, Record<string, LinearColumnState>>();
  for (const team of picked) {
    const states = team.states
      .filter((state) => state.type !== "duplicate")
      .slice()
      .sort(byTypeThenPosition);
    for (const state of states) {
      let entry = byType.get(state.type);
      if (!entry) {
        entry = {};
        byType.set(state.type, entry);
      }
      if (!ownValue(entry, team.id)) entry[team.id] = columnState(state);
    }
  }
  return [...byType.entries()]
    .sort(([a], [b]) => typeRank(a) - typeRank(b))
    .map(([type, statesByTeam]) => {
      const first = Object.values(statesByTeam)[0];
      return {
        id: `lt:${type}`,
        title: LINEAR_TYPE_TITLES[type] ?? type,
        color: normalizeHexColor(first?.color),
        category: linearStateCategory(type),
        target: { provider: "linear", statesByTeam },
      } satisfies BoardColumn;
    });
}

function linearTarget(column: BoardColumn): LinearColumnTarget | null {
  return column.target.provider === "linear" ? column.target : null;
}

/** The column holding the issue's exact state, else its type column, else Other. */
export function linearCardColumnId(
  issue: { stateId: string; stateType: string; teamId: string },
  columns: readonly BoardColumn[],
): string {
  const exact = columns.find(
    (column) =>
      ownValue(linearTarget(column)?.statesByTeam, issue.teamId)?.id ===
      issue.stateId,
  );
  if (exact) return exact.id;
  const typed = columns.find((column) => column.id === `lt:${issue.stateType}`);
  return typed?.id ?? OTHER_COLUMN_ID;
}

export function linearIssueToCard(
  issue: LinearBoardIssue,
  columns: readonly BoardColumn[],
): BoardCard {
  const card: BoardCard = {
    provider: "linear",
    key: `linear:${issue.id}`,
    id: issue.id,
    ref: issue.identifier || `#${issue.number}`,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    state: issue.stateName,
    stateId: issue.stateId,
    stateType: issue.stateType,
    stateCategory: linearStateCategory(issue.stateType),
    columnId: linearCardColumnId(issue, columns),
    tags: issue.labels
      .filter((label) => label.name.trim())
      .map((label) => {
        const color = normalizeHexColor(label.color);
        return color ? { name: label.name, color } : { name: label.name };
      }),
    project: issue.projectName,
    teamId: issue.teamId,
    teamKey: issue.teamKey,
    teamName: issue.teamName,
    order: issue.sortOrder,
    updatedAt: issue.updatedAt,
  };
  const stateColor = normalizeHexColor(issue.stateColor);
  if (stateColor) card.stateColor = stateColor;
  if (issue.assignee?.login.trim()) {
    card.assignee = issue.assignee.avatarUrl
      ? { name: issue.assignee.login, avatarUrl: issue.assignee.avatarUrl }
      : { name: issue.assignee.login };
  }
  if (issue.estimate != null) card.effort = issue.estimate;
  if (issue.priority > 0) {
    card.priority = { value: issue.priority, label: issue.priorityLabel };
  }
  if (issue.cycle) {
    card.iteration = issue.cycle.name || `Cycle ${issue.cycle.number}`;
  }
  return card;
}

export function resolveLinearMove(
  card: BoardCard,
  column: BoardColumn,
): { stateId: string } | { error: BoardMoveRejection } {
  if (column.id === card.columnId) return { error: "same-column" };
  const target = linearTarget(column);
  if (!target) return { error: "not-allowed" };
  const state = ownValue(target.statesByTeam, card.teamId);
  if (!state) return { error: "not-allowed" };
  if (state.id === card.stateId) return { error: "same-column" };
  return { stateId: state.id };
}

/** Team board for one team, derived from an issue URL's workspace segment. */
export function linearBoardWebUrl(
  teams: readonly LinearBoardTeam[],
  teamIds: readonly string[],
  sampleIssueUrl: string | undefined,
): string | null {
  if (teamIds.length !== 1 || !sampleIssueUrl) return null;
  const team = teams.find((entry) => entry.id === teamIds[0]);
  if (!team?.key) return null;
  try {
    const url = new URL(sampleIssueUrl);
    const workspace = url.pathname.split("/").filter(Boolean)[0];
    if (!workspace) return null;
    return `${url.origin}/${workspace}/team/${encodeURIComponent(team.key)}/active`;
  } catch {
    return null;
  }
}
