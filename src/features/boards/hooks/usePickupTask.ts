import { useCallback, useEffect, useRef, useState } from "react";
import {
  azureChildToCardChild,
  azurePerson,
  azureStateMeta,
  createAzureChild,
  deleteAzureWorkItem,
  type AzureBoardChild,
} from "../model/azureBoards";
import {
  guessStateCategory,
  invalidateBoardDetail,
} from "../model/boardDetail";
import { resolveBoardOwners } from "../model/boardOwners";
import { pickupDecision, pickupTitle } from "../model/boardPickup";
import { boardErrorMessage } from "../model/boardSnapshot";
import type {
  BoardCard,
  BoardCardChild,
  BoardColumn,
  BoardConfig,
  BoardPerson,
  BoardSnapshot,
} from "../model/boardTypes";

/** How long a finished toast stays; Undo is only offered while it shows. */
export const PICKUP_TOAST_MS = 10_000;
const MAX_TOASTS = 4;

type ToastBase = { id: number; cardKey: string; cardRef: string };

export type PickupToast =
  | (ToastBase & {
      kind: "created" | "exists";
      child: BoardCardChild;
      /** Where the Task lives, for Undo. */
      project: string;
      /** Undo is running. */
      undoing: boolean;
      /** Why the last Undo failed. */
      undoError?: string;
    })
  | (ToastBase & { kind: "undone"; child: BoardCardChild })
  | (ToastBase & { kind: "error"; message: string });

export type UsePickupTask = {
  toasts: readonly PickupToast[];
  /** Call after a move was saved: makes the user's Task when the rule says so. */
  afterMove: (before: BoardCard, column: BoardColumn, after: BoardCard) => void;
  dismiss: (id: number) => void;
  undo: (id: number) => void;
  retry: (id: number) => void;
};

type Options = {
  config: BoardConfig;
  /** The board as shown; read when an answer arrives, so it can be a ref's value each render. */
  snapshot: BoardSnapshot | null;
  /** Shows a changed card (see `useBoardSnapshot`). */
  patchCard: (card: BoardCard) => void;
  /** For the screen-reader live region. */
  announce: (message: string) => void;
};

/** The card with `children` in place of its own, and its owners resolved again. */
function withChildren(card: BoardCard, children: BoardCardChild[]): BoardCard {
  const next: BoardCard = { ...card, children };
  const owners = resolveBoardOwners(next, children);
  if (owners) next.owners = owners;
  else delete next.owners;
  return next;
}

/**
 * The Task Azure answered with as a card child. Its state is looked up in
 * the board's types first (a Task is only there when the board shows
 * Tasks), then guessed from common names such as Defined or To Do. It is
 * the user's by construction, so it is marked as theirs.
 */
function toCardChild(
  child: AzureBoardChild,
  snapshot: BoardSnapshot | null,
  me: BoardPerson | undefined,
): BoardCardChild {
  const info = snapshot?.azure?.stateInfo ?? {};
  const entry = azureChildToCardChild(child, info);
  entry.stateCategory =
    azureStateMeta(info, child.workItemType, child.state)?.category ??
    guessStateCategory(child.state);
  const person = azurePerson(child.assignedTo) ?? me;
  if (person) entry.assignee = { ...person, isMe: true };
  return entry;
}

/**
 * Picking up an item means taking it into a work column. On teams that hold
 * an item through a child Task, that is also the moment to make their Task,
 * so this does it right after the move is saved, shows what happened as a
 * toast, and offers Undo while the toast is up.
 */
