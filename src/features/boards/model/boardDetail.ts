import {
  azureAttachmentPreview,
  azureWorkItemDetail,
  type AzureRelatedItem,
  type AzureWorkItemDetail,
} from "./azureBoards";
import { azureStateCategory, ownValue } from "./boardTypes";
import type { AzureStateInfo, BoardStateCategory } from "./boardTypes";

/** A detail this young is shown without refetching. */
export const BOARD_DETAIL_FRESH_MS = 2 * 60_000;

type Entry = { value: AzureWorkItemDetail; at: number };

let generation = 0;
const details = new Map<string, Entry>();
const inflight = new Map<string, Promise<AzureWorkItemDetail>>();

function keyOf(project: string, id: number): string {
  return `${project.trim()}\u0000${id}`;
}

/** Inlined images kept at once; a long item must not pin every picture. */
export const ATTACHMENT_CACHE_MAX = 40;

const attachmentImages = new Map<string, Promise<string>>();

export function clearBoardDetailCache() {
  generation += 1;
  details.clear();
  inflight.clear();
  attachmentImages.clear();
}

/** Drops one item so its next open refetches, such as after a move. */
export function invalidateBoardDetail(project: string, id: number) {
  const key = keyOf(project, id);
  details.delete(key);
  inflight.delete(key);
}

export function peekBoardDetail(
  project: string,
  id: number,
  now = Date.now(),
): AzureWorkItemDetail | null {
  const hit = details.get(keyOf(project, id));
  return hit && now - hit.at < BOARD_DETAIL_FRESH_MS ? hit.value : null;
}

/** Stale cached value, for showing while a refresh runs. */
export function peekStaleBoardDetail(
  project: string,
  id: number,
): AzureWorkItemDetail | null {
  return details.get(keyOf(project, id))?.value ?? null;
}

/**
 * The work item detail, cached per project and id with one shared request;
 * a cache clear drops late answers.
 */
export function loadBoardDetail(
  project: string,
  id: number,
  options?: { force?: boolean },
): Promise<AzureWorkItemDetail> {
  const key = keyOf(project, id);
  if (!options?.force) {
    const cached = peekBoardDetail(project, id);
    if (cached) return Promise.resolve(cached);
    const running = inflight.get(key);
    if (running) return running;
  }
  const started = generation;
  const pending = azureWorkItemDetail(project, id)
    .then((detail) => {
      if (started === generation && inflight.get(key) === pending) {
        details.set(key, { value: detail, at: Date.now() });
      }
      return detail;
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

/**
 * An attachment image as a `data:` URL, loaded once per URL and shared by
 * everyone asking, so a thumbnail and the lightbox cost one download. The
 * oldest entries are dropped past `ATTACHMENT_CACHE_MAX`; a failure is not
 * kept, so the next ask tries again. `name` saves the download for files that
 * are not images.
 */
export function loadAttachmentDataUrl(
  url: string,
  name?: string,
): Promise<string> {
  const hit = attachmentImages.get(url);
  if (hit) {
    // Re-insert so what is on screen is the last to go.
    attachmentImages.delete(url);
    attachmentImages.set(url, hit);
    return hit;
  }
  const pending = azureAttachmentPreview(url, name).then(
    ({ mimeType, dataBase64 }) => `data:${mimeType};base64,${dataBase64}`,
  );
  attachmentImages.set(url, pending);
  pending.catch(() => {
    if (attachmentImages.get(url) === pending) attachmentImages.delete(url);
  });
  while (attachmentImages.size > ATTACHMENT_CACHE_MAX) {
    const oldest = attachmentImages.keys().next();
    if (oldest.done) break;
    attachmentImages.delete(oldest.value);
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Pure helpers for the detail pane
// ---------------------------------------------------------------------------

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/**
 * Whether the pane may show the attachment as a picture. Mirrors the
 * backend's list: SVG is a file, never inlined, since it can carry script.
 */
export function isImageAttachment(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).trim().toLowerCase());
}

/**
 * `https://dev.azure.com/org` from a work item's web URL
 * (`.../org/Project/_workitems/edit/1`): the part before the project.
 */
export function azureOrgBase(workItemUrl: string): string | null {
  const at = workItemUrl.indexOf("/_workitems");
  if (at < 0) return null;
  const project = workItemUrl.slice(0, at).replace(/\/+$/, "");
  const cut = project.lastIndexOf("/");
  const base = cut > "https://".length ? project.slice(0, cut) : null;
  return base && /^https?:\/\/[^/]+(\/|$)/i.test(`${base}/`) ? base : null;
}

/** An image in the work item's own organization that the backend can fetch. */
export function isOrgAttachmentUrl(src: string, orgBase: string | null): boolean {
  if (!orgBase || !src.includes("/_apis/wit/attachments/")) return false;
  return src.toLowerCase().startsWith(`${orgBase.toLowerCase()}/`);
}

const SIZE_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

/** `514 KB`, `31.5 MB`: binary steps, whole KB, one decimal from MB up. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${Math.round(size)} B`;
  const kilobytes = Math.round(size / 1024);
  if (kilobytes < 1024) return `${kilobytes} KB`;
  const megabytes = size / 1024 ** 2;
  if (megabytes < 1024) return `${SIZE_FORMATTER.format(megabytes)} MB`;
  return `${SIZE_FORMATTER.format(megabytes / 1024)} GB`;
}

/** Category of a related item's state: the board's types first, else by name. */
export function relatedStateCategory(
  item: Pick<AzureRelatedItem, "workItemType" | "state">,
  info: AzureStateInfo | undefined,
  childTypes?: ReadonlyMap<string, ReadonlyMap<string, string>>,
): BoardStateCategory {
  const known = ownValue(ownValue(info, item.workItemType), item.state);
  if (known) return known.category;
  const category = childTypes?.get(item.workItemType)?.get(item.state);
  if (category) return azureStateCategory(category);
  return guessStateCategory(item.state);
}

/** Common process state names, for types the board never loaded. */
export function guessStateCategory(state: string): BoardStateCategory {
  switch (state.trim().toLowerCase()) {
    case "new":
    case "to do":
    case "defined":
    case "proposed":
    case "approved":
    case "requested":
      return "todo";
    case "active":
    case "in progress":
    case "doing":
    case "committed":
    case "open":
    case "em desenvolvimento":
    case "em andamento":
      return "inProgress";
    case "resolved":
    case "ready for test":
    case "accepted":
      return "resolved";
    case "closed":
    case "done":
    case "completed":
    case "inactive":
      return "done";
    case "removed":
    case "cut":
    case "abandoned":
      return "canceled";
    default:
      return "unknown";
  }
}

/** `14 Oct 2026, 13:27` in the user's locale; the raw text when unparsable. */
export function formatDetailDate(
  value: string,
  options?: { time?: boolean },
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(options?.time === false
      ? {}
      : { hour: "2-digit", minute: "2-digit" }),
  });
}

/** Last two segments of a path: `2026_R4 \ S01 - R4_2026`. */
export function shortPath(path: string): string {
  const parts = path.split("\\").filter(Boolean);
  if (parts.length <= 2) return parts.join(" \\ ");
  return parts.slice(-2).join(" \\ ");
}
