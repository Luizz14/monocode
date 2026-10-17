import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { setGrabbing, suppressTextSelection } from "../../../shared/lib/drag";
import type { DropVerdict } from "../model/boardColumns";

/** Pointer travel before a press becomes a drag. */
export const BOARD_DRAG_THRESHOLD = 5;
/** Grace for a pointerup that WebKit reports late before giving up. */
export const BOARD_LOST_POINTERUP_MS = 150;
/** Distance from an edge where auto-scroll starts. */
export const BOARD_AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_MAX_SPEED = 18;
const CLICK_SUPPRESS_MS = 400;

export const BOARD_DRAGGING_CLASS = "is-board-card-dragging";
export const BOARD_DRAG_PREVIEW_CLASS = "board-card-drag-preview";

export type UseBoardDragOptions = {
  /** Horizontal scroller holding the columns. */
  scroller: RefObject<HTMLElement | null>;
  /** Whether the card may land on the column, read on every column change. */
  verdict: (cardKey: string, columnId: string) => DropVerdict;
  /** Called on release over a column whose verdict is `ok`. */
  onDrop: (cardKey: string, columnId: string) => void;
  /** `false` ignores new presses and cancels a running drag. Default `true`. */
  enabled?: boolean;
};

export type BoardDragState = {
  cardKey: string;
  /** Column under the pointer (`data-board-column`), if any. */
  overColumnId: string | null;
  /** Verdict for that column; `null` when not over a column. */
  verdict: DropVerdict | null;
};

export type UseBoardDrag = {
  /** The running drag, or `null`. Changes only when the hovered column does. */
  drag: BoardDragState | null;
  /**
   * Attach to the card's primary button. The preview is cloned from the
   * closest `[data-board-card]` (or the button itself).
   */
  onCardPointerDown: (
    cardKey: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  /**
   * `true` once right after a drag ended, so the click that follows the
   * release does not open the card's menu. Call it first in `onClick`.
   */
  consumeClick: () => boolean;
  /** Cancels a running drag (Escape from an outer handler, for example). */
  cancel: () => void;
};

/** Column id under a viewport point, from the nearest `[data-board-column]`. */
export function boardColumnAt(x: number, y: number): string | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const element = document.elementFromPoint(x, y);
  const column = element?.closest<HTMLElement>("[data-board-column]");
  return column?.getAttribute("data-board-column") || null;
}

function sameVerdict(a: DropVerdict | null, b: DropVerdict | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return (
    a.kind !== "disallowed" ||
    (b.kind === "disallowed" && a.reason === b.reason)
  );
}

/** Speed for a pointer `distance` px inside an edge band; 0 outside it. */
function edgeSpeed(distance: number): number {
  if (distance >= BOARD_AUTOSCROLL_EDGE) return 0;
  const depth =
    (BOARD_AUTOSCROLL_EDGE - Math.max(0, distance)) / BOARD_AUTOSCROLL_EDGE;
  return Math.ceil(depth * AUTOSCROLL_MAX_SPEED);
}

function axisSpeed(pointer: number, start: number, end: number): number {
  if (end - start <= 0) return 0;
  const before = edgeSpeed(pointer - start);
  if (before > 0) return -before;
  return edgeSpeed(end - pointer);
}

function stripIds(root: Element) {
  root.removeAttribute("id");
  for (const element of root.querySelectorAll("[id]")) {
    element.removeAttribute("id");
  }
}

/**
 * Pointer-driven card drag across board columns: 5 px threshold, a cloned
 * preview on `document.body`, edge auto-scroll, and `html[data-board-drop]`
 * reflecting the hovered column's verdict. Escape, blur and pointercancel
 * cancel; a lost pointerup cancels after a short grace.
 */
