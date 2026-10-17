import { useSyncExternalStore } from "react";
import { changelogStore } from "../model/releaseNotes";

/** The changelog text, or null until it has loaded. */
export function useChangelog(): string | null {
  return useSyncExternalStore(
    changelogStore.subscribe,
    changelogStore.get,
    changelogStore.get,
  );
}
