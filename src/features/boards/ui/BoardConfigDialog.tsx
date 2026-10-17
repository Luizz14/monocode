import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { LAYER } from "../../../shared/lib/layers";
import { Modal } from "../../../shared/ui/Modal";
import {
  SearchableSelect,
  type SearchableSelectOption,
} from "../../../shared/ui/SearchableSelect";
import { InboxProviderMark } from "../../inbox/ui/InboxProviderMark";
import type { BoardConnections } from "../hooks/useBoardConnections";
import {
  AZURE_NO_AREA_NOTICE,
  azureTeamSetup,
  listAzureAreas,
  listAzureProjects,
  listAzureTeams,
  pickBacklogLevel,
  type AzureNamedRef,
  type AzureTeamSetup,
} from "../model/azureBoards";
import {
  AZURE_URL_INVALID_MESSAGE,
  applyAzureUrlImport,
  azureOrgName,
  parseAzureBoardUrl,
  resolveAzureAreaHints,
  sameAzureOrg,
} from "../model/azureBoardUrl";
import {
  DEFAULT_BOARD_NAMES,
  MAX_BOARD_NAME_LENGTH,
  MAX_BOARD_TEXT_LENGTH,
  boardConfigIssue,
} from "../model/boardConfigs";
import { boardErrorMessage } from "../model/boardSnapshot";
import {
  BOARD_PROVIDER_LABELS,
  type AzureBoardConfig,
  type AzureBoardFilters,
  type AzureIterationFilter,
  type BoardConfig,
  type BoardProvider,
  type LinearBoardConfig,
  type LinearBoardFilters,
} from "../model/boardTypes";
import { listLinearTeams, type LinearTeam } from "../model/linearBoards";

const FIELD =
  "h-9 w-full rounded-md border border-content/10 bg-background-base px-2.5 text-[13px] text-content outline-none placeholder:text-content/35 focus:border-content/25 disabled:opacity-50";
const CHECKLIST =
  "flex max-h-44 flex-col overflow-y-auto overscroll-contain rounded-md border border-content/10 bg-background-base p-1";
const CHECK_ROW =
  "flex min-h-7 cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] text-content hover:bg-content/5";
/** Long area lists stay responsive; the search narrows them. */
const MAX_AREA_ROWS = 200;

type Props = {
  initial: BoardConfig;
  isNew: boolean;
  /** An Azure DevOps link to import as the dialog opens. */
  importUrl?: string;
  connections: BoardConnections;
  onOpenIntegrations: (provider: BoardProvider) => void;
  /** Saves and activates the board. May throw (too many boards). */
  onSave: (config: BoardConfig) => void;
  onClose: () => void;
};

