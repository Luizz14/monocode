import type { BoardLoadErrorCode } from "./boardSnapshot";
import type { BoardCard, BoardSnapshot } from "./boardTypes";

/**
 * A move overlaid on the server snapshot. Pending moves show the optimistic
 * card; committed ones show the provider's answer until a load that started
 * after the commit replaces it.
 */
export type BoardMoveEntry = {
  key: string;
  card: BoardCard;
  status: "pending" | "committed";
  startedSeq: number;
  committedSeq: number | null;
};

export type BoardState = {
  /** `${configId}|${queryKey}`; actions from another epoch never reach here. */
  epoch: string | null;
  /** Last server snapshot, without moves applied. */
  snapshot: BoardSnapshot | null;
  /** Loading with nothing to show yet. */
  loading: boolean;
  /** Loading while older data stays on screen. */
  revalidating: boolean;
  error: string | null;
  errorCode: BoardLoadErrorCode | null;
  /** Sequence of the newest load; older answers are ignored. */
  loadSeq: number;
  moves: Record<string, BoardMoveEntry>;
  moveErrors: Record<string, string>;
};

/**
 * `seq` values come from one counter shared by loads and moves, so a load can
 * tell whether it started after a move was committed.
 */
export type BoardAction =
  | { type: "reset"; epoch: string | null; snapshot: BoardSnapshot | null }
  | { type: "load-start"; seq: number }
  | { type: "load-success"; seq: number; snapshot: BoardSnapshot }
  | {
      type: "load-error";
      seq: number;
      error: string;
      code?: BoardLoadErrorCode | null;
    }
  | { type: "move-start"; seq: number; card: BoardCard }
  | { type: "move-success"; seq: number; card: BoardCard }
  | { type: "move-failure"; key: string; error: string }
  /** A card changed outside a move (a task made or removed for it). */
  | { type: "card-patch"; seq: number; card: BoardCard }
  /** Without `key`, clears the board-level error. */
  | { type: "dismiss-error"; key?: string };

export function initialBoardState(
  epoch: string | null = null,
  snapshot: BoardSnapshot | null = null,
): BoardState {
  return {
    epoch,
    snapshot,
    // A board with nothing cached is about to load; say so from the first paint.
    loading: epoch !== null && snapshot === null,
    revalidating: false,
    error: null,
    errorCode: null,
    loadSeq: 0,
    moves: {},
    moveErrors: {},
  };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export function boardReducer(
  state: BoardState,
  action: BoardAction,
): BoardState {
  switch (action.type) {
    case "reset":
      return initialBoardState(action.epoch, action.snapshot);
    case "load-start":
      if (action.seq < state.loadSeq) return state;
      return {
        ...state,
        loadSeq: action.seq,
        loading: state.snapshot === null,
        revalidating: state.snapshot !== null,
      };
    case "load-success": {
      if (action.seq !== state.loadSeq) return state;
      const moves: Record<string, BoardMoveEntry> = {};
      for (const [key, move] of Object.entries(state.moves)) {
        const settled =
          move.status === "committed" &&
          move.committedSeq !== null &&
          move.committedSeq < action.seq;
        if (!settled) moves[key] = move;
      }
      return {
        ...state,
        snapshot: action.snapshot,
        loading: false,
        revalidating: false,
        error: null,
        errorCode: null,
        moves,
      };
    }
    case "load-error":
      if (action.seq !== state.loadSeq) return state;
      // Data already on screen stays; the error rides along.
      return {
        ...state,
        loading: false,
        revalidating: false,
        error: action.error,
        errorCode: action.code ?? null,
      };
    case "move-start": {
      const key = action.card.key;
      if (state.moves[key]?.status === "pending") return state;
      return {
        ...state,
        moves: {
          ...state.moves,
          [key]: {
            key,
            card: action.card,
            status: "pending",
            startedSeq: action.seq,
            committedSeq: null,
          },
        },
        moveErrors: without(state.moveErrors, key),
      };
    }
    case "move-success": {
      const key = action.card.key;
      const move = state.moves[key];
      if (!move || move.status !== "pending") return state;
      return {
        ...state,
        moves: {
          ...state.moves,
          [key]: {
            ...move,
            card: action.card,
            status: "committed",
            committedSeq: action.seq,
          },
        },
      };
    }
    case "card-patch": {
      const key = action.card.key;
      // A move in flight owns the card until the provider answers.
      if (state.moves[key]?.status === "pending") return state;
      // Shown like a committed move: until a load that started after it.
      return {
        ...state,
        moves: {
          ...state.moves,
          [key]: {
            key,
            card: action.card,
            status: "committed",
            startedSeq: action.seq,
            committedSeq: action.seq,
          },
        },
      };
    }
    case "move-failure": {
      if (!state.moves[action.key]) return state;
      return {
        ...state,
        moves: without(state.moves, action.key),
        moveErrors: { ...state.moveErrors, [action.key]: action.error },
      };
    }
    case "dismiss-error":
      if (action.key === undefined) {
        return state.error === null
          ? state
          : { ...state, error: null, errorCode: null };
      }
      return { ...state, moveErrors: without(state.moveErrors, action.key) };
  }
}

/** The snapshot with every overlaid move's card swapped in. */
export function applyBoardMoves(
  snapshot: BoardSnapshot | null,
  moves: Readonly<Record<string, BoardMoveEntry>>,
): BoardSnapshot | null {
  if (!snapshot) return null;
  const keys = Object.keys(moves);
  if (keys.length === 0) return snapshot;
  let changed = false;
  const cards = snapshot.cards.map((card) => {
    const move = moves[card.key];
    if (!move) return card;
    changed = true;
    return move.card;
  });
  return changed ? { ...snapshot, cards } : snapshot;
}

export function pendingBoardMoveKeys(
  moves: Readonly<Record<string, BoardMoveEntry>>,
): Set<string> {
  const keys = new Set<string>();
  for (const move of Object.values(moves)) {
    if (move.status === "pending") keys.add(move.key);
  }
  return keys;
}
