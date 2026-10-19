export type BoardProvider = "azuredevops" | "linear";

export const BOARD_PROVIDER_LABELS: Record<BoardProvider, string> = {
  azuredevops: "Azure DevOps",
  linear: "Linear",
};

/** Provider-neutral bucket for a workflow state, used for ordering and color. */
export type BoardStateCategory =
  | "triage"
  | "backlog"
  | "todo"
  | "inProgress"
  | "resolved"
  | "done"
  | "canceled"
  | "unknown";

export const BOARD_CATEGORY_RANK: Record<BoardStateCategory, number> = {
  triage: 0,
  backlog: 1,
  todo: 2,
  inProgress: 3,
  resolved: 4,
  done: 5,
  canceled: 6,
  unknown: 7,
};

/** Cards whose state matches no column land here. */
export const OTHER_COLUMN_ID = "other";

/** Azure state categories: Proposed, InProgress, Resolved, Completed, Removed. */
export function azureStateCategory(category: string): BoardStateCategory {
  switch (category.trim().toLowerCase()) {
    case "proposed":
      return "todo";
    case "inprogress":
      return "inProgress";
    case "resolved":
      return "resolved";
    case "completed":
      return "done";
    case "removed":
      return "canceled";
    default:
      return "unknown";
  }
}

/** Linear workflow state types. */
export function linearStateCategory(type: string): BoardStateCategory {
  switch (type.trim().toLowerCase()) {
    case "triage":
    case "backlog":
    case "unstarted":
      return "todo";
    case "started":
      return "inProgress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return "canceled";
    default:
      return "unknown";
  }
}

export function isClosedCategory(category: BoardStateCategory): boolean {
  return category === "done" || category === "canceled";
}

/**
 * `#rrggbb` in lower case, or `undefined` for anything that is not a hex
 * color. Accepts 3, 6 or 8 digits with or without `#` (Azure sends
 * `b2b2b2`, Linear sends `#bec2c8`); alpha is dropped.
 */
export function normalizeHexColor(
  raw: string | null | undefined,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const hex = raw.trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return undefined;
  if (hex.length === 3) {
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  }
  if (hex.length === 6) return `#${hex}`;
  if (hex.length === 8) return `#${hex.slice(0, 6)}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Saved board configuration
// ---------------------------------------------------------------------------

export type AzureIterationFilter =
  { kind: "current" } | { kind: "any" } | { kind: "path"; path: string };

export type AzureAreaFilter = {
  path: string;
  includeChildren: boolean;
};

export type AzureBoardFilters = {
  project: string;
  team: string;
  /** The level's id is preferred; the name is the fallback (and the board route). */
  backlogLevel: { id: string; name: string };
  /** Empty means the team's own areas. */
  areaPaths: AzureAreaFilter[];
  iteration: AzureIterationFilter;
  /** Applied on the client by `filterBoardCards`. */
  text: string;
  assignedToMe: boolean;
  includeDone: boolean;
};

export type LinearBoardFilters = {
  teamIds: string[];
  activeCycleOnly: boolean;
  assignedToMe: boolean;
  /** Applied on the client by `filterBoardCards`. */
  text: string;
  includeDone: boolean;
};

type BoardConfigBase = {
  v: 1;
  id: string;
  name: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
};

/**
 * Taking a story means a child Task assigned to you. With this on, moving a
 * Proposed item into a work column makes that Task for you.
 */
export type AzureAutoTask = {
  enabled: boolean;
  /** The new Task's title. */
  title: string;
};

/** A column that exists only in MonoCode, for organizing work in flight. */
export type BoardLocalColumn = {
  id: string;
  title: string;
};

export type AzureBoardConfig = BoardConfigBase & {
  provider: "azuredevops";
  filters: AzureBoardFilters;
  /** Behavior, not a query: it never changes what the board loads. */
  autoTask: AzureAutoTask;
  /** Organizational columns spliced in after the work columns. */
  localColumns: BoardLocalColumn[];
};

export type LinearBoardConfig = BoardConfigBase & {
  provider: "linear";
  filters: LinearBoardFilters;
};

export type BoardConfig = AzureBoardConfig | LinearBoardConfig;

// ---------------------------------------------------------------------------
// Columns and cards
// ---------------------------------------------------------------------------

export type AzureColumnTarget = {
  provider: "azuredevops";
  /** Work item type -> state written when a card of that type lands here. */
  stateMappings: Record<string, string>;
  /** Kanban column name; `null` for state-based fallback columns. */
  boardColumn: string | null;
  split: "doing" | "done" | null;
};

export type LinearColumnState = {
  id: string;
  name: string;
  type: string;
  color: string;
};

export type LinearColumnTarget = {
  provider: "linear";
  /** Team id -> state an issue of that team moves to. */
  statesByTeam: Record<string, LinearColumnState>;
};

/** An organizational column kept only in MonoCode; parking writes nothing. */
export type LocalColumnTarget = { provider: "local"; localId: string };

export type BoardColumnTarget =
  | AzureColumnTarget
  | LinearColumnTarget
  | LocalColumnTarget
  | { provider: "none" };

export type BoardColumn = {
  id: string;
  /** Split halves share a group; WIP limits count per group. */
  groupId?: string;
  title: string;
  subtitle?: string;
  /** `#rrggbb`. */
  color?: string;
  wipLimit?: number;
  category: BoardStateCategory;
  target: BoardColumnTarget;
};

