import { openUrl } from "@tauri-apps/plugin-opener";
import { createPortal } from "react-dom";
import { LAYER } from "../../../shared/lib/layers";
import { CircleAlert, LoaderCircle, X } from "../../../shared/ui/icons";
import type { PickupToast, UsePickupTask } from "../hooks/usePickupTask";
import { WorkItemTypeGlyph } from "./boardGlyphs";

const TEXT_BUTTON =
  "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-content/70 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function message(toast: PickupToast): string {
  switch (toast.kind) {
    case "created":
      return `Created ${toast.child.type || "Task"} #${toast.child.id} "${toast.child.title}" for ${toast.cardRef}`;
    case "exists":
      return `You already have ${toast.child.type || "Task"} #${toast.child.id} on ${toast.cardRef}`;
    case "undone":
      return `${toast.child.type || "Task"} #${toast.child.id} removed`;
    case "error":
      return `Couldn't create a task for ${toast.cardRef}: ${toast.message}`;
  }
}

/**
 * What picking up an item did, at the top right like the other toasts. A
 * created Task can be undone while its toast shows; a failure stays until it
 * is dismissed or retried.
 */
export function BoardToasts({
  toasts,
  onDismiss,
  onUndo,
  onRetry,
}: {
  toasts: readonly PickupToast[];
  onDismiss: UsePickupTask["dismiss"];
  onUndo: UsePickupTask["undo"];
  onRetry: UsePickupTask["retry"];
}) {
  if (toasts.length === 0) return null;
  return createPortal(
    <div
      aria-live="polite"
      style={{ zIndex: LAYER.toast }}
      className="pointer-events-none fixed right-3 top-12 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <article
          key={toast.id}
          data-board-toast={toast.kind}
          className="pointer-events-auto flex flex-col gap-1.5 rounded-xl border border-stroke bg-background-base px-3 py-2.5 text-[12px] shadow-xl"
        >
          <div className="flex items-start gap-2">
            {toast.kind === "error" ? (
              <CircleAlert
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-red-400"
                strokeWidth={1.75}
              />
            ) : (
              <WorkItemTypeGlyph
                type={toast.child.type || "Task"}
                className="mt-0.5 size-3.5"
              />
            )}
            <p className="min-w-0 flex-1 break-words leading-snug text-content/85">
              {message(toast)}
            </p>
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => onDismiss(toast.id)}
              className="-mr-1 -mt-0.5 grid size-5 shrink-0 place-items-center rounded text-content/45 hover:bg-content/10 hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X className="size-3" strokeWidth={2} />
            </button>
          </div>
          {toast.kind === "created" && toast.undoError ? (
            <p role="alert" className="pl-5 text-[11px] text-red-400">
              Couldn't remove it: {toast.undoError}
            </p>
          ) : null}
          {toast.kind === "undone" ? null : (
            <div className="flex items-center justify-end gap-1 pl-5">
              {toast.kind === "created" && toast.undoing ? (
                <LoaderCircle
                  aria-hidden
                  className="size-3 animate-spin text-content/50"
                  strokeWidth={1.75}
                />
              ) : null}
              {toast.kind === "created" || toast.kind === "exists" ? (
                <button
                  type="button"
                  disabled={!toast.child.url}
                  onClick={() => void openUrl(toast.child.url).catch(() => {})}
                  className={TEXT_BUTTON}
                >
                  Open
                </button>
              ) : null}
              {toast.kind === "created" ? (
                <button
                  type="button"
                  disabled={toast.undoing}
                  onClick={() => onUndo(toast.id)}
                  className={TEXT_BUTTON}
                >
                  Undo
                </button>
              ) : null}
              {toast.kind === "error" ? (
                <button
                  type="button"
                  onClick={() => onRetry(toast.id)}
                  className={TEXT_BUTTON}
                >
                  Retry
                </button>
              ) : null}
            </div>
          )}
        </article>
      ))}
    </div>,
    document.body,
  );
}
