import { invoke } from "@tauri-apps/api/core";
import {
  BOARD_CATEGORY_RANK,
  OTHER_COLUMN_ID,
  azureStateCategory,
  normalizeHexColor,
  ownValue,
  type AzureAreaFilter,
  type AzureBoardFilters,
  type AzureColumnTarget,
  type AzureIterationFilter,
  type AzureStateInfo,
  type AzureStateMeta,
  type BoardCard,
  type BoardColumn,
  type BoardMoveRejection,
  type BoardStateCategory,
} from "./boardTypes";

// ---------------------------------------------------------------------------
// Wire types (mirror src-tauri/src/azure_boards.rs, camelCase)
// ---------------------------------------------------------------------------

export type AzureNamedRef = { id: string; name: string };

export type AzureBacklogLevel = {
  id: string;
  name: string;
  rank: number;
  /** `portfolio` or `requirement`. */
  kind: string;
  workItemTypes: string[];
  defaultWorkItemType: string | null;
  isHidden: boolean;
};

export type AzureIteration = {
  id: string;
  name: string;
  path: string;
  startDate: string | null;
  finishDate: string | null;
  /** `past`, `current` or `future`. */
  timeFrame: string;
};

export type AzureTeamSetup = {
  backlogLevels: AzureBacklogLevel[];
  orderField: string | null;
  effortField: string | null;
  bugsBehavior: string;
  /** Empty when the team is not scoped by `System.AreaPath`. */
  teamAreas: AzureAreaFilter[];
  defaultArea: string | null;
  iterations: AzureIteration[];
  currentIteration: AzureIteration | null;
};

export type AzureBoardLayoutColumn = {
  id: string;
  name: string;
  itemLimit: number;
  stateMappings: Record<string, string>;
  isSplit: boolean;
  /** `incoming`, `inProgress` or `outgoing`. */
  columnType: string;
};

export type AzureBoardLayout = {
  id: string;
  name: string;
  columnField: string | null;
  doneField: string | null;
  columns: AzureBoardLayoutColumn[];
};

export type AzureWorkItemTypeState = {
  name: string;
  color: string;
  /** Proposed, InProgress, Resolved, Completed or Removed. */
  category: string;
};

export type AzureWorkItemTypeStates = {
  name: string;
  states: AzureWorkItemTypeState[];
};

export type AzureBoardMeta = {
  board: AzureBoardLayout | null;
  types: AzureWorkItemTypeStates[];
};

export type AzureBoardQuery = {
  project: string;
  team: string;
  types: AzureWorkItemTypeStates[];
  areaPaths: AzureAreaFilter[];
  iteration: AzureIterationFilter;
  assignedToMe: boolean;
  includeDone: boolean;
  orderField: string | null;
  effortField: string | null;
  columnField: string | null;
  doneField: string | null;
  limit: number;
};

export type AzureBoardItem = {
  id: number;
  rev: number;
  workItemType: string;
  title: string;
  state: string;
  reason: string | null;
  assignedTo: {
    displayName: string;
    uniqueName: string;
    imageUrl: string | null;
  } | null;
  tags: string[];
  effort: number | null;
  order: number | null;
  priority: number | null;
  areaPath: string;
  iterationPath: string;
  changedDate: string;
  boardColumn: string | null;
  boardColumnDone: boolean;
  project: string;
  url: string;
};

export type AzureBoardQueryResult = {
  items: AzureBoardItem[];
  truncated: boolean;
};

export type AzureBoardMoveRequest = {
  project: string;
  id: number;
  state: string | null;
  columnField: string | null;
  column: string | null;
  doneField: string | null;
  done: boolean | null;
  orderField: string | null;
  effortField: string | null;
};

export const AZURE_BOARD_LIMIT = 500;
export const AZURE_NO_AREA_NOTICE =
  "This team doesn't scope by area. Pick areas for this board.";
export const AZURE_NO_ITERATION_NOTICE = "This team has no current iteration";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60_000;

type Entry<T> = { value: T; at: number };

let cacheGeneration = 0;
const setupCache = new Map<string, Entry<AzureTeamSetup>>();
const setupInflight = new Map<string, Promise<AzureTeamSetup>>();
const metaCache = new Map<string, Entry<AzureBoardMeta>>();
const metaInflight = new Map<string, Promise<AzureBoardMeta>>();
const areaCache = new Map<string, Entry<string[]>>();
const areaInflight = new Map<string, Promise<string[]>>();