export type BoardCardTag = { name: string; color?: string };

export type BoardPerson = {
  /** Provider identity id; absent when the provider only gave a name. */
  id?: string;
  name: string;
  avatarUrl?: string;
  /** The connected user. */
  isMe?: boolean;
};

/** A child work item (Azure Task, Test...) of a card. */
export type BoardCardChild = {
  id: number;
  title: string;
  type: string;
  state: string;
  stateCategory: BoardStateCategory;
  assignee?: BoardPerson;
  updatedAt: string;
  url: string;
};

/**
 * Who holds the card. On teams that take a story by creating a child task,
 * the people on the children are the real owners; the card's own Assigned
 * To is the fallback when no child names anyone.
 */
export type BoardCardOwners = {
  primary: BoardPerson;
  others: BoardPerson[];
  source: "children" | "assignee";
};

export type BoardCard = {
  provider: BoardProvider;
  /** `${provider}:${id}`. */
  key: string;
  /** Azure: the numeric id as text. Linear: the issue UUID. */
  id: string;
  /** `#123` or `ENG-12`. */
  ref: string;
  number: number;
  title: string;
  url: string;
  /** Azure work item type. */
  type?: string;
  /** State name. */
  state: string;
  stateId?: string;
  stateType?: string;
  stateCategory: BoardStateCategory;
  /** `#rrggbb`. */
  stateColor?: string;
  columnId: string;
  boardColumn?: string;
  boardColumnDone?: boolean;
  assignee?: BoardPerson;
  /** Resolved by `resolveBoardOwners`; absent when nobody holds the card. */
  owners?: BoardCardOwners;
  /** Azure children, newest change first; absent when not loaded. */
  children?: BoardCardChild[];
  effort?: number;
  tags: BoardCardTag[];
  priority?: { value: number; label: string };
  /** Azure iteration path or Linear cycle name. */
  iteration?: string;
  /** Azure area path. */
  area?: string;
  /** Azure project or Linear project name ("" when none). */
  project: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  /** Provider order; lower first. */
  order: number;
  updatedAt: string;
  rev?: number;
};

export type AzureStateMeta = {
  name: string;
  category: BoardStateCategory;
  /** `#rrggbb`. */
  color?: string;
};

/** Work item type -> state name -> metadata, in the provider's state order. */
export type AzureStateInfo = Record<string, Record<string, AzureStateMeta>>;

export type LinearBoardState = {
  id: string;
  name: string;
  type: string;
  color: string;
  position: number;
};

export type LinearBoardTeam = {
  id: string;
  key: string;
  name: string;
  states: LinearBoardState[];
};

export type BoardSnapshot = {
  configId: string;
  queryKey: string;
  provider: BoardProvider;
  columns: BoardColumn[];
  cards: BoardCard[];
  truncated: boolean;
  /** Short label for the toolbar, such as the sprint name. */
  iterationLabel?: string;
  /** Path and dates for the label's tooltip. */
  iterationTitle?: string;
  /** Shown instead of cards when the board could not be queried as configured. */
  notice?: string;
  doneHidden: boolean;
  webUrl: string | null;
  /** `Date.now()` when the items were fetched. */
  fetchedAt: number;
  /** Item cap the provider applied; `truncated` means it was reached. */
  limit: number;
  azure?: {
    project: string;
    team: string;
    backlogLevel: string;
    columnField: string | null;
    doneField: string | null;
    orderField: string | null;
    effortField: string | null;
    stateInfo: AzureStateInfo;
    /** The connected user, when Azure reported one. */
    me?: BoardPerson;
    /** Children past the cap were not loaded, so some owners are incomplete. */
    childrenTruncated?: boolean;
  };
  linear?: {
    teams: LinearBoardTeam[];
    multiTeam: boolean;
  };
};

/** Lookup that ignores inherited keys such as `constructor`. */
export function ownValue<T>(
  record: Readonly<Record<string, T>> | null | undefined,
  key: string | undefined,
): T | undefined {
  if (!record || key === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

/** Why a card cannot move to a column. */
export type BoardMoveRejection = "not-allowed" | "same-column";
