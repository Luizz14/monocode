import {
  AZUREDEVOPS_CHANGE_EVENT,
  azureDevOpsConnected,
} from "../../inbox/model/azureDevOps";
import { LINEAR_CHANGE_EVENT, linearConnected } from "../../inbox/model/linear";
import {
  AZURE_BOARD_LIMIT,
  AZURE_NO_ITERATION_NOTICE,
  azureBoardChildren,
  azureBoardMeta,
  azureBoardsMe,
  azureBoardWebUrl,
  azureChildToCardChild,
  azureItemToCard,
  azureQueryArgs,
  azureStateInfo,
  azureTeamSetup,
  buildAzureBoardColumns,
  buildAzureStateColumns,
  clearAzureBoardsCache,
  pickBacklogLevel,
  queryAzureBoard,
  type AzureBoardChildren,
  type AzureBoardsUser,
  type AzureIteration,
} from "./azureBoards";
import { boardConfigIssue, boardQueryKey } from "./boardConfigs";
import { withOtherColumn } from "./boardColumns";
import { clearBoardDetailCache } from "./boardDetail";
import { attachBoardChildren, groupChildrenByParent } from "./boardOwners";
import type {
  AzureBoardConfig,
  BoardCard,
  BoardCardChild,
  BoardConfig,
  BoardPerson,
  BoardProvider,
  BoardSnapshot,
  LinearBoardConfig,
} from "./boardTypes";
import {
  LINEAR_BOARD_LIMIT,
  buildLinearColumns,
  clearLinearBoardsCache,
  linearBoardStates,
  linearBoardWebUrl,
  linearIssueToCard,
  listLinearBoardIssues,
} from "./linearBoards";

/** `none` reuses a cached snapshot; `items` refetches items; `all` also refetches setup. */
export type BoardRefresh = "none" | "items" | "all";

/** A snapshot this young is shown without refetching. */
export const BOARD_FRESH_MS = 2 * 60_000;

export type BoardLoadErrorCode = "incomplete" | "not-connected" | "provider";

export class BoardLoadError extends Error {
  readonly code: BoardLoadErrorCode;
  readonly provider: BoardProvider;

  constructor(
    code: BoardLoadErrorCode,
    provider: BoardProvider,
    message: string,
  ) {
    super(message);
    this.name = "BoardLoadError";
    this.code = code;
    this.provider = provider;
  }
}

export function boardErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong";
}

let generation = 0;
const snapshots = new Map<string, BoardSnapshot>();
const inflight = new Map<string, Promise<BoardSnapshot>>();
let listening = false;

function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener(AZUREDEVOPS_CHANGE_EVENT, () =>
    clearBoardCaches("azuredevops"),
  );
  window.addEventListener(LINEAR_CHANGE_EVENT, () =>
    clearBoardCaches("linear"),
  );
}

/** Drops cached snapshots (and provider metadata) so the next load refetches. */
export function clearBoardCaches(provider?: BoardProvider) {
  generation += 1;
  for (const [id, snapshot] of snapshots) {
    if (!provider || snapshot.provider === provider) snapshots.delete(id);
  }
  inflight.clear();
  if (!provider || provider === "azuredevops") {
    clearAzureBoardsCache();
    clearBoardDetailCache();
  }
  if (!provider || provider === "linear") clearLinearBoardsCache();
}

export function forgetBoardSnapshot(configId: string) {
  snapshots.delete(configId);
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(`${configId}|`)) inflight.delete(key);
  }
}

/** The cached snapshot for this config, if it was loaded with the same query. */
export function peekBoardSnapshot(config: BoardConfig): BoardSnapshot | null {
  const snapshot = snapshots.get(config.id);
  return snapshot && snapshot.queryKey === boardQueryKey(config)
    ? snapshot
    : null;
}

export function boardSnapshotIsFresh(
  snapshot: BoardSnapshot,
  now = Date.now(),
  maxAgeMs = BOARD_FRESH_MS,
): boolean {
  return now - snapshot.fetchedAt < maxAgeMs;
}

