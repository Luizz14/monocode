import type { ReactNode } from "react";
import {
  AlertCircle,
  Calendar,
  CheckCircle,
  CircleDashed,
  CircleX,
  Clock,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  LoaderCircle,
  Play,
  RefreshCw,
  Timer,
  Zap,
  type IconComponent,
} from "../../../shared/ui/icons";
import { RollNumber, RollText } from "../../../shared/ui/RollText";
import type {
  AzurePipeline,
  AzurePipelineRun,
} from "../model/azurePipelines";
import {
  branchLabel,
  folderLabel,
  formatDuration,
  formatRunDate,
  runDurationMs,
  runRequestedFor,
  runState,
  runStateLabel,
  runTitle,
  triggerLabel,
  type RunState,
  type RunTitleLookup,
} from "../model/pipelineFormat";

const STATE_ICONS: Record<RunState, { Icon: IconComponent; className: string }> =
  {
    succeeded: { Icon: CheckCircle, className: "text-emerald-400" },
    partiallySucceeded: { Icon: AlertCircle, className: "text-amber-400" },
    failed: { Icon: CircleX, className: "text-rose-400" },
    canceled: { Icon: CircleDashed, className: "text-content/45" },
    running: { Icon: LoaderCircle, className: "animate-spin text-blue-400" },
    queued: { Icon: Clock, className: "text-content/45" },
    none: { Icon: CircleDashed, className: "text-content/25" },
  };

export function RunStatusIcon({
  run,
  size = "size-5",
}: {
  run: AzurePipelineRun | null | undefined;
  size?: string;
}) {
  const state = runState(run);
  const { Icon, className } = STATE_ICONS[state];
  return (
    <span
      role="img"
      aria-label={runStateLabel(state)}
      title={runStateLabel(state)}
      className="grid shrink-0 place-items-center"
    >
      <Icon className={`${size} ${className}`} strokeWidth={1.75} />
    </span>
  );
}

const TRIGGER_ICONS: Record<string, IconComponent> = {
  schedule: Calendar,
  pullRequest: GitPullRequest,
  manual: Play,
  userCreated: Play,
  resourceTrigger: Zap,
  buildCompletion: Zap,
  triggered: Zap,
};

/** `Individual CI for Luiz · main`, the second line of a run in the web list. */
export function RunTrigger({ run }: { run: AzurePipelineRun }) {
  const TriggerIcon = TRIGGER_ICONS[run.reason] ?? RefreshCw;
  const person = runRequestedFor(run);
  const branch = branchLabel(run.sourceBranch);
  const BranchIcon = branch.kind === "pullRequest" ? GitPullRequest : GitBranch;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-content/55">
      <TriggerIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 shrink truncate">
        {person
          ? `${triggerLabel(run)} for ${person}`
          : triggerLabel(run)}
      </span>
      {branch.label ? (
        <>
          <BranchIcon className="ml-1.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 shrink-[2] truncate font-mono text-[11.5px]">
            {branch.label}
          </span>
        </>
      ) : null}
    </span>
  );
}

/** Date and duration column; a running run's timer keeps counting. */
export function RunTiming({
  run,
  now,
}: {
  run: AzurePipelineRun;
  now: number;
}) {
  const duration = runDurationMs(run, now);
  return (
    <span className="flex w-28 shrink-0 flex-col gap-1 text-[12px] text-content/55">
      <span className="flex items-center gap-1.5">
        <Calendar className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="truncate">
          {formatRunDate(run.queueTime || run.startTime, now)}
        </span>
      </span>
      <span className="flex items-center gap-1.5">
        <Timer className="size-3.5 shrink-0" strokeWidth={1.75} />
        {duration === null ? (
          <span>—</span>
        ) : (
          <RollNumber text={formatDuration(duration)} className="truncate" />
        )}
      </span>
    </span>
  );
}

function RowActions({ children }: { children: ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
      {children}
    </span>
  );
}

export function RowAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: IconComponent;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="grid size-7 place-items-center rounded-md text-content/55 hover:bg-content/10 hover:text-content focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon className="size-3.5" strokeWidth={1.75} />
    </button>
  );
}

const ROW =
  "group flex min-h-[72px] w-full cursor-pointer items-center gap-4 border-t border-stroke px-4 py-3 text-left hover:bg-content/[0.04]";

export function PipelineRow({
  pipeline,
  titles,
  now,
  onOpen,
  onRun,
  onOpenInBrowser,
}: {
  pipeline: AzurePipeline;
  titles: RunTitleLookup;
  now: number;
  onOpen: () => void;
  onRun: () => void;
  onOpenInBrowser: () => void;
}) {
  const run = pipeline.latestRun;
  const folder = folderLabel(pipeline.folder);
  return (
    <li className={ROW} onClick={onOpen} data-pipeline-row={pipeline.id}>
      <span className="flex min-w-0 basis-[34%] items-center gap-3">
        <RunStatusIcon run={run} />
        <span className="flex min-w-0 flex-col">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            className="min-w-0 truncate rounded-sm text-left text-[13.5px] font-semibold text-content focus-visible:outline-2 focus-visible:outline-accent"
          >
            {pipeline.name}
          </button>
          {folder ? (
            <span className="truncate text-[11.5px] text-content/45">
              {folder}
            </span>
          ) : null}
        </span>
      </span>
      {run ? (
        <>
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <RollText
              text={runTitle(run, titles)}
              className="min-w-0 truncate text-[13px] text-content/90"
            />
            <RunTrigger run={run} />
          </span>
          <RunTiming run={run} now={now} />
        </>
      ) : (
        <span className="flex-1 text-[12px] text-content/40">No runs yet</span>
      )}
      <RowActions>
        <RowAction label={`Run ${pipeline.name}`} icon={Play} onClick={onRun} />
        <RowAction
          label="Open pipeline in browser"
          icon={ExternalLink}
          onClick={onOpenInBrowser}
        />
      </RowActions>
    </li>
  );
}

export function RunRow({
  run,
  titles,
  now,
  showPipeline,
  onOpen,
}: {
  run: AzurePipelineRun;
  titles: RunTitleLookup;
  now: number;
  /** The Runs tab mixes pipelines; a pipeline's own history does not. */
  showPipeline: boolean;
  onOpen: () => void;
}) {
  return (
    <li className={ROW} onClick={onOpen} data-run-row={run.id}>
      <RunStatusIcon run={run} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          aria-label={`Open run ${run.number} in browser`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className="min-w-0 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-accent"
        >
          <RollText
            text={runTitle(run, titles)}
            className="block min-w-0 truncate text-[13px] text-content/90"
          />
        </button>
        {showPipeline ? (
          <span className="min-w-0 truncate text-[12px] font-medium text-content/70">
            {run.pipelineName}
          </span>
        ) : null}
        <RunTrigger run={run} />
      </span>
      <RunTiming run={run} now={now} />
      <RowActions>
        <RowAction
          label="Open run in browser"
          icon={ExternalLink}
          onClick={onOpen}
        />
      </RowActions>
    </li>
  );
}