export function useBoardDrag({
  scroller,
  verdict,
  onDrop,
  enabled = true,
}: UseBoardDragOptions): UseBoardDrag {
  const [drag, setDrag] = useState<BoardDragState | null>(null);
  const verdictRef = useRef(verdict);
  verdictRef.current = verdict;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickUntil = useRef(0);

  const cancel = useCallback(() => {
    cleanupRef.current?.();
  }, []);

  const consumeClick = useCallback(() => {
    if (performance.now() < suppressClickUntil.current) {
      suppressClickUntil.current = 0;
      return true;
    }
    return false;
  }, []);

  const onCardPointerDown = useCallback(
    (cardKey: string, event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || !enabledRef.current || cleanupRef.current)
        return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
        return;
      const handle = event.currentTarget;
      const source = handle.closest<HTMLElement>("[data-board-card]") ?? handle;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let lastX = startX;
      let lastY = startY;
      let grabX = 0;
      let grabY = 0;
      let active = false;
      let preview: HTMLElement | null = null;
      let restoreSelection: (() => void) | undefined;
      let current: BoardDragState | null = null;
      let scrollFrame = 0;
      let lostPointerUpTimer: ReturnType<typeof setTimeout> | undefined;
      const root = document.documentElement;

      const movePreview = () => {
        if (!preview) return;
        preview.style.transform = `translate3d(${Math.round(
          lastX - grabX,
        )}px, ${Math.round(lastY - grabY)}px, 0)`;
      };

      const createPreview = () => {
        const rect = source.getBoundingClientRect();
        grabX = startX - rect.left;
        grabY = startY - rect.top;
        const clone = source.cloneNode(true) as HTMLElement;
        stripIds(clone);
        clone.removeAttribute("data-board-card");
        clone.removeAttribute("tabindex");
        for (const element of clone.querySelectorAll("[tabindex]")) {
          element.removeAttribute("tabindex");
        }
        clone.setAttribute("aria-hidden", "true");
        clone.setAttribute("inert", "");
        clone.classList.add(BOARD_DRAG_PREVIEW_CLASS);
        if (rect.width > 0) clone.style.width = `${Math.round(rect.width)}px`;
        preview = clone;
        document.body.append(clone);
        movePreview();
      };

      const updateTarget = () => {
        const columnId = boardColumnAt(lastX, lastY);
        const nextVerdict = columnId
          ? verdictRef.current(cardKey, columnId)
          : null;
        if (
          current &&
          current.overColumnId === columnId &&
          sameVerdict(current.verdict, nextVerdict)
        ) {
          return;
        }
        current = { cardKey, overColumnId: columnId, verdict: nextVerdict };
        if (nextVerdict) root.dataset.boardDrop = nextVerdict.kind;
        else delete root.dataset.boardDrop;
        setDrag(current);
      };

      const verticalScroller = (): HTMLElement | null => {
        if (typeof document.elementFromPoint !== "function") return null;
        const element = document.elementFromPoint(lastX, lastY);
        const column = element?.closest<HTMLElement>("[data-board-column]");
        if (!column) return null;
        return column.querySelector<HTMLElement>("[data-board-list]") ?? column;
      };

      const autoScroll = () => {
        scrollFrame = 0;
        if (!active) return;
        let moved = false;
        const horizontal = scroller.current;
        if (horizontal) {
          const rect = horizontal.getBoundingClientRect();
          const dx = axisSpeed(lastX, rect.left, rect.right);
          if (dx !== 0) {
            const before = horizontal.scrollLeft;
            horizontal.scrollLeft = before + dx;
            moved ||= horizontal.scrollLeft !== before;
          }
        }
        const vertical = verticalScroller();
        if (vertical) {
          const rect = vertical.getBoundingClientRect();
          const dy = axisSpeed(lastY, rect.top, rect.bottom);
          if (dy !== 0) {
            const before = vertical.scrollTop;
            vertical.scrollTop = before + dy;
            moved ||= vertical.scrollTop !== before;
          }
        }
        if (moved) updateTarget();
        if (moved || nearEdge()) scheduleScroll();
      };

      const nearEdge = (): boolean => {
        const horizontal = scroller.current;
        if (horizontal) {
          const rect = horizontal.getBoundingClientRect();
          if (axisSpeed(lastX, rect.left, rect.right) !== 0) return true;
        }
        const vertical = verticalScroller();
        if (vertical) {
          const rect = vertical.getBoundingClientRect();
          if (axisSpeed(lastY, rect.top, rect.bottom) !== 0) return true;
        }
        return false;
      };

      const scheduleScroll = () => {
        if (scrollFrame || typeof requestAnimationFrame !== "function") return;
        scrollFrame = requestAnimationFrame(autoScroll);
      };

      const activate = () => {
        active = true;
        restoreSelection = suppressTextSelection();
        setGrabbing(true);
        root.classList.add(BOARD_DRAGGING_CLASS);
        createPreview();
        source.dataset.boardDragging = "true";
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* window listeners still track the gesture */
        }
        updateTarget();
      };

      const removeListeners = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("blur", onCancel);
      };

      const finish = (commit: boolean) => {
        removeListeners();
        clearTimeout(lostPointerUpTimer);
        if (scrollFrame && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(scrollFrame);
        }
        scrollFrame = 0;
        cleanupRef.current = null;
        try {
          if (handle.hasPointerCapture?.(pointerId)) {
            handle.releasePointerCapture(pointerId);
          }
        } catch {
          /* already released */
        }
        if (!active) return;
        active = false;
        suppressClickUntil.current = performance.now() + CLICK_SUPPRESS_MS;
        const target = commit ? current : null;
        delete source.dataset.boardDragging;
        delete root.dataset.boardDrop;
        root.classList.remove(BOARD_DRAGGING_CLASS);
        restoreSelection?.();
        restoreSelection = undefined;
        setGrabbing(false);
        // The card re-renders in its new column first; dropping the preview a
        // frame later avoids a flash of the card back in its old spot.
        const leaving = preview;
        preview = null;
        if (leaving) {
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => leaving.remove());
          } else {
            leaving.remove();
          }
        }
        current = null;
        setDrag(null);
        if (target?.overColumnId && target.verdict?.kind === "ok") {
          onDropRef.current(cardKey, target.overColumnId);
        }
      };

      function onMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) return;
        // The button is already up but its pointerup never reached us: drop
        // the drag rather than leave the card stuck to the cursor. WebKit can
        // report no buttons on moves queued ahead of a quick pointerup, so
        // give that pointerup a moment first.
        if (moveEvent.pointerType === "mouse" && moveEvent.buttons === 0) {
          if (!lostPointerUpTimer) {
            lostPointerUpTimer = setTimeout(
              () => finish(false),
              BOARD_LOST_POINTERUP_MS,
            );
          }
        } else {
          clearTimeout(lostPointerUpTimer);
          lostPointerUpTimer = undefined;
        }
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        if (!active) {
          if (
            Math.hypot(lastX - startX, lastY - startY) < BOARD_DRAG_THRESHOLD
          ) {
            return;
          }
          activate();
        }
        moveEvent.preventDefault();
        movePreview();
        updateTarget();
        if (nearEdge()) scheduleScroll();
      }

      function onUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) return;
        if (active) {
          lastX = upEvent.clientX;
          lastY = upEvent.clientY;
          updateTarget();
        }
        finish(true);
      }

      function onCancel() {
        finish(false);
      }

      function onKey(keyEvent: KeyboardEvent) {
        if (keyEvent.key !== "Escape") return;
        if (active) keyEvent.preventDefault();
        finish(false);
      }

      cleanupRef.current = onCancel;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onCancel);
    },
    [scroller],
  );

  useEffect(() => {
    if (!enabled) cleanupRef.current?.();
  }, [enabled]);

  useEffect(() => () => cleanupRef.current?.(), []);

  return { drag, onCardPointerDown, consumeClick, cancel };
}
