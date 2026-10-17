import { useEffect, useMemo, useState, type FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Modal } from "../../../shared/ui/Modal";
import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { SecondaryButton } from "../../../shared/ui/SecondaryButton";
import { RollText } from "../../../shared/ui/RollText";
import { ExternalLink, LoaderCircle, Play } from "../../../shared/ui/icons";
import {
  getAzurePipelineDefinition,
  getAzurePipelineRun,
  listAzurePipelineBranches,
  queueAzurePipelineRun,
  readAzurePipelineFile,
  type AzurePipeline,
  type AzurePipelineDefinition,
  type AzurePipelineRun,
} from "../model/azurePipelines";
import {
  isRunActive,
  runState,
  runStateLabel,
  runWebUrl,
} from "../model/pipelineFormat";
import {
  initialParameterValues,
  parameterPayload,
  parseRuntimeParameters,
  variablePayload,
  type PipelineParameter,
} from "../model/pipelineParameters";
import {
  initialRunBranch,
  isValidBranch,
  orderBranches,
} from "../model/pipelineSelection";
import { RunStatusIcon, RunTiming } from "./PipelineRows";

const RUN_POLL_MS = 5_000;
const PARAMETERS_DEBOUNCE_MS = 300;

const FIELD =
  "h-8 w-full rounded-md border border-content/10 bg-transparent px-2.5 text-[12px] text-content outline-none placeholder:text-content/35 focus:border-content/30";
const PRIMARY =
  "inline-flex h-7 items-center gap-1.5 rounded-md bg-accent px-3 text-[12px] font-medium text-white hover:bg-accent/85 disabled:cursor-default disabled:opacity-40";

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

type Props = {
  project: string;
  organizationUrl: string;
  pipeline: AzurePipeline;
  onClose: () => void;
  /** Called once Azure accepted the run, so lists can refresh. */
  onQueued: (run: AzurePipelineRun) => void;
  onShowRuns: () => void;
};

/**
 * Picks a branch (and runtime parameters or queue-time variables, when the
 * pipeline has them) and queues a run. Nothing is sent to Azure until the
 * user presses Run.
 */
