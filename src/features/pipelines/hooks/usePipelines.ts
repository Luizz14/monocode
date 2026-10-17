import { useEffect, useState } from "react";
import {
  AZUREDEVOPS_CHANGE_EVENT,
  azureDevOpsConnected,
  type AzureDevOpsStatus,
} from "../../inbox/model/azureDevOps";
import {
  clearAzurePipelinesCache,
  loadRunTitles,
  peekRunTitles,
  type AzurePipelineRun,
} from "../model/azurePipelines";
import type { RunTitleLookup } from "../model/pipelineFormat";

/**
 * The Azure DevOps connection from Settings, refreshed when it changes.
 * `null` until the first check resolves.
 */
export function useAzureDevOpsStatus(): AzureDevOpsStatus | null {
  const [status, setStatus] = useState<AzureDevOpsStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      azureDevOpsConnected()
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled)
            setStatus({ connected: false, url: "", organization: "" });
        });
    };
    const onChange = () => {
      clearAzurePipelinesCache();
      refresh();
    };
    refresh();
    window.addEventListener(AZUREDEVOPS_CHANGE_EVENT, onChange);
    return () => {
      cancelled = true;
      window.removeEventListener(AZUREDEVOPS_CHANGE_EVENT, onChange);
    };
  }, []);
  return status;
}

/** Pipelines rides on the Azure DevOps connection, so it shows only with one. */
export function usePipelinesAvailable(): boolean {
  return useAzureDevOpsStatus()?.connected ?? false;
}

/** Commit messages and PR titles for the runs on screen, fetched in the background. */
export function useRunTitles(
  project: string | null,
  runs: readonly AzurePipelineRun[],
): RunTitleLookup {
  const [titles, setTitles] = useState<RunTitleLookup>(() =>
    project ? peekRunTitles(project) : new Map(),
  );
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setTitles(peekRunTitles(project));
    loadRunTitles(project, runs)
      .then((next) => {
        if (!cancelled) setTitles(next);
      })
      // Titles are decoration; the list still reads without them.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [project, runs]);
  return titles;
}
