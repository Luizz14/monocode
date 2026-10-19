import type {
  AzureAreaFilter,
  AzureAutoTask,
  AzureBoardConfig,
  AzureBoardFilters,
  AzureIterationFilter,
  BoardConfig,
  BoardProvider,
  LinearBoardConfig,
  LinearBoardFilters,
} from "./boardTypes";

export const BOARDS_KEY = "monocode.boards";
export const ACTIVE_BOARD_KEY = "monocode.activeBoard";
export const BOARDS_CHANGE_EVENT = "monocode:boards-change";

export const MAX_BOARDS = 50;
export const MAX_BOARD_NAME_LENGTH = 80;
export const MAX_BOARD_TEXT_LENGTH = 200;

export const MAX_AUTO_TASK_TITLE_LENGTH = 120;
export const DEFAULT_AUTO_TASK_TITLE = "Em implementação";

export const DEFAULT_BOARD_NAMES: Record<BoardProvider, string> = {
  azuredevops: "Azure DevOps board",
  linear: "Linear board",
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseIteration(value: unknown): AzureIterationFilter {
  const raw = record(value);
  if (raw?.kind === "any") return { kind: "any" };
  if (raw?.kind === "path") {
    const path = text(raw.path, 1000);
    if (path) return { kind: "path", path };
  }
  return { kind: "current" };
}

function parseAreas(value: unknown): AzureAreaFilter[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const areas: AzureAreaFilter[] = [];
  for (const entry of value) {
    const raw = record(entry);
    const path = text(raw?.path, 1000);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    areas.push({ path, includeChildren: raw?.includeChildren === true });
  }
  return areas;
}

function parseAzureFilters(raw: Record<string, unknown>): AzureBoardFilters {
  const level = record(raw.backlogLevel);
  return {
    project: text(raw.project, 256),
    team: text(raw.team, 256),
    backlogLevel: { id: text(level?.id, 256), name: text(level?.name, 256) },
    areaPaths: parseAreas(raw.areaPaths),
    iteration: parseIteration(raw.iteration),
    text: text(raw.text, MAX_BOARD_TEXT_LENGTH),
    assignedToMe: raw.assignedToMe === true,
    includeDone: raw.includeDone === true,
  };
}

/** Boards saved before this existed come back with the task on. */
function parseAutoTask(value: unknown): AzureAutoTask {
  const raw = record(value);
  return {
    enabled: raw?.enabled !== false,
    title:
      text(raw?.title, MAX_AUTO_TASK_TITLE_LENGTH) || DEFAULT_AUTO_TASK_TITLE,
  };
}

function parseLinearFilters(raw: Record<string, unknown>): LinearBoardFilters {
  const teamIds = Array.isArray(raw.teamIds)
    ? [
        ...new Set(
          raw.teamIds.filter(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          ),
        ),
      ]
    : [];
  return {
    teamIds,
    activeCycleOnly: raw.activeCycleOnly === true,
    assignedToMe: raw.assignedToMe === true,
    text: text(raw.text, MAX_BOARD_TEXT_LENGTH),
    includeDone: raw.includeDone === true,
  };
}

/** A stored board, coerced field by field; `null` when it cannot be one. */
export function parseBoardConfig(value: unknown): BoardConfig | null {
  const raw = record(value);
  if (!raw || raw.v !== 1) return null;
  const id = text(raw.id, 128);
  if (!id) return null;
  const filters = record(raw.filters);
  if (!filters) return null;
  const provider = raw.provider;
  if (provider !== "azuredevops" && provider !== "linear") return null;
  const name =
    text(raw.name, MAX_BOARD_NAME_LENGTH) || DEFAULT_BOARD_NAMES[provider];
  const createdAt =
    typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)
      ? raw.createdAt
      : 0;
  if (provider === "azuredevops") {
    return {
      v: 1,
      id,
      name,
      createdAt,
      provider,
      filters: parseAzureFilters(filters),
      autoTask: parseAutoTask(raw.autoTask),
    };
  }
  return {
    v: 1,
    id,
    name,
    createdAt,
    provider,
    filters: parseLinearFilters(filters),
  };
}

export function parseBoardConfigs(raw: string | null): BoardConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const configs: BoardConfig[] = [];
  for (const entry of parsed) {
    const config = parseBoardConfig(entry);
    if (!config || seen.has(config.id)) continue;
    seen.add(config.id);
    configs.push(config);
    if (configs.length >= MAX_BOARDS) break;
  }
  return configs;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Holds a value only while storage failed to keep it, so edits still apply to
// this window when localStorage is unavailable.
const unsaved = new Map<string, string | null>();

function readRaw(key: string): string | null {
  if (unsaved.has(key)) return unsaved.get(key) ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    unsaved.delete(key);
  } catch {
    unsaved.set(key, value);
  }
}

function notify() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(BOARDS_CHANGE_EVENT));
}

export function loadBoardConfigs(): BoardConfig[] {
  return parseBoardConfigs(readRaw(BOARDS_KEY));
}

export function saveBoardConfigs(configs: readonly BoardConfig[]) {
  writeRaw(BOARDS_KEY, JSON.stringify(configs.slice(0, MAX_BOARDS)));
  notify();
}

/** The stored active id when it still names a board, else the first board. */
export function resolveActiveBoardId(
  configs: readonly BoardConfig[],
  stored: string | null,
): string | null {
  if (stored && configs.some((config) => config.id === stored)) return stored;
  return configs[0]?.id ?? null;
}

export function loadActiveBoardId(
  configs: readonly BoardConfig[] = loadBoardConfigs(),
): string | null {
  return resolveActiveBoardId(configs, readRaw(ACTIVE_BOARD_KEY));
}

