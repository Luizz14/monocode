import { useCallback, useEffect, useRef, useState } from "react";
import {
  AZUREDEVOPS_CHANGE_EVENT,
  azureDevOpsConnected,
} from "../../inbox/model/azureDevOps";
import { LINEAR_CHANGE_EVENT, linearConnected } from "../../inbox/model/linear";

export type BoardConnections = {
  /** `null` until the first status read answers. */
  azuredevops: boolean | null;
  linear: boolean | null;
  /** Connected organization as reported by Azure (a lower-case org URL). */
  azureOrganization: string | null;
  /** Normalized organization URL the PAT was saved for. */
  azureUrl: string | null;
  /** Reads both statuses again. */
  refresh: () => void;
};

/**
 * Connection status of both board providers, read on mount and again on
 * their change events. Reads can overlap; only the newest may write.
 */
export function useBoardConnections(): BoardConnections {
  const [state, setState] = useState<Omit<BoardConnections, "refresh">>({
    azuredevops: null,
    linear: null,
    azureOrganization: null,
    azureUrl: null,
  });
  const readRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let latest = 0;
    const read = () => {
      const generation = ++latest;
      void Promise.allSettled([azureDevOpsConnected(), linearConnected()]).then(
        ([azure, linear]) => {
          if (cancelled || generation !== latest) return;
          setState((prev) => ({
            azuredevops:
              azure.status === "fulfilled"
                ? azure.value.connected
                : prev.azuredevops,
            linear:
              linear.status === "fulfilled"
                ? linear.value.connected
                : prev.linear,
            azureOrganization:
              azure.status === "fulfilled"
                ? azure.value.connected
                  ? azure.value.organization || null
                  : null
                : prev.azureOrganization,
            azureUrl:
              azure.status === "fulfilled"
                ? azure.value.connected
                  ? azure.value.url || null
                  : null
                : prev.azureUrl,
          }));
        },
      );
    };
    readRef.current = read;
    read();
    window.addEventListener(AZUREDEVOPS_CHANGE_EVENT, read);
    window.addEventListener(LINEAR_CHANGE_EVENT, read);
    return () => {
      cancelled = true;
      readRef.current = () => {};
      window.removeEventListener(AZUREDEVOPS_CHANGE_EVENT, read);
      window.removeEventListener(LINEAR_CHANGE_EVENT, read);
    };
  }, []);

  const refresh = useCallback(() => readRef.current(), []);
  return { ...state, refresh };
}
