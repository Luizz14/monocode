import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import {
  ExternalLink,
  ListFilter,
  LoaderCircle,
  Play,
  RefreshCw,
  Rocket,
  X,
} from "../../../shared/ui/icons";
import { RollText } from "../../../shared/ui/RollText";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { useAzureDevOpsStatus, useRunTitles } from "../hooks/usePipelines";
import {
  listAzurePipelineRuns,
  listAzurePipelines,
  listAzurePipelinesProjects,
  peekAzurePipelines,
  type AzurePipeline,
  type AzurePipelineRun,
  type AzurePipelinesProject,
} from "../model/azurePipelines";
import {
  allPipelines,
  filterPipelines,
  filterRuns,
  isRunActive,
  newPipelineWebUrl,
  organizationName,
  pipelineWebUrl,
  pipelinesWebUrl,
  recentPipelines,
  runWebUrl,
} from "../model/pipelineFormat";
import {
  chooseProject,
  loadPipelinesProject,
  loadRecentPipelineProjects,
  orderProjects,
  savePipelinesProject,
} from "../model/pipelineSelection";
import { PipelineRow, RunRow, RunStatusIcon } from "./PipelineRows";
import { RunPipelineDialog } from "./RunPipelineDialog";

export type PipelinesTab = "recent" | "all" | "runs";

const TABS: { id: PipelinesTab; label: string }[] = [
  { id: "recent", label: "Recent" },
  { id: "all", label: "All" },
  { id: "runs", label: "Runs" },
];

/** Active runs refresh on this cadence while the view is open. */
const ACTIVE_POLL_MS = 15_000;
const RUNS_LIMIT = 50;

// Survive closing and reopening the view, like the web keeps its tab.
let rememberedTab: PipelinesTab = "recent";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  /** Opens Settings where Azure DevOps is connected. */
  onConnect?: () => void;
};

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function open(url: string) {
  if (url) void openUrl(url).catch(() => undefined);
}