export function BoardConfigDialog({
  initial,
  isNew,
  importUrl,
  connections,
  onOpenIntegrations,
  onSave,
  onClose,
}: Props) {
  const provider = initial.provider;
  const label = BOARD_PROVIDER_LABELS[provider];
  const connected = connections[provider];
  return (
    <Modal
      title={isNew ? `New ${label} board` : "Edit board"}
      description={isNew ? undefined : initial.name}
      size="md"
      fitViewport
      onClose={onClose}
    >
      {connected === false ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <p className="text-[12px] text-content/60">
            {label} isn't connected. Connect it to pick what this board shows.
          </p>
          <div className="flex w-full justify-end gap-2">
            <button type="button" onClick={onClose} className={SECONDARY}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenIntegrations(provider);
              }}
              className={PRIMARY}
            >
              <InboxProviderMark
                provider={provider}
                className="block size-3.5 shrink-0"
              />
              Connect {label}
            </button>
          </div>
        </div>
      ) : initial.provider === "azuredevops" ? (
        <AzureBoardForm
          initial={initial}
          isNew={isNew}
          importUrl={importUrl}
          connections={connections}
          onSave={onSave}
          onClose={onClose}
        />
      ) : (
        <LinearBoardForm
          initial={initial}
          isNew={isNew}
          onSave={onSave}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const SECONDARY =
  "rounded-md px-3 py-1.5 text-[12px] hover:bg-content/8 active:scale-[0.97]";
const PRIMARY =
  "inline-flex items-center gap-1.5 rounded-md bg-content px-3 py-1.5 text-[12px] font-medium text-background-base disabled:opacity-40 active:scale-[0.97]";

type Load<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

/**
 * Runs `load` whenever `key` changes (after `delay` ms), dropping answers for
 * an older key. A `null` key means there is nothing to load.
 */
function useLoad<T>(
  key: string | null,
  load: () => Promise<T>,
  delay = 0,
): Load<T> {
  const [state, setState] = useState<{ key: string | null; load: Load<T> }>({
    key: null,
    load: { status: "idle" },
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    const run = () => {
      loadRef.current().then(
        (value) => {
          if (!cancelled) setState({ key, load: { status: "ready", value } });
        },
        (error: unknown) => {
          if (!cancelled) {
            setState({
              key,
              load: { status: "error", error: boardErrorMessage(error) },
            });
          }
        },
      );
    };
    const timer = delay > 0 ? setTimeout(run, delay) : null;
    if (!timer) run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, delay]);
  if (key === null) return { status: "idle" };
  return state.key === key ? state.load : { status: "loading" };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-[12px] text-content/70">
      <span>{label}</span>
      {children}
      {hint ? (
        <span className="text-[11px] leading-snug text-content/45">{hint}</span>
      ) : null}
    </div>
  );
}

