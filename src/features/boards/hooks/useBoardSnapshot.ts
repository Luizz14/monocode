import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AZUREDEVOPS_CHANGE_EVENT } from "../../inbox/model/azureDevOps";
import { LINEAR_CHANGE_EVENT } from "../../inbox/model/linear";
import { boardQueryKey } from "../model/boardConfigs";
import { dropVerdict, groupCardsByColumn } from "../model/boardColumns";
import { invalidateBoardDetail } from "../model/boardDetail";
import { filterBoardCards } from "../model/boardFilter";
import { filterMineCards } from "../model/boardOwners";
import { commitBoardMove, optimisticPlacement } from "../model/boardMoves";
import {
  BoardLoadError,
  boardErrorMessage,
  boardSnapshotIsFresh,
  loadBoardSnapshot,
  patchCachedBoardCard,
  peekBoardSnapshot,
  type BoardLoadErrorCode,
  type BoardRefresh,
} from "../model/boardSnapshot";
import {
  applyBoardMoves,
  boardReducer,
  initialBoardState,
  pendingBoardMoveKeys,
} from "../model/boardState";
import type {
  BoardCard,
  BoardColumn,
  BoardConfig,
  BoardPerson,
  BoardSnapshot,
} from "../model/boardTypes";

/** Background refresh interval while the window is visible. */
export const BOARD_POLL_MS = 2 * 60_000;
/** Focus or visibility revalidates data older than this. */
export const BOARD_FOCUS_STALE_MS = 60_000;

export type UseBoardSnapshotOptions = {
  /** Stops polling and focus revalidation, such as during a drag or with a menu open. */
  paused?: boolean;
  /** Quick search from the toolbar, applied on top of the board's saved text. */
  search?: string;
  /** The toolbar's "Mine" chip: cards the user holds, plus untaken Proposed ones. */
  mine?: boolean;
};

export type BoardMoveOutcome =
  | { status: "moved"; card: BoardCard; column: BoardColumn }
  /** The same card is still moving. */
  | { status: "pending" }
  /** Already in that column. */
  | { status: "same" }
  | { status: "rejected"; reason: string }
  | { status: "failed"; error: string }
  /** The board changed while the move was in flight; nothing to show. */
  | { status: "stale" };

export type UseBoardSnapshot = {
  /** Server snapshot with optimistic and committed moves applied. */
  snapshot: BoardSnapshot | null;
  /** Sorted, filtered cards per column id; every column has an entry. */
  grouped: ReadonlyMap<string, BoardCard[]>;
  /** Cards left after the saved text and the quick search. */
  visibleCount: number;
  /** Loading with nothing to show yet. */
  loading: boolean;
  /** Loading while the current data stays on screen. */
  revalidating: boolean;
  error: string | null;
  errorCode: BoardLoadErrorCode | null;
  /** Keys of cards whose move is waiting for the provider. */
  pending: ReadonlySet<string>;
  /** Failed move per card key. */
  moveErrors: Readonly<Record<string, string>>;
  /** `items` (default) refetches cards; `all` also refetches team setup and columns. */
  refresh: (scope?: Exclude<BoardRefresh, "none">) => void;
  moveCard: (card: BoardCard, columnId: string) => Promise<BoardMoveOutcome>;
  /**
   * Shows `card` in place of the loaded one until a newer load replaces it,
   * for a change made outside a move, such as a task created for the card.
   */
  patchCard: (card: BoardCard) => void;
  /** The connected user, when the provider reported one. */
  me: BoardPerson | undefined;
  /** Without a key, clears the board-level error. */
  dismissMoveError: (key?: string) => void;
};

const EMPTY_GROUPS: ReadonlyMap<string, BoardCard[]> = new Map();

function boardEpoch(config: BoardConfig | null): string | null {
  return config ? `${config.id}|${boardQueryKey(config)}` : null;
}

function documentVisible(): boolean {
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}

