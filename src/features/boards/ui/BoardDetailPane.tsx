import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useDragResize } from "../../../shared/hooks/useDragResize";
import { formatInteger } from "../../../shared/lib/numbers";
import {
  ExternalLink,
  GitPullRequest,
  LoaderCircle,
  MessageSquare,
  Paperclip,
  RefreshCw,
  X,
} from "../../../shared/ui/icons";
import { RollText } from "../../../shared/ui/RollText";
import { SafeHtml } from "../../../shared/ui/SafeHtml";
import { InboxMiniLabel } from "../../inbox/ui/InboxMiniCard";
import {
  azurePerson,
  azureStateMeta,
  type AzureRelatedItem,
  type AzureWorkItemDetail,
} from "../model/azureBoards";
import { dropVerdict } from "../model/boardColumns";
import {
  formatDetailDate,
  loadBoardDetail,
  peekBoardDetail,
  peekStaleBoardDetail,
  relatedStateCategory,
  shortPath,
} from "../model/boardDetail";
import { describeOwner } from "../model/boardOwners";
import { boardErrorMessage } from "../model/boardSnapshot";
import {
  BOARD_PROVIDER_LABELS,
  type BoardCard,
  type BoardPerson,
  type BoardSnapshot,
  type BoardStateCategory,
} from "../model/boardTypes";
import { PersonAvatar } from "./BoardCard";
import { WorkItemTypeGlyph } from "./boardGlyphs";

const MIN_WIDTH = 360;
const MAX_WIDTH = 760;
const DEFAULT_WIDTH = 480;
const WIDTH_KEY = "monocode.boards.detailWidth";

const ICON_BUTTON =
  "grid size-6 shrink-0 place-items-center rounded-md text-content/45 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-content/45";

/** Fallback state colors by category, for types the board never loaded. */
const CATEGORY_COLORS: Record<BoardStateCategory, string> = {
  triage: "#8a8a8a",
  backlog: "#8a8a8a",
  todo: "#b2b2b2",
  inProgress: "#007acc",
  resolved: "#ff9d00",
  done: "#339933",
  canceled: "#8a8a8a",
  unknown: "#8a8a8a",
};

function rememberedWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function rememberWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Private mode or a full store: the width just does not persist.
  }
}

type DetailState = {
  detail: AzureWorkItemDetail | null;
  loading: boolean;
  error: string | null;
};

/**
 * The detail for one card: cached and fresh shows as is, stale shows while
 * it refreshes, and a move (which bumps the card's rev) refetches.
 */