function Toggle({
  label,
  description,
  on,
  onChange,
  disabled = false,
}: {
  label: string;
  description?: string;
  on: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] text-content">{label}</div>
        {description ? (
          <div className="text-[11px] leading-snug text-content/45">
            {description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-label={label}
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          on ? "bg-accent" : "bg-content/20"
        }`}
      >
        <span
          className={`absolute top-0.5 size-4 rounded-full bg-white transition-[left] ${
            on ? "left-4.5" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function Footer({
  error,
  canSave,
  isNew,
  onClose,
}: {
  error: string | null;
  canSave: boolean;
  isNew: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {error ? (
        <p role="alert" className="text-[12px] text-red-400">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={SECONDARY}>
          Cancel
        </button>
        <button type="submit" disabled={!canSave} className={PRIMARY}>
          {isNew ? "Create board" : "Save"}
        </button>
      </div>
    </>
  );
}

function namedOptions(
  items: readonly { name: string }[],
  current: string,
): SearchableSelectOption[] {
  const options = items.map((item) => ({ value: item.name, label: item.name }));
  if (current && !options.some((option) => option.value === current)) {
    options.unshift({ value: current, label: current });
  }
  return options;
}

function trimName(value: string): string {
  return value.trim().slice(0, MAX_BOARD_NAME_LENGTH);
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

type Notice = { tone: "error" | "info"; text: string };

function iterationValue(iteration: AzureIterationFilter): string {
  return iteration.kind === "path" ? `path:${iteration.path}` : iteration.kind;
}

function parseIterationValue(value: string): AzureIterationFilter {
  if (value === "any") return { kind: "any" };
  if (value.startsWith("path:")) return { kind: "path", path: value.slice(5) };
  return { kind: "current" };
}

/** `Project\Parent\Leaf` without the project, for the checklist. */
function areaLabel(path: string): string {
  const parts = path.split("\\");
  return parts.length > 1 ? parts.slice(1).join(" \\ ") : path;
}

function AzureBoardForm({
  initial,
  isNew,
  importUrl,
  connections,
  onSave,
  onClose,
}: {
  initial: AzureBoardConfig;
  isNew: boolean;
  importUrl?: string;
  connections: BoardConnections;
  onSave: (config: BoardConfig) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<AzureBoardFilters>(initial.filters);
  const [name, setName] = useState(initial.name);
  const [nameEdited, setNameEdited] = useState(!isNew);
  const [link, setLink] = useState("");
  const [linkNotice, setLinkNotice] = useState<Notice | null>(null);
  const [areaHints, setAreaHints] = useState<string[] | null>(null);
  const [areaQuery, setAreaQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const project = filters.project.trim();
  const team = filters.team.trim();
  const projects = useLoad<AzureNamedRef[]>("projects", listAzureProjects);
  const teams = useLoad<AzureNamedRef[]>(
    project ? project : null,
    () => listAzureTeams(project),
    250,
  );
  const setup = useLoad<AzureTeamSetup>(
    project && team ? `${project}\u0000${team}` : null,
    () => azureTeamSetup(project, team),
    250,
  );
  const areas = useLoad<string[]>(
    project ? project : null,
    () => listAzureAreas(project),
    250,
  );
  const setupValue = setup.status === "ready" ? setup.value : null;
  const level = setupValue
    ? pickBacklogLevel(setupValue.backlogLevels, filters.backlogLevel)
    : null;

  // Leaving the field imports what was typed, but never re-applies a link
  // already imported over edits made since.
  const importedRef = useRef<string | null>(null);
  const importLink = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setLinkNotice(null);
      importedRef.current = null;
      return;
    }
    if (trimmed === importedRef.current) return;
    importedRef.current = trimmed;
    const parsed = parseAzureBoardUrl(trimmed);
    if (!parsed) {
      setLinkNotice({ tone: "error", text: AZURE_URL_INVALID_MESSAGE });
      return;
    }
    const connectedOrg = connections.azureUrl || connections.azureOrganization;
    if (connectedOrg && !sameAzureOrg(parsed.orgUrl, connectedOrg)) {
      setLinkNotice({
        tone: "error",
        text: `That link is for ${parsed.organization}, but Azure DevOps is connected to ${azureOrgName(connectedOrg)}.`,
      });
      return;
    }
    setFilters((current) => applyAzureUrlImport(current, parsed));
    setAreaHints(parsed.areaPathHints.length > 0 ? parsed.areaPathHints : null);
    setLinkNotice({ tone: "info", text: "Imported from the link." });
  };

  const importRef = useRef(importLink);
  importRef.current = importLink;
  useEffect(() => {
    if (importUrl) {
      setLink(importUrl);
      importRef.current(importUrl);
    }
  }, [importUrl]);

  // Pin the backlog level's id once the team's levels are known.
  useEffect(() => {
    if (!level) return;
    setFilters((current) =>
      current.backlogLevel.id === level.id &&
      current.backlogLevel.name === level.name
        ? current
        : { ...current, backlogLevel: { id: level.id, name: level.name } },
    );
  }, [level]);

  // Link area hints resolve once the project's areas (and, when it can, the
  // team's own areas for tie-breaks) have loaded.
  const setupSettled = setup.status !== "loading";
  useEffect(() => {
    if (!areaHints || areas.status === "loading" || !setupSettled) return;
    if (areas.status !== "ready") {
      setAreaHints(null);
      return;
    }
    const resolved = resolveAzureAreaHints(
      areaHints,
      areas.value,
      setupValue?.teamAreas.map((area) => area.path) ?? [],
    );
    setAreaHints(null);
    setFilters((current) => ({ ...current, areaPaths: resolved.areas }));
    const notes: string[] = [];
    if (resolved.ambiguous.length > 0) {
      notes.push(
        `Several areas match ${resolved.ambiguous.join(", ")}; all of them are selected.`,
      );
    }
    if (resolved.unresolved.length > 0) {
      notes.push(`No area matches ${resolved.unresolved.join(", ")}.`);
    }
    if (notes.length > 0) {
      setLinkNotice({ tone: "info", text: notes.join(" ") });
    }
  }, [areaHints, areas, setupSettled, setupValue]);

  const autoName =
    team && filters.backlogLevel.name
      ? trimName(`${team} · ${filters.backlogLevel.name}`)
      : team || DEFAULT_BOARD_NAMES.azuredevops;
  const shownName = nameEdited ? name : autoName;

  const setProject = (value: string) =>
    setFilters((current) =>
      value === current.project
        ? current
        : {
            ...current,
            project: value,
            team: "",
            backlogLevel: { id: "", name: "" },
            areaPaths: [],
            iteration: { kind: "current" },
          },
    );
  const setTeam = (value: string) =>
    setFilters((current) =>
      value === current.team
        ? current
        : {
            ...current,
            team: value,
            backlogLevel: { id: "", name: "" },
            iteration:
              current.iteration.kind === "path"
                ? { kind: "current" }
                : current.iteration,
          },
    );

  const config: AzureBoardConfig = {
    ...initial,
    name: trimName(shownName) || DEFAULT_BOARD_NAMES.azuredevops,
    filters: { ...filters, text: filters.text.trim() },
  };
  const issue = boardConfigIssue(config);
  const canSave = issue === null && areaHints === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    try {
      onSave(config);
      onClose();
    } catch (err) {
      setError(boardErrorMessage(err));
    }
  };

  const selectedAreas = useMemo(
    () => new Set(filters.areaPaths.map((area) => area.path)),
    [filters.areaPaths],
  );
  const areaList = areas.status === "ready" ? areas.value : [];
  const query = areaQuery.trim().toLowerCase();
  const shownAreas = useMemo(() => {
    const extra = filters.areaPaths
      .map((area) => area.path)
      .filter((path) => !areaList.includes(path));
    const all = [...extra, ...areaList];
    return (
      query ? all.filter((path) => path.toLowerCase().includes(query)) : all
    ).slice(0, MAX_AREA_ROWS);
  }, [areaList, filters.areaPaths, query]);

  const toggleArea = (path: string) =>
    setFilters((current) => {
      const has = current.areaPaths.some((area) => area.path === path);
      const includeChildren =
        current.areaPaths.length > 0 &&
        current.areaPaths.every((area) => area.includeChildren);
      return {
        ...current,
        areaPaths: has
          ? current.areaPaths.filter((area) => area.path !== path)
          : [...current.areaPaths, { path, includeChildren }],
      };
    });
  const subAreas =
    filters.areaPaths.length > 0 &&
    filters.areaPaths.every((area) => area.includeChildren);

  const projectOptions =
    projects.status === "ready" ? namedOptions(projects.value, project) : [];
  const teamOptions =
    teams.status === "ready" ? namedOptions(teams.value, team) : [];
  const levelOptions: SearchableSelectOption[] = setupValue
    ? setupValue.backlogLevels.map((entry) => ({
        value: entry.id,
        label: entry.isHidden ? `${entry.name} (hidden)` : entry.name,
        keywords: entry.workItemTypes.join(" "),
      }))
    : filters.backlogLevel.name
      ? [
          {
            value: filters.backlogLevel.id || filters.backlogLevel.name,
            label: filters.backlogLevel.name,
          },
        ]
      : [];
  const levelValue = level?.id ?? filters.backlogLevel.id;

  const current = setupValue?.currentIteration;
  const iterationOptions: SearchableSelectOption[] = [
    {
      value: "current",
      label: current ? `Current (${current.name})` : "Current iteration",
    },
    { value: "any", label: "Any iteration" },
    ...(setupValue?.iterations ?? []).map((iteration) => ({
      value: `path:${iteration.path}`,
      label: iteration.name,
      keywords: iteration.path,
    })),
  ];
  if (
    filters.iteration.kind === "path" &&
    !iterationOptions.some(
      (option) => option.value === iterationValue(filters.iteration),
    )
  ) {
    iterationOptions.push({
      value: iterationValue(filters.iteration),
      label: filters.iteration.path,
    });
  }

  const listHint =
    "Your token can't list these. Add the Project and Team (Read) scope, or type the name.";
  const noTeamAreas =
    setupValue !== null &&
    setupValue.teamAreas.length === 0 &&
    filters.areaPaths.length === 0;

  return (
    <form className="flex flex-col gap-4 p-4" onSubmit={submit}>
      <Field
        label="Import from link"
        hint={
          linkNotice ? (
            <span
              role={linkNotice.tone === "error" ? "alert" : undefined}
              className={linkNotice.tone === "error" ? "text-red-400" : ""}
            >
              {linkNotice.text}
            </span>
          ) : (
            "Paste a backlog, board or sprint link to fill in the fields."
          )
        }
      >
        <input
          aria-label="Import from link"
          className={FIELD}
          value={link}
          placeholder="https://dev.azure.com/org/project/_backlogs/backlog/…"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setLink(event.target.value);
            if (!event.target.value.trim()) setLinkNotice(null);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (!pasted.trim()) return;
            event.preventDefault();
            setLink(pasted);
            importLink(pasted);
          }}
          onBlur={() => importLink(link)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              importLink(link);
            }
          }}
        />
      </Field>

      <Field
        label="Project"
        hint={projects.status === "error" ? listHint : undefined}
      >
        {projects.status === "error" ? (
          <input
            aria-label="Project"
            className={FIELD}
            value={filters.project}
            placeholder="Project name"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setProject(event.target.value)}
          />
        ) : (
          <SearchableSelect
            label="Project"
            value={project}
            options={projectOptions}
            onChange={setProject}
            placeholder={
              projects.status === "ready"
                ? "Choose a project…"
                : "Loading projects…"
            }
            searchPlaceholder="Search projects…"
            emptyLabel="No matching projects"
            layer={LAYER.dialogPopover}
          />
        )}
      </Field>

      <Field
        label="Team"
        hint={
          teams.status === "error"
            ? listHint
            : setup.status === "error"
              ? `Couldn't read this team's settings: ${setup.error}`
              : undefined
        }
      >
        {teams.status === "error" ? (
          <input
            aria-label="Team"
            className={FIELD}
            value={filters.team}
            placeholder="Team name"
            disabled={!project}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTeam(event.target.value)}
          />
        ) : (
          <SearchableSelect
            label="Team"
            value={team}
            options={teamOptions}
            onChange={setTeam}
            disabled={!project}
            placeholder={
              !project
                ? "Pick a project first"
                : teams.status === "ready"
                  ? "Choose a team…"
                  : "Loading teams…"
            }
            searchPlaceholder="Search teams…"
            emptyLabel="No matching teams"
            layer={LAYER.dialogPopover}
          />
        )}
      </Field>

      <Field label="Backlog level">
        <SearchableSelect
          label="Backlog level"
          value={levelValue}
          options={levelOptions}
          disabled={!setupValue}
          searchable={false}
          onChange={(value) => {
            const picked = setupValue?.backlogLevels.find(
              (entry) => entry.id === value,
            );
            if (picked) {
              setFilters((currentFilters) => ({
                ...currentFilters,
                backlogLevel: { id: picked.id, name: picked.name },
              }));
            }
          }}
          placeholder={
            !team
              ? "Pick a team first"
              : setup.status === "loading"
                ? "Loading levels…"
                : "Choose a level…"
          }
          layer={LAYER.dialogPopover}
        />
      </Field>

      <Field
        label="Areas"
        hint={
          noTeamAreas ? (
            <span className="text-amber-500">{AZURE_NO_AREA_NOTICE}</span>
          ) : areas.status === "error" ? (
            `Couldn't list areas: ${areas.error}`
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1">
          <input
            aria-label="Filter areas"
            className={`${FIELD} h-8 text-[12px]`}
            value={areaQuery}
            placeholder="Filter areas"
            disabled={!project}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setAreaQuery(event.target.value)}
          />
          <div role="group" aria-label="Areas" className={CHECKLIST}>
            <label className={CHECK_ROW}>
              <input
                type="checkbox"
                checked={filters.areaPaths.length === 0}
                onChange={() =>
                  setFilters((currentFilters) => ({
                    ...currentFilters,
                    areaPaths: [],
                  }))
                }
                className="accent-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 truncate">
                Team areas (default)
              </span>
            </label>
            {areas.status === "loading" && project ? (
              <p className="px-1.5 py-1 text-[11.5px] text-content/40">
                Loading areas…
              </p>
            ) : null}
            {shownAreas.map((path) => (
              <label key={path} className={CHECK_ROW} title={path}>
                <input
                  type="checkbox"
                  checked={selectedAreas.has(path)}
                  onChange={() => toggleArea(path)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1 truncate">
                  {areaLabel(path)}
                </span>
              </label>
            ))}
          </div>
        </div>
      </Field>

      <Toggle
        label="Include sub-areas"
        on={subAreas}
        disabled={filters.areaPaths.length === 0}
        onChange={(on) =>
          setFilters((currentFilters) => ({
            ...currentFilters,
            areaPaths: currentFilters.areaPaths.map((area) => ({
              ...area,
              includeChildren: on,
            })),
          }))
        }
      />

      <Field label="Iteration">
        <SearchableSelect
          label="Iteration"
          value={iterationValue(filters.iteration)}
          options={iterationOptions}
          onChange={(value) =>
            setFilters((currentFilters) => ({
              ...currentFilters,
              iteration: parseIterationValue(value),
            }))
          }
          searchPlaceholder="Search iterations…"
          emptyLabel="No matching iterations"
          layer={LAYER.dialogPopover}
        />
      </Field>

      <Field label="Text" hint="Matches title, ID, tags and assignee">
        <input
          aria-label="Text"
          className={FIELD}
          value={filters.text}
          maxLength={MAX_BOARD_TEXT_LENGTH}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) =>
            setFilters((currentFilters) => ({
              ...currentFilters,
              text: event.target.value,
            }))
          }
        />
      </Field>

      <Toggle
        label="Assigned to me"
        on={filters.assignedToMe}
        onChange={(on) =>
          setFilters((currentFilters) => ({
            ...currentFilters,
            assignedToMe: on,
          }))
        }
      />
      <Toggle
        label="Include done"
        description="Show items in Completed states."
        on={filters.includeDone}
        onChange={(on) =>
          setFilters((currentFilters) => ({
            ...currentFilters,
            includeDone: on,
          }))
        }
      />

      <Field label="Name">
        <input
          aria-label="Name"
          className={FIELD}
          value={shownName}
          maxLength={MAX_BOARD_NAME_LENGTH}
          autoComplete="off"
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
        />
      </Field>

      <Footer
        error={error ?? (isNew ? null : issue)}
        canSave={canSave}
        isNew={isNew}
        onClose={onClose}
      />
    </form>
  );
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

function LinearBoardForm({
  initial,
  isNew,
  onSave,
  onClose,
}: {
  initial: LinearBoardConfig;
  isNew: boolean;
  onSave: (config: BoardConfig) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<LinearBoardFilters>(initial.filters);
  const [name, setName] = useState(initial.name);
  const [nameEdited, setNameEdited] = useState(!isNew);
  const [teamQuery, setTeamQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const teams = useLoad<LinearTeam[]>("teams", listLinearTeams);
  const teamList = teams.status === "ready" ? teams.value : [];

  const picked = teamList.filter((team) => filters.teamIds.includes(team.id));
  const autoName =
    picked.length > 0
      ? trimName(picked.map((team) => team.name).join(", "))
      : DEFAULT_BOARD_NAMES.linear;
  const shownName = nameEdited ? name : autoName;

  const config: LinearBoardConfig = {
    ...initial,
    name: trimName(shownName) || DEFAULT_BOARD_NAMES.linear,
    filters: { ...filters, text: filters.text.trim() },
  };
  const canSave = boardConfigIssue(config) === null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    try {
      onSave(config);
      onClose();
    } catch (err) {
      setError(boardErrorMessage(err));
    }
  };

  const query = teamQuery.trim().toLowerCase();
  const shownTeams = query
    ? teamList.filter((team) =>
        `${team.key} ${team.name}`.toLowerCase().includes(query),
      )
    : teamList;
  const missing = filters.teamIds.filter(
    (id) => !teamList.some((team) => team.id === id),
  );

  const toggleTeam = (id: string) =>
    setFilters((current) => ({
      ...current,
      teamIds: current.teamIds.includes(id)
        ? current.teamIds.filter((entry) => entry !== id)
        : [...current.teamIds, id],
    }));

  return (
    <form className="flex flex-col gap-4 p-4" onSubmit={submit}>
      <Field
        label="Teams"
        hint={
          teams.status === "error"
            ? `Couldn't list Linear teams: ${teams.error}`
            : "Pick at least one team. Several teams share columns by state type."
        }
      >
        <div className="flex flex-col gap-1">
          {teamList.length > 8 ? (
            <input
              aria-label="Filter teams"
              className={`${FIELD} h-8 text-[12px]`}
              value={teamQuery}
              placeholder="Filter teams"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setTeamQuery(event.target.value)}
            />
          ) : null}
          <div role="group" aria-label="Teams" className={CHECKLIST}>
            {teams.status === "loading" ? (
              <p className="px-1.5 py-1 text-[11.5px] text-content/40">
                Loading teams…
              </p>
            ) : null}
            {shownTeams.map((team) => (
              <label key={team.id} className={CHECK_ROW}>
                <input
                  type="checkbox"
                  checked={filters.teamIds.includes(team.id)}
                  onChange={() => toggleTeam(team.id)}
                  className="accent-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1 truncate">{team.name}</span>
                <span className="shrink-0 text-[11px] text-content/40">
                  {team.key}
                </span>
              </label>
            ))}
            {teams.status === "ready"
              ? missing.map((id) => (
                  <label key={id} className={CHECK_ROW}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() => toggleTeam(id)}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-content/50">
                      Unavailable team
                    </span>
                  </label>
                ))
              : null}
          </div>
        </div>
      </Field>

      <Toggle
        label="Active cycle only"
        on={filters.activeCycleOnly}
        onChange={(on) =>
          setFilters((current) => ({ ...current, activeCycleOnly: on }))
        }
      />
      <Toggle
        label="Assigned to me"
        on={filters.assignedToMe}
        onChange={(on) =>
          setFilters((current) => ({ ...current, assignedToMe: on }))
        }
      />

      <Field label="Text" hint="Matches title, ID, labels and assignee">
        <input
          aria-label="Text"
          className={FIELD}
          value={filters.text}
          maxLength={MAX_BOARD_TEXT_LENGTH}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) =>
            setFilters((current) => ({ ...current, text: event.target.value }))
          }
        />
      </Field>

      <Toggle
        label="Include done"
        description="Show completed and canceled issues."
        on={filters.includeDone}
        onChange={(on) =>
          setFilters((current) => ({ ...current, includeDone: on }))
        }
      />

      <Field label="Name">
        <input
          aria-label="Name"
          className={FIELD}
          value={shownName}
          maxLength={MAX_BOARD_NAME_LENGTH}
          autoComplete="off"
          onChange={(event) => {
            setNameEdited(true);
            setName(event.target.value);
          }}
        />
      </Field>

      <Footer error={error} canSave={canSave} isNew={isNew} onClose={onClose} />
    </form>
  );
}