/** TTL cache with one shared request per key; a clear drops late answers. */
function cachedCall<T>(
  cache: Map<string, Entry<T>>,
  inflight: Map<string, Promise<T>>,
  key: string,
  force: boolean,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (!force && hit && now - hit.at < CACHE_TTL_MS) {
    return Promise.resolve(hit.value);
  }
  const running = inflight.get(key);
  if (running && !force) return running;
  const generation = cacheGeneration;
  const pending = load()
    .then((value) => {
      if (generation === cacheGeneration && inflight.get(key) === pending) {
        cache.set(key, { value, at: Date.now() });
      }
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

function keyOf(...parts: string[]): string {
  return parts.join("\u0000");
}

export function clearAzureBoardsCache() {
  cacheGeneration += 1;
  setupCache.clear();
  setupInflight.clear();
  metaCache.clear();
  metaInflight.clear();
  areaCache.clear();
  areaInflight.clear();
}

export function listAzureProjects(): Promise<AzureNamedRef[]> {
  return invoke<AzureNamedRef[]>("azure_boards_projects");
}

export function listAzureTeams(project: string): Promise<AzureNamedRef[]> {
  return invoke<AzureNamedRef[]>("azure_boards_teams", {
    project: project.trim(),
  });
}

export function azureTeamSetup(
  project: string,
  team: string,
  options?: { force?: boolean },
): Promise<AzureTeamSetup> {
  const p = project.trim();
  const t = team.trim();
  return cachedCall(
    setupCache,
    setupInflight,
    keyOf(p, t),
    options?.force === true,
    () =>
      invoke<AzureTeamSetup>("azure_boards_team_setup", {
        project: p,
        team: t,
      }),
  );
}

export function azureBoardMeta(
  project: string,
  team: string,
  level: Pick<AzureBacklogLevel, "name" | "workItemTypes">,
  options?: { force?: boolean },
): Promise<AzureBoardMeta> {
  const p = project.trim();
  const t = team.trim();
  return cachedCall(
    metaCache,
    metaInflight,
    keyOf(p, t, level.name, ...level.workItemTypes),
    options?.force === true,
    () =>
      invoke<AzureBoardMeta>("azure_boards_board", {
        project: p,
        team: t,
        backlogLevel: level.name,
        workItemTypes: level.workItemTypes,
      }),
  );
}

/** Area paths in WIQL form (`Project\Parent\Leaf`). */
export function listAzureAreas(
  project: string,
  options?: { force?: boolean },
): Promise<string[]> {
  const p = project.trim();
  return cachedCall(areaCache, areaInflight, p, options?.force === true, () =>
    invoke<string[]>("azure_boards_areas", { project: p }),
  );
}

export function queryAzureBoard(
  query: AzureBoardQuery,
): Promise<AzureBoardQueryResult> {
  return invoke<AzureBoardQueryResult>("azure_boards_query", { query });
}

export function moveAzureCard(
  request: AzureBoardMoveRequest,
): Promise<AzureBoardItem> {
  return invoke<AzureBoardItem>("azure_boards_move", { request });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function azureStateInfo(
  types: readonly AzureWorkItemTypeStates[],
): AzureStateInfo {
  const info: AzureStateInfo = {};
  for (const type of types) {
    const states: Record<string, AzureStateMeta> = {};
    for (const state of type.states) {
      states[state.name] = {
        name: state.name,
        category: azureStateCategory(state.category),
        color: normalizeHexColor(state.color),
      };
    }
    info[type.name] = states;
  }
  return info;
}

export function azureStateMeta(
  info: AzureStateInfo,
  type: string | undefined,
  state: string,
): AzureStateMeta | undefined {
  return ownValue(ownValue(info, type), state);
}

/** Any type's metadata for a state name, for columns that map several types. */
function anyStateMeta(
  info: AzureStateInfo,
  state: string,
): AzureStateMeta | undefined {
  for (const type of Object.keys(info)) {
    const meta = azureStateMeta(info, type, state);
    if (meta) return meta;
  }
  return undefined;
}

export type AzureQueryArgsResult =
  { query: AzureBoardQuery } | { error: string };

/**
 * Arguments for `azure_boards_query`. Missing fields are `null`, never `""`.
 * With no areas picked, the team's areas apply; a team that is not scoped by
 * area needs explicit areas, so the query must not run.
 */
export function azureQueryArgs(
  filters: AzureBoardFilters,
  setup: AzureTeamSetup,
  meta: AzureBoardMeta,
  limit = AZURE_BOARD_LIMIT,
): AzureQueryArgsResult {
  const picked = filters.areaPaths.filter((area) => area.path.trim());
  const areaPaths = picked.length > 0 ? picked : setup.teamAreas;
  if (areaPaths.length === 0) return { error: AZURE_NO_AREA_NOTICE };
  const iteration: AzureIterationFilter =
    filters.iteration.kind === "path"
      ? filters.iteration.path.trim()
        ? { kind: "path", path: filters.iteration.path.trim() }
        : { kind: "any" }
      : filters.iteration;
  return {
    query: {
      project: filters.project.trim(),
      team: filters.team.trim(),
      types: meta.types,
      areaPaths: areaPaths.map((area) => ({
        path: area.path,
        includeChildren: area.includeChildren,
      })),
      iteration,
      assignedToMe: filters.assignedToMe,
      includeDone: filters.includeDone,
      orderField: setup.orderField || null,
      effortField: setup.effortField || null,
      columnField: meta.board?.columnField || null,
      doneField: meta.board?.doneField || null,
      limit,
    },
  };
}

function columnCategory(
  column: AzureBoardLayoutColumn,
  info: AzureStateInfo,
): { category: BoardStateCategory; color?: string } {
  for (const [type, state] of Object.entries(column.stateMappings)) {
    const meta = azureStateMeta(info, type, state);
    if (meta) return { category: meta.category, color: meta.color };
  }
  switch (column.columnType.toLowerCase()) {
    case "incoming":
      return { category: "todo" };
    case "outgoing":
      return { category: "done" };
    default:
      return { category: "inProgress" };
  }
}

/** Kanban columns in board order; a split column becomes Doing and Done halves. */
export function buildAzureBoardColumns(
  layout: AzureBoardLayout,
  info: AzureStateInfo,
): BoardColumn[] {
  const columns: BoardColumn[] = [];
  for (const column of layout.columns) {
    const { category, color } = columnCategory(column, info);
    const wipLimit = column.itemLimit > 0 ? column.itemLimit : undefined;
    const base = {
      title: column.name,
      color,
      category,
      ...(wipLimit !== undefined ? { wipLimit } : {}),
    };
    const target = (split: AzureColumnTarget["split"]): AzureColumnTarget => ({
      provider: "azuredevops",
      stateMappings: { ...column.stateMappings },
      boardColumn: column.name,
      split,
    });
    const id = `az:${column.id}`;
    if (column.isSplit) {
      columns.push(
        {
          ...base,
          id: `${id}:doing`,
          groupId: id,
          subtitle: "Doing",
          target: target("doing"),
        },
        {
          ...base,
          id: `${id}:done`,
          groupId: id,
          subtitle: "Done",
          target: target("done"),
        },
      );
    } else {
      columns.push({ ...base, id, target: target(null) });
    }
  }
  return columns;
}

/** Fallback when the team has no board: one column per state, by category. */
export function buildAzureStateColumns(
  types: readonly AzureWorkItemTypeStates[],
  info: AzureStateInfo,
): BoardColumn[] {
  const byState = new Map<
    string,
    { order: number; mappings: Record<string, string> }
  >();
  for (const type of types) {
    for (const state of type.states) {
      const meta = azureStateMeta(info, type.name, state.name);
      if (meta?.category === "canceled") continue;
      let entry = byState.get(state.name);
      if (!entry) {
        entry = { order: byState.size, mappings: {} };
        byState.set(state.name, entry);
      }
      entry.mappings[type.name] = state.name;
    }
  }
  return [...byState.entries()]
    .map(([name, entry]) => {
      const meta = anyStateMeta(info, name);
      return {
        order: entry.order,
        column: {
          id: `az-state:${name}`,
          title: name,
          color: meta?.color,
          category: meta?.category ?? "unknown",
          target: {
            provider: "azuredevops",
            stateMappings: entry.mappings,
            boardColumn: null,
            split: null,
          },
        } satisfies BoardColumn,
      };
    })
    .sort(
      (a, b) =>
        BOARD_CATEGORY_RANK[a.column.category] -
          BOARD_CATEGORY_RANK[b.column.category] || a.order - b.order,
    )
    .map((entry) => entry.column);
}

function azureTarget(column: BoardColumn): AzureColumnTarget | null {
  return column.target.provider === "azuredevops" ? column.target : null;
}

/**
 * Where a work item sits: its Kanban column when that column maps its state
 * (the split half from `boardColumnDone`), else the first column mapping its
 * type to its state, else any column mapping that state, else Other.
 */
export function azureCardColumnId(
  item: {
    workItemType: string;
    state: string;
    boardColumn: string | null;
    boardColumnDone: boolean;
  },
  columns: readonly BoardColumn[],
): string {
  const maps = (column: BoardColumn) =>
    ownValue(azureTarget(column)?.stateMappings, item.workItemType) ===
    item.state;
  if (item.boardColumn) {
    const named = columns.filter(
      (column) =>
        azureTarget(column)?.boardColumn === item.boardColumn && maps(column),
    );
    if (named.length > 0) {
      const half = named.find(
        (column) =>
          azureTarget(column)?.split ===
          (item.boardColumnDone ? "done" : "doing"),
      );
      return (half ?? named[0]!).id;
    }
  }
  const typed = columns.find(maps);
  if (typed) return typed.id;
  const any = columns.find((column) => {
    const target = azureTarget(column);
    return target
      ? Object.values(target.stateMappings).includes(item.state)
      : false;
  });
  return any?.id ?? OTHER_COLUMN_ID;
}

export function azureItemToCard(
  item: AzureBoardItem,
  columns: readonly BoardColumn[],
  info: AzureStateInfo,
  order: number,
): BoardCard {
  const meta = azureStateMeta(info, item.workItemType, item.state);
  const card: BoardCard = {
    provider: "azuredevops",
    key: `azuredevops:${item.id}`,
    id: String(item.id),
    ref: `#${item.id}`,
    number: item.id,
    title: item.title,
    url: item.url,
    type: item.workItemType,
    state: item.state,
    stateCategory: meta?.category ?? "unknown",
    columnId: azureCardColumnId(item, columns),
    boardColumnDone: item.boardColumnDone,
    tags: item.tags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((name) => ({ name })),
    project: item.project,
    order,
    updatedAt: item.changedDate,
    rev: item.rev,
  };
  if (meta?.color) card.stateColor = meta.color;
  if (item.boardColumn) card.boardColumn = item.boardColumn;
  // The avatar URL needs the PAT, so only the name is kept.
  const name = item.assignedTo?.displayName.trim();
  if (name) card.assignee = { name };
  if (item.effort != null) card.effort = item.effort;
  if (item.priority != null) {
    card.priority = {
      value: item.priority,
      label: `Priority ${item.priority}`,
    };
  }
  if (item.iterationPath) card.iteration = item.iterationPath;
  if (item.areaPath) card.area = item.areaPath;
  return card;
}

export type AzureMoveChange = {
  state: string | null;
  column: string | null;
  done: boolean | null;
};

/**
 * Fields to write for a drop. `done` is only touched with a done field: `true`
 * into a Done half, `false` when leaving one so the flag does not stick.
 */
export function resolveAzureMove(
  card: BoardCard,
  column: BoardColumn,
  fields: { columnField: string | null; doneField: string | null },
): AzureMoveChange | { error: BoardMoveRejection } {
  if (column.id === card.columnId) return { error: "same-column" };
  const target = azureTarget(column);
  if (!target) return { error: "not-allowed" };
  const mapped = ownValue(target.stateMappings, card.type);
  if (!mapped) return { error: "not-allowed" };
  const state = mapped === card.state ? null : mapped;
  const boardColumn =
    fields.columnField && target.boardColumn ? target.boardColumn : null;
  const columnChange =
    boardColumn !== null && boardColumn !== card.boardColumn
      ? boardColumn
      : null;
  let done: boolean | null = null;
  if (fields.doneField) {
    if (target.split === "done") {
      done = true;
    } else if (card.boardColumnDone === true) {
      done = false;
    }
  }
  if (state === null && columnChange === null && done === null) {
    return { error: "same-column" };
  }
  return { state, column: columnChange, done };
}

/** `{orgUrl}/{project}/_boards/board/t/{team}/{level}`. */
export function azureBoardWebUrl(
  orgUrl: string,
  project: string,
  team: string,
  level: string,
): string | null {
  const base = orgUrl.trim().replace(/\/+$/, "");
  if (!base || !project.trim() || !team.trim() || !level.trim()) return null;
  return `${base}/${encodeURIComponent(project.trim())}/_boards/board/t/${encodeURIComponent(
    team.trim(),
  )}/${encodeURIComponent(level.trim())}`;
}

/** The level a saved board points at: by id, then by name. */
export function pickBacklogLevel(
  levels: readonly AzureBacklogLevel[],
  wanted: { id: string; name: string },
): AzureBacklogLevel | null {
  const id = wanted.id.trim();
  if (id) {
    const byId = levels.find((level) => level.id === id);
    if (byId) return byId;
  }
  const name = wanted.name.trim().toLowerCase();
  if (name) {
    const byName = levels.find((level) => level.name.toLowerCase() === name);
    if (byName) return byName;
  }
  if (!id && !name) {
    return (
      levels.find((level) => level.kind === "requirement" && !level.isHidden) ??
      levels[0] ??
      null
    );
  }
  return null;
}
