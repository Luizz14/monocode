import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  EMPTY_BOARDS_SNAPSHOT,
  duplicateBoardConfig,
  getBoardsSnapshot,
  loadBoardConfigs,
  removeBoardConfig,
  saveActiveBoardId,
  saveBoardConfigs,
  subscribeBoardConfigs,
  upsertBoardConfig,
} from "../model/boardConfigs";
import { forgetBoardSnapshot } from "../model/boardSnapshot";
import type { BoardConfig } from "../model/boardTypes";

export type UseBoardConfigs = {
  configs: BoardConfig[];
  /** The active board's id; falls back to the first board. */
  activeId: string | null;
  active: BoardConfig | null;
  setActive: (id: string | null) => void;
  /** Adds or replaces the board and makes it active. Throws past 50 boards. */
  save: (config: BoardConfig) => void;
  /** Inserts a copy after the original and makes it active. */
  duplicate: (id: string) => BoardConfig | null;
  /** Deletes the board and its cached snapshot; activates a neighbor. */
  remove: (id: string) => void;
};

export function useBoardConfigs(): UseBoardConfigs {
  const { configs, activeId } = useSyncExternalStore(
    subscribeBoardConfigs,
    getBoardsSnapshot,
    () => EMPTY_BOARDS_SNAPSHOT,
  );

  const setActive = useCallback((id: string | null) => {
    saveActiveBoardId(id);
  }, []);

  const save = useCallback((config: BoardConfig) => {
    saveBoardConfigs(upsertBoardConfig(loadBoardConfigs(), config));
    saveActiveBoardId(config.id);
  }, []);

  const duplicate = useCallback((id: string) => {
    const result = duplicateBoardConfig(loadBoardConfigs(), id);
    if (!result) return null;
    saveBoardConfigs(result.configs);
    saveActiveBoardId(result.copy.id);
    return result.copy;
  }, []);

  const remove = useCallback((id: string) => {
    const current = loadBoardConfigs();
    const index = current.findIndex((config) => config.id === id);
    if (index === -1) return;
    const next = removeBoardConfig(current, id);
    const { activeId: stored } = getBoardsSnapshot();
    saveBoardConfigs(next);
    if (stored === id) {
      saveActiveBoardId(next[Math.min(index, next.length - 1)]?.id ?? null);
    }
    forgetBoardSnapshot(id);
  }, []);

  const active = useMemo(
    () => configs.find((config) => config.id === activeId) ?? null,
    [configs, activeId],
  );

  return { configs, activeId, active, setActive, save, duplicate, remove };
}