function useBoardDetail(project: string, id: number, rev: number | undefined) {
  const [state, setState] = useState<DetailState>(() => ({
    detail: peekBoardDetail(project, id) ?? peekStaleBoardDetail(project, id),
    loading: false,
    error: null,
  }));
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(() => {
    let cancelled = false;
    const fresh = peekBoardDetail(project, id);
    const stale = fresh ?? peekStaleBoardDetail(project, id);
    setState({ detail: stale, loading: !fresh || reloads > 0, error: null });
    if (fresh && reloads === 0) return;
    loadBoardDetail(project, id, { force: reloads > 0 }).then(
      (detail) => {
        if (!cancelled) setState({ detail, loading: false, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState((current) => ({
            detail: current.detail,
            loading: false,
            error: boardErrorMessage(error),
          }));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [project, id, rev, reloads]);

  return { ...state, refresh };
}

export function BoardDetailPane({
  card,
  snapshot,
  pending,
  canStart,
  onClose,
  onMove,
  onStart,
}: {
  card: BoardCard;
  snapshot: BoardSnapshot;
  /** The card is still moving. */
  pending: boolean;
  canStart: boolean;
  onClose: () => void;
  onMove: (columnId: string) => void;
  onStart: () => void;
}) {
  const project = snapshot.azure?.project ?? card.project;
  const { detail, loading, error, refresh } = useBoardDetail(
    project,
    card.number,
    card.rev,
  );
  const resize = useDragResize({
    direction: "left",
    min: MIN_WIDTH,
    max: () => Math.min(MAX_WIDTH, Math.round(window.innerWidth * 0.5)),
    defaultWidth: DEFAULT_WIDTH,
    initial: rememberedWidth(),
    onCommit: rememberWidth,
  });
  const providerLabel = BOARD_PROVIDER_LABELS[card.provider];
  const title = detail?.title ?? card.title;
  const state = detail?.state ?? card.state;
  const stateMeta = azureStateMeta(
    snapshot.azure?.stateInfo ?? {},
    card.type,
    state,
  );
  const stateColor =
    stateMeta?.color ?? card.stateColor ?? CATEGORY_COLORS[card.stateCategory];
  const owners = card.owners;
  const ownerPeople = owners ? [owners.primary, ...owners.others] : [];
  const assigned = azurePerson(detail?.assignedTo) ?? card.assignee;
  const tags = detail?.tags ?? card.tags.map((tag) => tag.name);
  const columns = snapshot.columns;
  const currentColumn = columns.find((column) => column.id === card.columnId);

  return (
    <aside
      ref={resize.setPaneRef}
      data-board-detail
      aria-label={`${card.ref} details`}
      className="relative flex h-full min-h-0 shrink-0 flex-col border-l border-stroke bg-background-base"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details"
        className={`absolute inset-y-0 -left-px z-10 w-1.5 cursor-col-resize touch-none ${
          resize.dragging ? "bg-content/15" : "hover:bg-content/10"
        }`}
        onPointerDown={resize.onPointerDown}
        onDoubleClick={resize.onDoubleClick}
      />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-stroke px-3 text-[12px] text-content/50">
        <WorkItemTypeGlyph type={card.type} />
        <span className="shrink-0 uppercase tracking-wide text-[10.5px]">
          {card.type ?? "Work item"}
        </span>
        <span className="shrink-0 tabular-nums">{card.ref}</span>
        {pending ? (
          <LoaderCircle
            aria-hidden
            className="size-3 animate-spin text-content/50"
            strokeWidth={1.75}
          />
        ) : null}
        <span className="min-w-0 flex-1" />
        <button
          type="button"
          title="Refresh details"
          aria-label="Refresh details"
          onClick={refresh}
          disabled={loading}
          className={ICON_BUTTON}
        >
          {loading ? (
            <LoaderCircle className="size-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          title={`Open in ${providerLabel}`}
          aria-label={`Open in ${providerLabel}`}
          disabled={!card.url}
          onClick={() => void openUrl(detail?.url || card.url).catch(() => {})}
          className={ICON_BUTTON}
        >
          <ExternalLink className="size-3.5" strokeWidth={1.75} />
        </button>
        <button
          type="button"
          title="Close details"
          aria-label="Close details"
          onClick={onClose}
          className={ICON_BUTTON}
        >
          <X className="size-3.5" strokeWidth={2} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="flex flex-col gap-4 px-4 py-3">
          <h2 className="text-[14px] font-medium leading-snug text-content">
            {title || "Untitled"}
          </h2>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-content/60">
            {owners?.source === "children" ? (
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-content/45">With</span>
                <span className="flex shrink-0 items-center -space-x-1">
                  {ownerPeople.map((person, index) => (
                    <PersonAvatar
                      key={`${person.id ?? person.name}-${index}`}
                      person={person}
                      strong={index === 0}
                      title={describeOwner(person, card.children)}
                    />
                  ))}
                </span>
                <span className="min-w-0 truncate text-content">
                  {ownerPeople.map((person) => person.name).join(", ")}
                </span>
              </span>
            ) : null}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-content/45">Assigned to</span>
              {assigned ? (
                <>
                  <PersonAvatar person={assigned} />
                  <span className="min-w-0 truncate text-content">
                    {assigned.name}
                  </span>
                </>
              ) : (
                <span className="text-content/45">Unassigned</span>
              )}
            </span>
            <span
              className="flex shrink-0 items-center gap-1 tabular-nums"
              title="Comments"
            >
              <MessageSquare className="size-3.5" strokeWidth={1.75} />
              {detail ? (
                <RollText
                  text={`${formatInteger(detail.commentCount)} ${
                    detail.commentCount === 1 ? "comment" : "comments"
                  }`}
                />
              ) : (
                <span className="text-content/40">…</span>
              )}
            </span>
          </div>

          {tags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              {tags.map((tag) => (
                <InboxMiniLabel key={tag} label={{ name: tag, color: "" }} />
              ))}
            </div>
          ) : null}

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
            <dt className="text-content/45">State</dt>
            <dd className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: stateColor }}
              />
              <RollText text={state} className="min-w-0 truncate text-content" />
              {columns.length > 0 ? (
                <select
                  aria-label="Move to column"
                  value={card.columnId}
                  disabled={pending}
                  onChange={(event) => onMove(event.target.value)}
                  className="ml-auto h-6 max-w-[55%] shrink rounded-md border border-stroke bg-background-base px-1.5 text-[11px] text-content/70 outline-none hover:text-content focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
                >
                  {!currentColumn ? (
                    <option value={card.columnId}>Other</option>
                  ) : null}
                  {columns.map((column) => {
                    const verdict = dropVerdict(snapshot, card, column, pending);
                    const label = column.subtitle
                      ? `${column.title} · ${column.subtitle}`
                      : column.title;
                    return (
                      <option
                        key={column.id}
                        value={column.id}
                        disabled={
                          column.id !== card.columnId && verdict.kind !== "ok"
                        }
                        title={
                          verdict.kind === "disallowed" ? verdict.reason : undefined
                        }
                      >
                        {label}
                      </option>
                    );
                  })}
                </select>
              ) : null}
            </dd>
            <dt className="text-content/45">Reason</dt>
            <dd className="min-w-0 truncate text-content/70">
              {detail ? detail.reason || "—" : "…"}
            </dd>
            <dt className="text-content/45">Area</dt>
            <dd
              className="min-w-0 truncate text-content/70"
              title={detail?.areaPath ?? card.area}
            >
              {shortPath(detail?.areaPath ?? card.area ?? "") || "—"}
            </dd>
            <dt className="text-content/45">Iteration</dt>
            <dd
              className="min-w-0 truncate text-content/70"
              title={detail?.iterationPath ?? card.iteration}
            >
              {shortPath(detail?.iterationPath ?? card.iteration ?? "") || "—"}
            </dd>
          </dl>

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md bg-red-500/8 px-3 py-2 text-[12px] text-red-400"
            >
              <span className="min-w-0 flex-1 break-words">
                Couldn't load details: {error}
              </span>
              <button
                type="button"
                onClick={refresh}
                className="shrink-0 rounded px-1.5 py-0.5 text-red-300 hover:bg-red-500/15"
              >
                Retry
              </button>
            </div>
          ) : null}

          {detail ? (
            <DetailBody
              detail={detail}
              card={card}
              snapshot={snapshot}
              canStart={canStart}
              onStart={onStart}
            />
          ) : !error ? (
            <DetailSkeleton />
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 border-b border-stroke pb-1 text-[12px] font-semibold text-content">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

function DetailBody({
  detail,
  card,
  snapshot,
  canStart,
  onStart,
}: {
  detail: AzureWorkItemDetail;
  card: BoardCard;
  snapshot: BoardSnapshot;
  canStart: boolean;
  onStart: () => void;
}) {
  const createdBy = azurePerson(detail.createdBy);
  const changedBy = azurePerson(detail.changedBy);
  const relations = detail.relations;
  const childCategories = useMemo(
    () =>
      new Map((card.children ?? []).map((child) => [child.id, child.stateCategory])),
    [card.children],
  );
  const categoryOf = (item: AzureRelatedItem): BoardStateCategory =>
    childCategories.get(item.id) ??
    relatedStateCategory(item, snapshot.azure?.stateInfo);
  const links = relations.pullRequests + relations.commits;
  return (
    <>
      <Section title="Description">
        <SafeHtml html={detail.descriptionHtml} emptyLabel="No description" />
      </Section>

      {detail.sections.map((section) => (
        <Section key={section.referenceName} title={section.label}>
          <SafeHtml html={section.html} />
        </Section>
      ))}

      <Section title="Planning">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[12px]">
          <dt className="text-content/45">Created by</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-content/70">
            {createdBy ? (
              <>
                <PersonAvatar person={createdBy} className="size-4 text-[8px]" />
                <span className="min-w-0 truncate">{createdBy.name}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
          <dt className="text-content/45">Created</dt>
          <dd className="text-content/70">
            {formatDetailDate(detail.createdDate) || "—"}
          </dd>
          {detail.planning.map((field) => (
            <PlanningRow
              key={field.referenceName}
              label={field.label}
              value={field.kind === "date" ? formatDetailDate(field.value) : field.value}
              numeric={field.kind === "number"}
            />
          ))}
        </dl>
      </Section>

      <Section
        title="Related work"
        aside={
          links > 0 || relations.attachments.length > 0 ? (
            <span className="flex shrink-0 items-center gap-2 text-[11px] font-normal text-content/45">
              {relations.pullRequests > 0 ? (
                <span
                  className="flex items-center gap-1 tabular-nums"
                  title="Pull requests linked"
                >
                  <GitPullRequest className="size-3" strokeWidth={1.75} />
                  {relations.pullRequests}
                </span>
              ) : null}
              {relations.commits > 0 ? (
                <span className="tabular-nums" title="Commits linked">
                  {relations.commits} {relations.commits === 1 ? "commit" : "commits"}
                </span>
              ) : null}
              {relations.attachments.length > 0 ? (
                <span
                  className="flex items-center gap-1 tabular-nums"
                  title={relations.attachments.join("\n")}
                >
                  <Paperclip className="size-3" strokeWidth={1.75} />
                  {relations.attachments.length}
                </span>
              ) : null}
            </span>
          ) : undefined
        }
      >
        {relations.parent ? (
          <RelatedGroup label="Parent">
            <RelatedRow item={relations.parent} category={categoryOf(relations.parent)} />
          </RelatedGroup>
        ) : null}
        {relations.children.length > 0 ? (
          <RelatedGroup label={relations.children.length === 1 ? "Child" : "Children"}>
            {relations.children.map((item) => (
              <RelatedRow key={item.id} item={item} category={categoryOf(item)} />
            ))}
          </RelatedGroup>
        ) : null}
        {relations.related.length > 0 ? (
          <RelatedGroup label="Related">
            {relations.related.map((item) => (
              <RelatedRow
                key={`${item.link}-${item.id}`}
                item={item}
                category={categoryOf(item)}
                showLink
              />
            ))}
          </RelatedGroup>
        ) : null}
        {!relations.parent &&
        relations.children.length === 0 &&
        relations.related.length === 0 ? (
          <p className="text-[12px] text-content/45">No linked work items</p>
        ) : null}
        {relations.truncated ? (
          <p className="text-[11px] text-content/40">
            Some linked items are not shown. Open in Azure DevOps for the full list.
          </p>
        ) : null}
      </Section>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-stroke pt-2 text-[11px] text-content/45">
        <span className="min-w-0 truncate">
          Updated{changedBy ? ` by ${changedBy.name}` : ""}
          {detail.changedDate ? ` · ${formatDetailDate(detail.changedDate)}` : ""}
        </span>
        <span className="flex-1" />
        {canStart ? (
          <button
            type="button"
            onClick={onStart}
            className="shrink-0 rounded-md border border-stroke px-2 py-0.5 text-[11px] text-content/70 hover:bg-content/8 hover:text-content"
          >
            Start chat
          </button>
        ) : null}
      </footer>
    </>
  );
}

function PlanningRow({
  label,
  value,
  numeric,
}: {
  label: string;
  value: string;
  numeric: boolean;
}) {
  return (
    <>
      <dt className="min-w-0 truncate text-content/45" title={label}>
        {label}
      </dt>
      <dd
        className={`min-w-0 break-words text-content/70 ${numeric ? "tabular-nums" : ""}`}
      >
        {value}
      </dd>
    </>
  );
}

function RelatedGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-content/45">{label}</span>
      <ul role="list" className="flex flex-col gap-1">
        {children}
      </ul>
    </div>
  );
}

function RelatedRow({
  item,
  category,
  showLink = false,
}: {
  item: AzureRelatedItem;
  category: BoardStateCategory;
  showLink?: boolean;
}) {
  const person: BoardPerson | undefined = azurePerson(item.assignedTo);
  return (
    <li className="flex min-w-0 items-start gap-2 rounded-md border border-content/8 px-2 py-1.5 text-[12px]">
      <WorkItemTypeGlyph type={item.workItemType} className="mt-0.5 size-3.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 tabular-nums text-content/45">#{item.id}</span>
          <button
            type="button"
            onClick={() => void openUrl(item.url).catch(() => {})}
            disabled={!item.url}
            title={item.url ? `Open #${item.id} in Azure DevOps` : undefined}
            className="min-w-0 truncate text-left text-content hover:text-accent hover:underline disabled:no-underline"
          >
            {item.title || "Untitled"}
          </button>
          {showLink && item.link ? (
            <span className="shrink-0 rounded bg-content/8 px-1 text-[10px] text-content/50">
              {item.link}
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-content/50">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: CATEGORY_COLORS[category] }}
          />
          <span className="min-w-0 truncate">{item.state || "—"}</span>
          {item.changedDate ? (
            <span className="shrink-0 text-content/40">
              · {formatDetailDate(item.changedDate, { time: false })}
            </span>
          ) : null}
        </span>
      </span>
      {person ? (
        <PersonAvatar
          person={person}
          title={person.name}
          className="size-5 text-[9px]"
        />
      ) : null}
    </li>
  );
}

function DetailSkeleton() {
  return (
    <div aria-hidden data-board-detail-skeleton className="flex flex-col gap-3">
      {[64, 40, 88, 52].map((height, index) => (
        <div
          key={index}
          style={{ height }}
          className="animate-pulse rounded-md bg-content/6 motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}