export function PipelinesView({
  besideRail = false,
  compactRail = false,
  onClose,
  onToggleSidebar,
  onConnect,
}: Props) {
  const status = useAzureDevOpsStatus();
  const [projects, setProjects] = useState<AzurePipelinesProject[] | null>(
    null,
  );
  const [recentProjects, setRecentProjects] = useState(
    loadRecentPipelineProjects,
  );
  const [project, setProject] = useState<string | null>(loadPipelinesProject);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AzurePipeline | null>(null);
  const connected = status?.connected ?? false;
  const organizationUrl = status?.url ?? "";

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    listAzurePipelinesProjects()
      .then((next) => {
        if (cancelled) return;
        setProjects(next);
        setProjectsError(null);
        setProject((current) =>
          chooseProject(next, current, loadRecentPipelineProjects()),
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) setProjectsError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [connected, organizationUrl]);

  const pickProject = useCallback((name: string) => {
    setProject(name);
    setSelected(null);
    setRecentProjects(savePipelinesProject(name));
  }, []);

  const projectOptions = useMemo(
    () =>
      orderProjects(projects ?? [], recentProjects).map((entry) => ({
        value: entry.name,
        label: entry.name,
      })),
    [projects, recentProjects],
  );

  return (
    <div
      role="region"
      aria-label="Pipelines"
      data-app-pipelines
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 flex-1 items-center gap-1.5 px-3 text-[13px]"
        >
          <Rocket
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          {organizationUrl ? (
            <>
              <span className="min-w-0 shrink truncate text-content/60">
                {organizationName(organizationUrl)}
              </span>
              <span className="text-content/30">/</span>
            </>
          ) : null}
          {projectOptions.length && project ? (
            <span className="min-w-0 shrink" data-pipelines-project>
              <SearchableSelect
                label="Project"
                value={project}
                options={projectOptions}
                onChange={pickProject}
                variant="pill"
                searchPlaceholder="Search projects…"
                emptyLabel="No matching projects"
              />
            </span>
          ) : null}
          {project ? <span className="text-content/30">/</span> : null}
          {selected ? (
            <>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="shrink-0 rounded-sm text-content/60 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
              >
                Pipelines
              </button>
              <span className="text-content/30">/</span>
              <RollText
                text={selected.name}
                className="min-w-0 truncate text-content"
              />
            </>
          ) : (
            <span className="shrink-0 text-content">Pipelines</span>
          )}
        </nav>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {status === null ? (
        <CenteredNote>
          <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
        </CenteredNote>
      ) : !connected ? (
        <CenteredNote>
          <p>Connect Azure DevOps to see your pipelines.</p>
          {onConnect ? (
            <SecondaryButton onClick={onConnect}>
              Connect Azure DevOps
            </SecondaryButton>
          ) : null}
        </CenteredNote>
      ) : projectsError ? (
        <CenteredNote>
          <p className="text-red-300/90">{projectsError}</p>
        </CenteredNote>
      ) : !project ? (
        <CenteredNote>
          {projects ? (
            <p>No projects in this organization.</p>
          ) : (
            <LoaderCircle className="size-4 animate-spin" strokeWidth={1.75} />
          )}
        </CenteredNote>
      ) : (
        <PipelinesContent
          key={project}
          project={project}
          organizationUrl={organizationUrl}
          selected={selected}
          onSelect={setSelected}
        />
      )}
    </div>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-[13px] text-content/55">
      {children}
    </div>
  );
}

function PipelinesContent({
  project,
  organizationUrl,
  selected,
  onSelect,
}: {
  project: string;
  organizationUrl: string;
  selected: AzurePipeline | null;
  onSelect: (pipeline: AzurePipeline | null) => void;
}) {
  const lockOverscroll = useLockOverscroll<HTMLDivElement>();
  const [tab, setTab] = useState<PipelinesTab>(rememberedTab);
  const [query, setQuery] = useState("");
  const [pipelines, setPipelines] = useState<AzurePipeline[] | null>(() =>
    peekAzurePipelines(project),
  );
  const [runs, setRuns] = useState<AzurePipelineRun[] | null>(null);
  const [history, setHistory] = useState<AzurePipelineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [runTarget, setRunTarget] = useState<AzurePipeline | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const selectedId = selected?.id ?? null;
  const showRuns = tab === "runs" && selectedId === null;

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [nextPipelines, nextRuns] = await Promise.all([
        listAzurePipelines(project),
        selectedId !== null
          ? listAzurePipelineRuns(project, {
              pipelineId: selectedId,
              limit: RUNS_LIMIT,
            })
          : showRuns
            ? listAzurePipelineRuns(project, { limit: RUNS_LIMIT })
            : Promise.resolve(null),
      ]);
      setPipelines(nextPipelines);
      if (selectedId !== null) setHistory(nextRuns);
      else if (nextRuns) setRuns(nextRuns);
      setError(null);
    } catch (reason: unknown) {
      setError(errorText(reason));
    } finally {
      setRefreshing(false);
    }
  }, [project, selectedId, showRuns]);

  useEffect(() => {
    if (selectedId === null) setHistory(null);
    void refresh();
  }, [refresh, selectedId]);

  const visiblePipelines = useMemo(() => {
    if (!pipelines) return [];
    const ordered =
      tab === "all" ? allPipelines(pipelines) : recentPipelines(pipelines);
    return filterPipelines(ordered, query);
  }, [pipelines, tab, query]);

  const shownRuns = selectedId !== null ? history : showRuns ? runs : null;
  const titleRuns = useMemo(
    () =>
      shownRuns ??
      visiblePipelines.flatMap((pipeline) =>
        pipeline.latestRun ? [pipeline.latestRun] : [],
      ),
    [shownRuns, visiblePipelines],
  );
  const titles = useRunTitles(project, titleRuns);
  const visibleRuns = useMemo(
    () => (shownRuns ? filterRuns(shownRuns, query, titles) : []),
    [shownRuns, query, titles],
  );

  // Keep running timers ticking and statuses fresh while anything is active.
  const anyActive = titleRuns.some((run) => isRunActive(run));
  useEffect(() => {
    if (!anyActive) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => void refresh(), ACTIVE_POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [anyActive, refresh]);

  const pickTab = (next: PipelinesTab) => {
    rememberedTab = next;
    setTab(next);
  };

  const current =
    selectedId !== null
      ? (pipelines?.find((pipeline) => pipeline.id === selectedId) ?? selected)
      : null;
  const loading =
    selectedId !== null
      ? history === null
      : showRuns
        ? runs === null
        : pipelines === null;

  return (
    <div
      ref={lockOverscroll}
      className="min-h-0 flex-1 overflow-y-auto overscroll-none"
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-5 px-8 py-6">
        <header className="flex items-start gap-3">
          {current ? (
            <span className="mt-1">
              <RunStatusIcon run={current.latestRun} />
            </span>
          ) : null}
          <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold leading-8 text-content">
            {current ? current.name : "Pipelines"}
          </h1>
          <button
            type="button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => void refresh()}
            className="grid size-8 shrink-0 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
          >
            <RefreshCw
              className={`size-3.5 ${refreshing ? "animate-spin" : ""}`}
              strokeWidth={1.75}
            />
          </button>
          {current ? (
            <>
              <SecondaryButton
                onClick={() =>
                  open(pipelineWebUrl(organizationUrl, project, current))
                }
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
                Open in browser
              </SecondaryButton>
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent/85"
                onClick={() => setRunTarget(current)}
              >
                <Play className="size-3.5" strokeWidth={2} />
                Run pipeline
              </button>
            </>
          ) : (
            <>
              <SecondaryButton
                onClick={() =>
                  open(pipelinesWebUrl(organizationUrl, project, tab))
                }
              >
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
                Open in browser
              </SecondaryButton>
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center rounded-md bg-accent px-3.5 text-[13px] font-medium text-white hover:bg-accent/85"
                onClick={() => open(newPipelineWebUrl(organizationUrl, project))}
              >
                New pipeline
              </button>
            </>
          )}
        </header>

        <div className="flex items-end gap-4 border-b border-stroke">
          {current ? (
            <span className="border-b-2 border-accent pb-2 text-[13px] font-medium text-content">
              Runs
            </span>
          ) : (
            <div role="tablist" aria-label="Pipelines" className="flex gap-5">
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  onClick={() => pickTab(entry.id)}
                  className={`-mb-px border-b-2 pb-2 text-[13px] focus-visible:outline-2 focus-visible:outline-accent ${
                    tab === entry.id
                      ? "border-accent font-medium text-content"
                      : "border-transparent text-content/60 hover:text-content"
                  }`}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          )}
          <label className="mb-2 ml-auto flex h-8 w-72 max-w-[45%] items-center gap-2 rounded-md bg-content/[0.06] px-2.5 text-content/45 focus-within:text-content/70">
            <ListFilter className="size-3.5 shrink-0" strokeWidth={1.75} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={
                current || showRuns ? "Filter runs" : "Filter pipelines"
              }
              aria-label={current || showRuns ? "Filter runs" : "Filter pipelines"}
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-content outline-none placeholder:text-content/40"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear filter"
                onClick={() => setQuery("")}
                className="grid size-5 place-items-center rounded-sm hover:text-content"
              >
                <X className="size-3" strokeWidth={2} />
              </button>
            ) : null}
          </label>
        </div>

        {error ? (
          <p role="alert" className="text-[12px] text-red-300/90">
            {error}
          </p>
        ) : null}

        <section className="overflow-hidden rounded-lg border border-stroke bg-content/[0.025]">
          <h2 className="px-4 pb-2 pt-4 text-[15px] font-medium text-content">
            {current
              ? "Runs"
              : showRuns
                ? "Recent runs"
                : tab === "all"
                  ? "All pipelines"
                  : "Recently run pipelines"}
          </h2>
          {!current && !showRuns ? (
            <div className="flex gap-4 px-4 pb-2 text-[12px] font-medium text-content/55">
              <span className="basis-[34%] pl-8">Pipeline</span>
              <span className="flex-1">Last run</span>
            </div>
          ) : null}
          {loading ? (
            <p className="flex items-center gap-2 border-t border-stroke px-4 py-6 text-[12px] text-content/55">
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
              Loading…
            </p>
          ) : current || showRuns ? (
            visibleRuns.length ? (
              <ul>
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    titles={titles}
                    now={now}
                    showPipeline={!current}
                    onOpen={() =>
                      open(runWebUrl(organizationUrl, project, run))
                    }
                  />
                ))}
              </ul>
            ) : (
              <EmptyRows text={query ? "No runs match the filter." : "No runs yet."} />
            )
          ) : visiblePipelines.length ? (
            <ul>
              {visiblePipelines.map((pipeline) => (
                <PipelineRow
                  key={pipeline.id}
                  pipeline={pipeline}
                  titles={titles}
                  now={now}
                  onOpen={() => {
                    setQuery("");
                    onSelect(pipeline);
                  }}
                  onRun={() => setRunTarget(pipeline)}
                  onOpenInBrowser={() =>
                    open(pipelineWebUrl(organizationUrl, project, pipeline))
                  }
                />
              ))}
            </ul>
          ) : (
            <EmptyRows
              text={
                query
                  ? "No pipelines match the filter."
                  : tab === "recent"
                    ? "No pipelines have run yet."
                    : "No pipelines in this project."
              }
            />
          )}
        </section>
      </div>
      {runTarget ? (
        <RunPipelineDialog
          project={project}
          organizationUrl={organizationUrl}
          pipeline={runTarget}
          onClose={() => setRunTarget(null)}
          onQueued={() => void refresh()}
          onShowRuns={() => {
            setQuery("");
            onSelect(runTarget);
            setRunTarget(null);
          }}
        />
      ) : null}
    </div>
  );
}

function EmptyRows({ text }: { text: string }) {
  return (
    <p className="border-t border-stroke px-4 py-6 text-center text-[12px] text-content/45">
      {text}
    </p>
  );
}