export function saveActiveBoardId(id: string | null) {
  writeRaw(ACTIVE_BOARD_KEY, id);
  notify();
}

export type BoardsSnapshot = {
  configs: BoardConfig[];
  activeId: string | null;
};

let snapshotCache: {
  boards: string | null;
  active: string | null;
  value: BoardsSnapshot;
} | null = null;

/** Stable while the stored strings are unchanged, for `useSyncExternalStore`. */
export function getBoardsSnapshot(): BoardsSnapshot {
  const boards = readRaw(BOARDS_KEY);
  const active = readRaw(ACTIVE_BOARD_KEY);
  if (
    snapshotCache &&
    snapshotCache.boards === boards &&
    snapshotCache.active === active
  ) {
    return snapshotCache.value;
  }
  const configs = parseBoardConfigs(boards);
  const value = { configs, activeId: resolveActiveBoardId(configs, active) };
  snapshotCache = { boards, active, value };
  return value;
}

export const EMPTY_BOARDS_SNAPSHOT: BoardsSnapshot = {
  configs: [],
  activeId: null,
};

export function subscribeBoardConfigs(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  // Other windows write the same localStorage; `storage` reports their saves.
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null &&
      event.key !== BOARDS_KEY &&
      event.key !== ACTIVE_BOARD_KEY
    ) {
      return;
    }
    if (event.key === null) unsaved.clear();
    else unsaved.delete(event.key);
    onChange();
  };
  window.addEventListener(BOARDS_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(BOARDS_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// ---------------------------------------------------------------------------
// List operations (pure)
// ---------------------------------------------------------------------------

/** Replaces the board with the same id, or appends it. Throws past the cap. */
export function upsertBoardConfig(
  configs: readonly BoardConfig[],
  config: BoardConfig,
): BoardConfig[] {
  const index = configs.findIndex((entry) => entry.id === config.id);
  if (index === -1) {
    if (configs.length >= MAX_BOARDS) {
      throw new Error(`You can keep up to ${MAX_BOARDS} boards`);
    }
    return [...configs, config];
  }
  const next = configs.slice();
  next[index] = config;
  return next;
}

export function removeBoardConfig(
  configs: readonly BoardConfig[],
  id: string,
): BoardConfig[] {
  return configs.filter((config) => config.id !== id);
}

function newBoardId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `board-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function copyName(name: string): string {
  return `${name} copy`.slice(0, MAX_BOARD_NAME_LENGTH);
}

/** Inserts a copy right after the original; `null` when absent or at the cap. */
export function duplicateBoardConfig(
  configs: readonly BoardConfig[],
  id: string,
  now = Date.now(),
): { configs: BoardConfig[]; copy: BoardConfig } | null {
  const index = configs.findIndex((config) => config.id === id);
  if (index === -1 || configs.length >= MAX_BOARDS) return null;
  const original = configs[index]!;
  const copy = JSON.parse(JSON.stringify(original)) as BoardConfig;
  copy.id = newBoardId();
  copy.name = copyName(original.name);
  copy.createdAt = now;
  const next = configs.slice();
  next.splice(index + 1, 0, copy);
  return { configs: next, copy };
}

export function newBoardConfig(
  provider: "azuredevops",
  filters?: Partial<AzureBoardFilters>,
): AzureBoardConfig;
export function newBoardConfig(
  provider: "linear",
  filters?: Partial<LinearBoardFilters>,
): LinearBoardConfig;
export function newBoardConfig(
  provider: BoardProvider,
  filters?: Partial<AzureBoardFilters> | Partial<LinearBoardFilters>,
): BoardConfig;
export function newBoardConfig(
  provider: BoardProvider,
  filters: Partial<AzureBoardFilters> | Partial<LinearBoardFilters> = {},
): BoardConfig {
  const base = {
    v: 1 as const,
    id: newBoardId(),
    name: DEFAULT_BOARD_NAMES[provider],
    createdAt: Date.now(),
  };
  if (provider === "azuredevops") {
    return {
      ...base,
      provider,
      filters: {
        project: "",
        team: "",
        backlogLevel: { id: "", name: "" },
        areaPaths: [],
        iteration: { kind: "current" },
        text: "",
        assignedToMe: false,
        includeDone: false,
        ...(filters as Partial<AzureBoardFilters>),
      },
      autoTask: { enabled: true, title: DEFAULT_AUTO_TASK_TITLE },
    };
  }
  return {
    ...base,
    provider,
    filters: {
      teamIds: [],
      activeCycleOnly: false,
      assignedToMe: false,
      text: "",
      includeDone: false,
      ...(filters as Partial<LinearBoardFilters>),
    },
  };
}

// ---------------------------------------------------------------------------
// Derived values
// ---------------------------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * What the provider is asked for: provider plus filters, without name and
 * text (text is filtered on the client). Same key, same server result.
 */
export function boardQueryKey(config: BoardConfig): string {
  if (config.provider === "azuredevops") {
    const { text: _text, ...filters } = config.filters;
    return JSON.stringify(
      canonical({
        provider: config.provider,
        ...filters,
        areaPaths: filters.areaPaths
          .slice()
          .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      }),
    );
  }
  const { text: _text, ...filters } = config.filters;
  return JSON.stringify(
    canonical({
      provider: config.provider,
      ...filters,
      teamIds: filters.teamIds.slice().sort(),
    }),
  );
}

/** What the board still needs before it can load, or `null`. */
export function boardConfigIssue(config: BoardConfig): string | null {
  if (config.provider === "azuredevops") {
    if (!config.filters.project.trim()) return "Pick an Azure DevOps project";
    if (!config.filters.team.trim()) return "Pick a team";
    return null;
  }
  if (config.filters.teamIds.length === 0) {
    return "Pick at least one Linear team";
  }
  return null;
}