/** Writes a moved card back into the cache so a remount shows it in place. */
export function patchCachedBoardCard(configId: string, card: BoardCard) {
  const snapshot = snapshots.get(configId);
  if (!snapshot) return;
  const index = snapshot.cards.findIndex((entry) => entry.key === card.key);
  if (index === -1) return;
  const cards = snapshot.cards.slice();
  cards[index] = card;
  snapshots.set(configId, { ...snapshot, cards });
}

export function loadBoardSnapshot(
  config: BoardConfig,
  refresh: BoardRefresh = "none",
): Promise<BoardSnapshot> {
  listen();
  const queryKey = boardQueryKey(config);
  if (refresh === "none") {
    const cached = peekBoardSnapshot(config);
    if (cached) return Promise.resolve(cached);
  }
  const key = `${config.id}|${queryKey}`;
  const running = inflight.get(key);
  if (running && refresh !== "all") return running;
  const started = generation;
  const pending = (
    config.provider === "azuredevops"
      ? loadAzure(config, queryKey, refresh === "all")
      : loadLinear(config, queryKey, refresh === "all")
  )
    .then((snapshot) => {
      if (started === generation && inflight.get(key) === pending) {
        snapshots.set(config.id, snapshot);
      }
      return snapshot;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

function checkConfig(config: BoardConfig) {
  const issue = boardConfigIssue(config);
  if (issue) throw new BoardLoadError("incomplete", config.provider, issue);
}

function formatDay(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function iterationTitle(iteration: AzureIteration): string {
  const start = formatDay(iteration.startDate);
  const finish = formatDay(iteration.finishDate);
  const dates = start && finish ? ` · ${start} – ${finish}` : "";
  return `${iteration.path}${dates}`;
}

function leaf(path: string): string {
  const parts = path.split("\\").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

async function loadAzure(
  config: AzureBoardConfig,
  queryKey: string,
  force: boolean,
): Promise<BoardSnapshot> {
  checkConfig(config);
  const status = await azureDevOpsConnected();
  if (!status.connected) {
    throw new BoardLoadError(
      "not-connected",
      "azuredevops",
      "Connect Azure DevOps in Settings",
    );
  }
  const { filters } = config;
  const project = filters.project.trim();
  const team = filters.team.trim();
  const setup = await azureTeamSetup(project, team, { force });
  const level = pickBacklogLevel(setup.backlogLevels, filters.backlogLevel);
  if (!level) {
    throw new BoardLoadError(
      "provider",
      "azuredevops",
      `The “${filters.backlogLevel.name || filters.backlogLevel.id}” backlog isn't available for ${team}`,
    );
  }
  const meta = await azureBoardMeta(project, team, level, { force });
  const stateInfo = azureStateInfo(meta.types);
  const boardColumns = meta.board
    ? buildAzureBoardColumns(meta.board, stateInfo)
    : [];
  const columns =
    boardColumns.length > 0
      ? boardColumns
      : buildAzureStateColumns(meta.types, stateInfo);

  let iterationLabel: string | undefined;
  let iterationTitleText: string | undefined;
  if (filters.iteration.kind === "current" && setup.currentIteration) {
    iterationLabel = setup.currentIteration.name;
    iterationTitleText = iterationTitle(setup.currentIteration);
  } else if (filters.iteration.kind === "path") {
    iterationLabel = leaf(filters.iteration.path);
    iterationTitleText = filters.iteration.path;
  }

  const base: BoardSnapshot = {
    configId: config.id,
    queryKey,
    provider: "azuredevops",
    columns,
    cards: [],
    truncated: false,
    doneHidden: !filters.includeDone,
    webUrl: azureBoardWebUrl(status.url, project, team, level.name),
    fetchedAt: Date.now(),
    limit: AZURE_BOARD_LIMIT,
    azure: {
      project,
      team,
      backlogLevel: level.name,
      columnField: meta.board?.columnField ?? null,
      doneField: meta.board?.doneField ?? null,
      orderField: setup.orderField,
      effortField: setup.effortField,
      stateInfo,
    },
  };
  if (iterationLabel !== undefined) base.iterationLabel = iterationLabel;
  if (iterationTitleText !== undefined)
    base.iterationTitle = iterationTitleText;

  if (filters.iteration.kind === "current" && !setup.currentIteration) {
    return { ...base, notice: AZURE_NO_ITERATION_NOTICE };
  }
  const args = azureQueryArgs(filters, setup, meta);
  if ("error" in args) return { ...base, notice: args.error };

  const result = await queryAzureBoard(args.query);
  const plain = result.items.map((item, index) =>
    azureItemToCard(item, columns, stateInfo, index),
  );
  // Children and the user's identity complete the owners. Either failing
  // leaves the board usable with the plain Assigned To.
  const [children, me] = await Promise.all([
    plain.length > 0
      ? azureBoardChildren(
          project,
          plain.map((card) => card.number),
        ).catch(() => null)
      : Promise.resolve<AzureBoardChildren | null>(null),
    azureBoardsMe({ force }).catch(() => null),
  ]);
  const cards = attachAzureChildren(plain, children, me);
  const azure = { ...base.azure! };
  const mePerson = azureMePerson(me);
  if (mePerson) azure.me = mePerson;
  if (children?.truncated) azure.childrenTruncated = true;
  return {
    ...base,
    azure,
    columns: withOtherColumn(columns, cards),
    cards,
    truncated: result.truncated,
    fetchedAt: Date.now(),
  };
}

function azureMePerson(me: AzureBoardsUser | null): BoardPerson | undefined {
  const name = me?.displayName.trim();
  const id = me?.id.trim();
  if (!id && !name) return undefined;
  const person: BoardPerson = { name: name || id || "", isMe: true };
  if (id) person.id = id;
  return person;
}

function attachAzureChildren(
  cards: readonly BoardCard[],
  children: AzureBoardChildren | null,
  me: AzureBoardsUser | null,
): BoardCard[] {
  const childInfo = azureStateInfo(children?.types ?? []);
  const byParent = groupChildrenByParent(
    children?.items ?? [],
    (child) => child.changedDate,
  );
  const converted = new Map<number, BoardCardChild[]>();
  for (const [parentId, items] of byParent) {
    converted.set(
      parentId,
      items.map((child) => azureChildToCardChild(child, childInfo)),
    );
  }
  return attachBoardChildren(cards, converted, azureMePerson(me), {
    childrenLoaded: children !== null,
  });
}

async function loadLinear(
  config: LinearBoardConfig,
  queryKey: string,
  force: boolean,
): Promise<BoardSnapshot> {
  checkConfig(config);
  const status = await linearConnected();
  if (!status.connected) {
    throw new BoardLoadError(
      "not-connected",
      "linear",
      "Connect Linear in Settings",
    );
  }
  const { filters } = config;
  const [teams, result] = await Promise.all([
    linearBoardStates(filters.teamIds, { force }),
    listLinearBoardIssues({
      teamIds: filters.teamIds,
      assignedToMe: filters.assignedToMe,
      activeCycleOnly: filters.activeCycleOnly,
      includeDone: filters.includeDone,
      limit: LINEAR_BOARD_LIMIT,
    }),
  ]);
  const columns = buildLinearColumns(teams, filters.teamIds);
  const cards = result.items.map((issue) => linearIssueToCard(issue, columns));
  const snapshot: BoardSnapshot = {
    configId: config.id,
    queryKey,
    provider: "linear",
    columns: withOtherColumn(columns, cards),
    cards,
    truncated: result.truncated,
    doneHidden: !filters.includeDone,
    webUrl: linearBoardWebUrl(teams, filters.teamIds, result.items[0]?.url),
    fetchedAt: Date.now(),
    limit: LINEAR_BOARD_LIMIT,
    linear: {
      teams: teams.filter((team) => filters.teamIds.includes(team.id)),
      multiTeam: filters.teamIds.length > 1,
    },
  };
  if (filters.activeCycleOnly) {
    const cycles = new Set(
      result.items
        .map((issue) => issue.cycle)
        .filter((cycle) => cycle !== null)
        .map((cycle) => cycle.name || `Cycle ${cycle.number}`),
    );
    snapshot.iterationLabel =
      cycles.size === 1 ? [...cycles][0]! : "Active cycles";
  }
  return snapshot;
}