export function RunPipelineDialog({
  project,
  organizationUrl,
  pipeline,
  onClose,
  onQueued,
  onShowRuns,
}: Props) {
  const [definition, setDefinition] = useState<AzurePipelineDefinition | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [branch, setBranch] = useState("");
  const [parameters, setParameters] = useState<PipelineParameter[]>([]);
  const [parametersState, setParametersState] = useState<
    "idle" | "loading" | "unreadable"
  >("idle");
  const [parameterValues, setParameterValues] = useState<
    Record<string, string>
  >({});
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [queued, setQueued] = useState<AzurePipelineRun | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    getAzurePipelineDefinition(project, pipeline.id)
      .then(async (next) => {
        if (cancelled) return;
        setDefinition(next);
        setVariableValues(
          Object.fromEntries(
            next.variables.map((variable) => [variable.name, variable.value]),
          ),
        );
        let names: string[] = [];
        if (next.repository.kind === "TfsGit" && next.repository.id) {
          names = await listAzurePipelineBranches(
            project,
            next.repository.id,
          ).catch(() => []);
        }
        if (cancelled) return;
        setBranches(names);
        setBranch(initialRunBranch(next.repository.defaultBranch, names));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [project, pipeline.id]);

  // Runtime parameters live in the YAML on the chosen branch.
  useEffect(() => {
    if (
      !definition?.yamlFilename ||
      definition.repository.kind !== "TfsGit" ||
      !isValidBranch(branch)
    ) {
      setParameters([]);
      setParametersState("idle");
      return;
    }
    let cancelled = false;
    setParametersState("loading");
    const timer = window.setTimeout(() => {
      readAzurePipelineFile(
        project,
        definition.repository.id,
        definition.yamlFilename,
        branch,
      )
        .then((yaml) => {
          if (cancelled) return;
          const next = parseRuntimeParameters(yaml);
          setParameters(next);
          // Keep what the user already typed for parameters that still exist.
          setParameterValues((current) => {
            const defaults = initialParameterValues(next);
            for (const name of Object.keys(defaults)) {
              if (name in current) defaults[name] = current[name];
            }
            return defaults;
          });
          setParametersState("idle");
        })
        .catch(() => {
          if (cancelled) return;
          setParameters([]);
          setParametersState("unreadable");
        });
    }, PARAMETERS_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [project, definition, branch]);

  // Follow the queued run until it finishes.
  useEffect(() => {
    if (!queued || !isRunActive(queued)) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1_000);
    const poll = window.setInterval(() => {
      getAzurePipelineRun(project, queued.id)
        .then(setQueued)
        .catch(() => undefined);
    }, RUN_POLL_MS);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [project, queued]);

  const branchOptions = useMemo(
    () =>
      orderBranches(
        branches ?? [],
        definition?.repository.defaultBranch ?? "",
      ).map((name) => ({ value: name, label: name })),
    [branches, definition],
  );

  const payload = useMemo(
    () => parameterPayload(parameters, parameterValues),
    [parameters, parameterValues],
  );
  const ready =
    definition !== null &&
    branches !== null &&
    isValidBranch(branch) &&
    parametersState !== "loading" &&
    payload.ok &&
    !submitting;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !definition || !payload.ok) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const run = await queueAzurePipelineRun(project, {
        pipelineId: pipeline.id,
        branch: branch.trim(),
        templateParameters: payload.templateParameters,
        variables: variablePayload(definition.variables, variableValues),
      });
      setQueued(run);
      setNow(Date.now());
      onQueued(run);
    } catch (reason: unknown) {
      setSubmitError(errorText(reason));
    } finally {
      setSubmitting(false);
    }
  };

  if (queued) {
    const state = runState(queued);
    return (
      <Modal onClose={onClose} title="Run pipeline" description={pipeline.name}>
        <div className="flex flex-col gap-4 px-4 pb-4 pt-4" data-run-queued={queued.id}>
          <div className="flex items-center gap-3 rounded-lg border border-stroke px-3 py-3">
            <RunStatusIcon run={queued} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium text-content">
                {`#${queued.number || queued.id}`}
              </span>
              <RollText
                text={runStateLabel(state)}
                className="min-w-0 truncate text-[12px] text-content/55"
              />
            </span>
            <RunTiming run={queued} now={now} />
          </div>
          <div className="flex justify-end gap-2">
            <SecondaryButton onClick={onShowRuns}>View runs</SecondaryButton>
            <SecondaryButton
              onClick={() =>
                void openUrl(runWebUrl(organizationUrl, project, queued)).catch(
                  () => undefined,
                )
              }
            >
              <ExternalLink className="size-3.5" strokeWidth={1.75} />
              Open run
            </SecondaryButton>
            <button type="button" className={PRIMARY} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Run pipeline" description={pipeline.name}>
      <form
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4 px-4 pb-4 pt-4"
      >
        {loadError ? (
          <p className="text-[12px] text-red-300/90">{loadError}</p>
        ) : !definition || branches === null ? (
          <p className="flex items-center gap-2 text-[12px] text-content/55">
            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
            Loading pipeline…
          </p>
        ) : (
          <>
            <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
              Branch
              {branchOptions.length ? (
                <SearchableSelect
                  label="Branch"
                  value={branch}
                  options={branchOptions}
                  onChange={setBranch}
                  searchPlaceholder="Search branches…"
                  emptyLabel="No matching branches"
                />
              ) : (
                <input
                  className={FIELD}
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="main"
                  spellCheck={false}
                  aria-label="Branch"
                />
              )}
            </label>
            {parametersState === "loading" ? (
              <p className="flex items-center gap-2 text-[12px] text-content/55">
                <LoaderCircle
                  className="size-3.5 animate-spin"
                  strokeWidth={1.75}
                />
                Reading parameters…
              </p>
            ) : null}
            {parametersState === "unreadable" ? (
              <p className="text-[12px] text-content/55">
                Could not read {definition.yamlFilename} on this branch; the run
                uses the pipeline's default parameters.
              </p>
            ) : null}
            {parametersState === "idle" && parameters.length ? (
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-[12px] font-medium text-content/80">
                  Parameters
                </legend>
                {parameters.map((parameter) => (
                  <ParameterField
                    key={parameter.name}
                    parameter={parameter}
                    value={parameterValues[parameter.name] ?? ""}
                    onChange={(value) =>
                      setParameterValues((current) => ({
                        ...current,
                        [parameter.name]: value,
                      }))
                    }
                  />
                ))}
              </fieldset>
            ) : null}
            {definition.variables.length ? (
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-2 text-[12px] font-medium text-content/80">
                  Variables
                </legend>
                {definition.variables.map((variable) => (
                  <label
                    key={variable.name}
                    className="flex flex-col gap-1.5 text-[12px] text-content/70"
                  >
                    {variable.name}
                    <input
                      className={FIELD}
                      type={variable.isSecret ? "password" : "text"}
                      placeholder={variable.isSecret ? "Unchanged" : ""}
                      value={variableValues[variable.name] ?? ""}
                      spellCheck={false}
                      onChange={(event) =>
                        setVariableValues((current) => ({
                          ...current,
                          [variable.name]: event.target.value,
                        }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ) : null}
          </>
        )}
        {!payload.ok && parametersState === "idle" ? (
          <p className="text-[12px] text-amber-400/90">{payload.error}</p>
        ) : null}
        {submitError ? (
          <p role="alert" className="text-[12px] text-red-300/90">
            {submitError}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
          <button type="submit" className={PRIMARY} disabled={!ready}>
            {submitting ? (
              <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Play className="size-3.5" strokeWidth={2} />
            )}
            Run
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ParameterField({
  parameter,
  value,
  onChange,
}: {
  parameter: PipelineParameter;
  value: string;
  onChange: (value: string) => void;
}) {
  if (parameter.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-[12px] text-content/80">
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--color-accent)]"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked ? "true" : "false")}
        />
        {parameter.displayName}
      </label>
    );
  }
  if (parameter.type === "other") {
    return (
      <p className="text-[12px] text-content/55">
        {parameter.displayName}{" "}
        <span className="text-content/40">
          ({parameter.rawType}, uses its default)
        </span>
      </p>
    );
  }
  return (
    <label className="flex flex-col gap-1.5 text-[12px] text-content/70">
      {parameter.displayName}
      {parameter.values.length ? (
        <SearchableSelect
          label={parameter.displayName}
          value={value}
          options={parameter.values.map((option) => ({
            value: option,
            label: option,
          }))}
          onChange={onChange}
          searchable={parameter.values.length > 8}
        />
      ) : (
        <input
          className={FIELD}
          inputMode={parameter.type === "number" ? "decimal" : undefined}
          value={value}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