export function usePickupTask(options: Options): UsePickupTask {
  const [toasts, setToasts] = useState<readonly PickupToast[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const nextId = useRef(0);
  /** Card keys whose Task is being made, so a repeat move cannot make two. */
  const running = useRef(new Set<string>());
  /** What a Retry needs to run the same creation again. */
  const attempts = useRef(
    new Map<number, { before: BoardCard; after: BoardCard }>(),
  );
  const timers = useRef(new Map<number, number>());

  const push = useCallback((toast: PickupToast) => {
    setToasts((current) => [...current, toast].slice(-MAX_TOASTS));
  }, []);

  const replace = useCallback((id: number, toast: PickupToast) => {
    setToasts((current) =>
      current.map((entry) => (entry.id === id ? toast : entry)),
    );
  }, []);

  const dismiss = useCallback((id: number) => {
    attempts.current.delete(id);
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  /** The card as the board shows it now, falling back to what the move gave. */
  const latest = useCallback((fallback: BoardCard): BoardCard => {
    return (
      optionsRef.current.snapshot?.cards.find(
        (entry) => entry.key === fallback.key,
      ) ?? fallback
    );
  }, []);

  const create = useCallback(
    async (before: BoardCard, after: BoardCard, replacing?: number) => {
      const key = after.key;
      if (running.current.has(key)) return;
      running.current.add(key);
      const { config, announce } = optionsRef.current;
      const project =
        after.project || optionsRef.current.snapshot?.azure?.project || "";
      try {
        const result = await createAzureChild({
          project,
          parentId: after.number,
          title: pickupTitle(config),
          areaPath: after.area ?? "",
          iterationPath: after.iteration ?? "",
          workItemType: "Task",
        });
        const { snapshot, patchCard } = optionsRef.current;
        const child = toCardChild(result.child, snapshot, snapshot?.azure?.me);
        const base = latest(after);
        patchCard(
          withChildren(base, [
            child,
            ...(base.children ?? []).filter((entry) => entry.id !== child.id),
          ]),
        );
        invalidateBoardDetail(project, after.number);
        const toast: PickupToast = {
          id: replacing ?? ++nextId.current,
          kind: result.created ? "created" : "exists",
          cardKey: key,
          cardRef: after.ref,
          child,
          project,
          undoing: false,
        };
        attempts.current.delete(replacing ?? -1);
        if (replacing !== undefined) replace(replacing, toast);
        else push(toast);
        announce(
          result.created
            ? `Created Task #${child.id} for ${after.ref}`
            : `You already have Task #${child.id} on ${after.ref}`,
        );
      } catch (failure) {
        const message = boardErrorMessage(failure);
        const id = replacing ?? ++nextId.current;
        attempts.current.set(id, { before, after });
        const toast: PickupToast = {
          id,
          kind: "error",
          cardKey: key,
          cardRef: after.ref,
          message,
        };
        if (replacing !== undefined) replace(replacing, toast);
        else push(toast);
        announce(`Couldn't create a task for ${after.ref}: ${message}`);
      } finally {
        running.current.delete(key);
      }
    },
    [latest, push, replace],
  );

  const afterMove = useCallback(
    (before: BoardCard, column: BoardColumn, after: BoardCard) => {
      const decision = pickupDecision(
        before,
        column,
        optionsRef.current.config,
      );
      if (decision.kind === "create") void create(before, after);
    },
    [create],
  );

  const retry = useCallback(
    (id: number) => {
      const attempt = attempts.current.get(id);
      if (!attempt) return;
      void create(attempt.before, attempt.after, id);
    },
    [create],
  );

  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const undo = useCallback(
    async (id: number) => {
      const toast = toastsRef.current.find((entry) => entry.id === id);
      if (!toast || toast.kind !== "created" || toast.undoing) return;
      const { announce, patchCard } = optionsRef.current;
      replace(id, { ...toast, undoing: true, undoError: undefined });
      const { project } = toast;
      try {
        await deleteAzureWorkItem(project, toast.child.id);
        const current = optionsRef.current.snapshot?.cards.find(
          (entry) => entry.key === toast.cardKey,
        );
        if (current) {
          patchCard(
            withChildren(
              current,
              (current.children ?? []).filter(
                (entry) => entry.id !== toast.child.id,
              ),
            ),
          );
          invalidateBoardDetail(project, current.number);
        }
        replace(id, {
          id,
          kind: "undone",
          cardKey: toast.cardKey,
          cardRef: toast.cardRef,
          child: toast.child,
        });
        announce(`Removed Task #${toast.child.id}`);
      } catch (failure) {
        replace(id, {
          ...toast,
          undoing: false,
          undoError: boardErrorMessage(failure),
        });
      }
    },
    [replace],
  );

  // A finished toast clears itself, but not while an Undo is running.
  useEffect(() => {
    const live = new Set<number>();
    for (const toast of toasts) {
      if (toast.kind === "error") continue;
      if (toast.kind === "created" && toast.undoing) continue;
      live.add(toast.id);
      if (timers.current.has(toast.id)) continue;
      timers.current.set(
        toast.id,
        window.setTimeout(() => {
          timers.current.delete(toast.id);
          setToasts((current) =>
            current.filter((entry) => entry.id !== toast.id),
          );
        }, PICKUP_TOAST_MS),
      );
    }
    for (const [id, timer] of timers.current) {
      if (live.has(id)) continue;
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, [toasts]);
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return {
    toasts,
    afterMove,
    dismiss,
    undo: useCallback((id: number) => void undo(id), [undo]),
    retry,
  };
}