export function useBoardSnapshot(
  config: BoardConfig | null,
  options: UseBoardSnapshotOptions = {},
): UseBoardSnapshot {
  const paused = options.paused === true;
  const search = options.search ?? "";
  const mine = options.mine === true;
  const epoch = boardEpoch(config);
  const [state, dispatch] = useReducer(boardReducer, null, () =>
    initialBoardState(epoch, config ? peekBoardSnapshot(config) : null),
  );
  // A different board or query starts over in this same render, so the old
  // board's cards never paint under the new one.
  if (state.epoch !== epoch) {
    dispatch({
      type: "reset",
      epoch,
      snapshot: config ? peekBoardSnapshot(config) : null,
    });
  }

  const configRef = useRef(config);
  configRef.current = config;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const seqRef = useRef(0);
  const loadingSeqRef = useRef<number | null>(null);
  const pendingRef = useRef(new Set<string>());

  const view = useMemo(
    () =>
      state.epoch === epoch
        ? applyBoardMoves(state.snapshot, state.moves)
        : null,
    [state.epoch, epoch, state.snapshot, state.moves],
  );
  const viewRef = useRef(view);
  viewRef.current = view;

  const load = useCallback((refresh: BoardRefresh) => {
    const current = configRef.current;
    if (!current) return;
    const loadEpoch = epochRef.current;
    const seq = ++seqRef.current;
    loadingSeqRef.current = seq;
    dispatch({ type: "load-start", seq });
    loadBoardSnapshot(current, refresh).then(
      (snapshot) => {
        if (loadingSeqRef.current === seq) loadingSeqRef.current = null;
        if (epochRef.current !== loadEpoch) return;
        dispatch({ type: "load-success", seq, snapshot });
      },
      (error: unknown) => {
        if (loadingSeqRef.current === seq) loadingSeqRef.current = null;
        if (epochRef.current !== loadEpoch) return;
        dispatch({
          type: "load-error",
          seq,
          error: boardErrorMessage(error),
          code: error instanceof BoardLoadError ? error.code : "provider",
        });
      },
    );
  }, []);

  // First load per board and query: cached and fresh shows as is, cached and
  // stale shows while it revalidates, nothing cached loads.
  useEffect(() => {
    const current = configRef.current;
    if (!current) return;
    const cached = peekBoardSnapshot(current);
    if (!cached) load("none");
    else if (!boardSnapshotIsFresh(cached)) load("items");
  }, [epoch, load]);

  const [visible, setVisible] = useState(documentVisible);

  const revalidateIfStale = useCallback(() => {
    if (pausedRef.current || !documentVisible()) return;
    if (loadingSeqRef.current !== null) return;
    const fetchedAt = viewRef.current?.fetchedAt;
    if (fetchedAt === undefined) return;
    if (Date.now() - fetchedAt > BOARD_FOCUS_STALE_MS) load("items");
  }, [load]);

  useEffect(() => {
    const onVisibility = () => {
      setVisible(documentVisible());
      revalidateIfStale();
    };
    window.addEventListener("focus", revalidateIfStale);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", revalidateIfStale);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidateIfStale]);

  useEffect(() => {
    if (!epoch || paused || !visible) return;
    const timer = window.setInterval(() => {
      if (loadingSeqRef.current !== null) return;
      load("items");
    }, BOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [epoch, paused, visible, load]);

  // Reconnecting or changing the token can change everything the board shows.
  const provider = config?.provider ?? null;
  useEffect(() => {
    if (!provider) return;
    const event =
      provider === "azuredevops"
        ? AZUREDEVOPS_CHANGE_EVENT
        : LINEAR_CHANGE_EVENT;
    const onChange = () => load("all");
    window.addEventListener(event, onChange);
    return () => window.removeEventListener(event, onChange);
  }, [provider, load]);

  const refresh = useCallback(
    (scope: Exclude<BoardRefresh, "none"> = "items") => load(scope),
    [load],
  );

  const moveCard = useCallback(
    async (card: BoardCard, columnId: string): Promise<BoardMoveOutcome> => {
      const board = viewRef.current;
      if (!board)
        return { status: "rejected", reason: "The board isn't loaded" };
      if (pendingRef.current.has(card.key)) return { status: "pending" };
      const current =
        board.cards.find((entry) => entry.key === card.key) ?? card;
      const column = board.columns.find((entry) => entry.id === columnId);
      if (!column) return { status: "rejected", reason: "That column is gone" };
      const verdict = dropVerdict(board, current, column);
      if (verdict.kind === "same") return { status: "same" };
      if (verdict.kind === "disallowed") {
        return { status: "rejected", reason: verdict.reason };
      }
      const moveEpoch = epochRef.current;
      pendingRef.current.add(card.key);
      dispatch({
        type: "move-start",
        seq: ++seqRef.current,
        card: optimisticPlacement(board, current, column),
      });
      try {
        const next = await commitBoardMove(board, current, column);
        patchCachedBoardCard(board.configId, next);
        if (board.azure) invalidateBoardDetail(board.azure.project, next.number);
        if (epochRef.current !== moveEpoch) return { status: "stale" };
        dispatch({ type: "move-success", seq: ++seqRef.current, card: next });
        return {
          status: "moved",
          card: next,
          column:
            board.columns.find((entry) => entry.id === next.columnId) ?? column,
        };
      } catch (error) {
        const message = boardErrorMessage(error);
        if (epochRef.current !== moveEpoch) return { status: "stale" };
        dispatch({ type: "move-failure", key: card.key, error: message });
        return { status: "failed", error: message };
      } finally {
        pendingRef.current.delete(card.key);
      }
    },
    [],
  );

  const patchCard = useCallback((card: BoardCard) => {
    // The move overlay is exactly "show the provider's answer until a newer
    // load", which is what a patched card needs.
    dispatch({ type: "card-patch", seq: ++seqRef.current, card });
    const configId = viewRef.current?.configId ?? configRef.current?.id;
    if (configId) patchCachedBoardCard(configId, card);
  }, []);

  const dismissMoveError = useCallback((key?: string) => {
    dispatch({ type: "dismiss-error", key });
  }, []);

  const savedText = config?.filters.text ?? "";
  // Cards with a move overlay stay in view under the Mine filter until a
  // newer load replaces the overlay, by then with the task they got.
  const movedKeys = useMemo(
    () => new Set(Object.keys(state.moves)),
    [state.moves],
  );
  const visibleCards = useMemo(
    () =>
      view
        ? filterMineCards(
            filterBoardCards(filterBoardCards(view.cards, savedText), search),
            mine,
            movedKeys,
          )
        : [],
    [view, savedText, search, mine, movedKeys],
  );
  const grouped = useMemo(
    () =>
      view ? groupCardsByColumn(view.columns, visibleCards) : EMPTY_GROUPS,
    [view, visibleCards],
  );
  const pending = useMemo(
    () => pendingBoardMoveKeys(state.moves),
    [state.moves],
  );

  return {
    snapshot: view,
    grouped,
    visibleCount: visibleCards.length,
    loading: state.loading,
    revalidating: state.revalidating,
    error: state.error,
    errorCode: state.errorCode,
    pending,
    moveErrors: state.moveErrors,
    refresh,
    moveCard,
    patchCard,
    me: view?.azure?.me,
    dismissMoveError,
  };
}
