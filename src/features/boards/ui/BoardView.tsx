import { openUrl } from "@tauri-apps/plugin-opener";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { OverlayNav } from "../../../app/shell/TitleBar";
import { WindowControls } from "../../../app/shell/WindowControls";
import { IS_MAC } from "../../../platform/tauri/platform";
import { copyText } from "../../../platform/tauri/clipboard";
import { Kanban, X } from "../../../shared/ui/icons";
import { ExplorerMenu } from "../../files/ui/ExplorerMenu";
import type { InboxItem } from "../../inbox/model/githubTasks";
import type { ConnectableInboxSource } from "../../inbox/model/inboxFilters";
import { useBoardConfigs } from "../hooks/useBoardConfigs";
import {
  useBoardConnections,
  type BoardConnections,
} from "../hooks/useBoardConnections";
import { useBoardDrag } from "../hooks/useBoardDrag";
import { useBoardSnapshot } from "../hooks/useBoardSnapshot";
import {
  adjacentMoveTarget,
  columnLoad,
  dropVerdict,
  type DropVerdict,
} from "../model/boardColumns";
import { newBoardConfig } from "../model/boardConfigs";
import { boardCardToInboxItem } from "../model/boardInbox";
import type {
  BoardCard as BoardCardData,
  BoardColumn as BoardColumnData,
  BoardConfig,
  BoardProvider,
} from "../model/boardTypes";
import { focusNeighbor, type BoardFocusDirection } from "../model/boardView";
import type { BoardCardHandlers } from "./BoardCard";
import {
  boardCardCopyId,
  boardCardMenuAction,
  boardCardMenuItems,
} from "./boardCardMenu";
import { BoardColumn } from "./BoardColumn";
import { BoardColumns } from "./BoardColumns";
import { BoardConfigDialog } from "./BoardConfigDialog";
import { BoardDeleteDialog } from "./BoardDeleteDialog";
import { BoardDetailPane } from "./BoardDetailPane";
import {
  BoardEmpty,
  BoardError,
  BoardNotConnected,
  BoardNotice,
  BoardSkeleton,
} from "./BoardStates";
import { BoardTabs, boardPanelId, boardTabId } from "./BoardTabs";
import { BoardToolbar } from "./BoardToolbar";

type Props = {
  besideRail?: boolean;
  compactRail?: boolean;
  onClose: () => void;
  onToggleSidebar?: () => void;
  onOpenIntegrations: (source: ConnectableInboxSource) => void;
  onStart?: (item: InboxItem) => void | Promise<unknown>;
};

type DialogState = {
  config: BoardConfig;
  isNew: boolean;
  importUrl?: string;
};

/** What the Escape handler needs from the board body, kept current by it. */
type EscapeControl = {
  dragging: boolean;
  cancelDrag: () => void;
  menuOpen: boolean;
  detailOpen: boolean;
  closeDetail: () => void;
  search: string;
  clearSearch: () => void;
};

const IDLE_CONTROL: EscapeControl = {
  dragging: false,
  cancelDrag: () => {},
  menuOpen: false,
  detailOpen: false,
  closeDetail: () => {},
  search: "",
  clearSearch: () => {},
};

/** An open dialog or popover anywhere takes Escape before Boards does. */
function overlayInDocument(): boolean {
  return !!document.querySelector('[aria-modal="true"], [data-popover-side]');
}

export function BoardView({
  besideRail = false,
  compactRail = false,
  onClose,
  onToggleSidebar,
  onOpenIntegrations,
  onStart,
}: Props) {
  const boards = useBoardConfigs();
  const connections = useBoardConnections();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [deleting, setDeleting] = useState<BoardConfig | null>(null);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const control = useRef<EscapeControl>({ ...IDLE_CONTROL });
  const overlayRef = useRef(false);
  overlayRef.current = dialog !== null || deleting !== null || tabsMenuOpen;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Registered once; reads everything through refs. Order: a running drag,
  // then any open dialog or menu (left to Modal or Popover), then a handled
  // event, then the details pane, then the card filter, then leaving Boards.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const current = control.current;
      if (current.dragging) {
        event.preventDefault();
        event.stopPropagation();
        current.cancelDrag();
        return;
      }
      if (overlayRef.current || current.menuOpen || overlayInDocument()) {
        return;
      }
      if (event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (current.detailOpen) {
        current.closeDetail();
        return;
      }
      if (current.search) {
        current.clearSearch();
        return;
      }
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const announce = useCallback((message: string) => {
    // Alternating a trailing zero-width space makes a repeated message
    // (moving two cards to the same column) announce again.
    setAnnouncement((previous) =>
      previous === message ? `${message}​` : message,
    );
  }, []);

  const openNew = useCallback((provider: BoardProvider, importUrl?: string) => {
    setDialog({
      config: newBoardConfig(provider),
      isNew: true,
      ...(importUrl ? { importUrl } : {}),
    });
  }, []);
  const openEdit = useCallback((config: BoardConfig) => {
    setDialog({ config, isNew: false });
  }, []);
  const connect = useCallback(
    (provider: BoardProvider) => onOpenIntegrations(provider),
    [onOpenIntegrations],
  );

  const active = boards.active;

  return (
    <div
      role="region"
      aria-label="Boards"
      data-app-boards
      className="flex min-h-0 min-w-0 flex-1 flex-col text-content"
    >
      <div
        className="flex h-10 shrink-0 select-none items-center border-b border-stroke"
        data-tauri-drag-region="deep"
      >
        {IS_MAC && compactRail ? <div className="w-4 shrink-0" /> : null}
        {IS_MAC && !besideRail ? <div className="w-[78px] shrink-0" /> : null}
        {besideRail ? null : (
          <OverlayNav onBack={onClose} onToggleSidebar={onToggleSidebar} />
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-[13px]">
          <Kanban
            className="size-3.5 shrink-0 text-content/45"
            strokeWidth={1.75}
          />
          <span className="min-w-0 truncate text-content">Boards</span>
        </div>
        {IS_MAC ? null : <WindowControls />}
      </div>
      {boards.configs.length > 0 ? (
        <BoardTabs
          configs={boards.configs}
          activeId={boards.activeId}
          connections={connections}
          onSelect={boards.setActive}
          onEdit={openEdit}
          onDuplicate={(id) => {
            const copy = boards.duplicate(id);
            if (copy) announce(`Created ${copy.name}`);
          }}
          onDelete={setDeleting}
          onNew={(provider) => openNew(provider)}
          onConnect={connect}
          onMenuChange={setTabsMenuOpen}
        />
      ) : null}
      {active ? (
        <BoardBody
          key={active.id}
          config={active}
          connections={connections}
          control={control}
          announce={announce}
          onEdit={openEdit}
          onConnect={connect}
          onStart={onStart}
        />
      ) : (
        <BoardEmpty
          connections={connections}
          onNew={(provider) => openNew(provider)}
          onImport={(url) => openNew("azuredevops", url)}
          onConnect={connect}
        />
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {dialog ? (
        <BoardConfigDialog
          key={dialog.config.id}
          initial={dialog.config}
          isNew={dialog.isNew}
          importUrl={dialog.importUrl}
          connections={connections}
          onOpenIntegrations={connect}
          onSave={(config) => {
            boards.save(config);
            announce(
              dialog.isNew ? `Created ${config.name}` : `Saved ${config.name}`,
            );
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {deleting ? (
        <BoardDeleteDialog
          config={deleting}
          onConfirm={() => {
            boards.remove(deleting.id);
            announce(`Deleted ${deleting.name}`);
            setDeleting(null);
          }}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One board
// ---------------------------------------------------------------------------

type CardMenu = { key: string; x: number; y: number };

const FOCUS_KEYS: Record<string, BoardFocusDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Home: "home",
  End: "end",
};

function columnName(column: BoardColumnData): string {
  return column.subtitle
    ? `${column.title} (${column.subtitle})`
    : column.title;
}

function cardButton(
  root: HTMLElement | null,
  key: string,
): HTMLButtonElement | null {
  if (!root) return null;
  for (const element of root.querySelectorAll<HTMLButtonElement>(
    "button[data-card-key]",
  )) {
    if (element.dataset.cardKey === key) return element;
  }
  return null;
}

function BoardBody({
  config,
  connections,
  control,
  announce,
  onEdit,
  onConnect,
  onStart,
}: {
  config: BoardConfig;
  connections: BoardConnections;
  control: MutableRefObject<EscapeControl>;
  announce: (message: string) => void;
  onEdit: (config: BoardConfig) => void;
  onConnect: (provider: BoardProvider) => void;
  onStart?: (item: InboxItem) => void | Promise<unknown>;
}) {
  const [search, setSearch] = useState("");
  const [mine, setMine] = useState(false);
  const [menu, setMenu] = useState<CardMenu | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** The card open in the details pane. */
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** A card that should get focus back once it lands in its new column. */
  const refocusRef = useRef<string | null>(null);

  const board = useBoardSnapshot(config, {
    paused: dragging || menu !== null,
    search,
    mine,
  });
  const { snapshot, grouped, pending, moveErrors, moveCard, dismissMoveError } =
    board;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const detailKeyRef = useRef(detailKey);
  detailKeyRef.current = detailKey;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const groupedRef = useRef(grouped);
  groupedRef.current = grouped;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const findCard = useCallback(
    (key: string): BoardCardData | undefined =>
      snapshotRef.current?.cards.find((card) => card.key === key),
    [],
  );

  const move = useCallback(
    async (key: string, columnId: string) => {
      const card = findCard(key);
      if (!card) return;
      const outcome = await moveCard(card, columnId);
      const say = announceRef.current;
      switch (outcome.status) {
        case "moved":
          say(`Moved ${card.ref} to ${columnName(outcome.column)}`);
          break;
        case "failed":
          say(`Couldn't move ${card.ref}: ${outcome.error}`);
          break;
        case "rejected":
          say(outcome.reason);
          break;
        case "pending":
          say(`${card.ref} is still moving`);
          break;
        default:
          break;
      }
    },
    [findCard, moveCard],
  );

  const verdict = useCallback(
    (cardKey: string, columnId: string): DropVerdict => {
      const current = snapshotRef.current;
      const card = current?.cards.find((entry) => entry.key === cardKey);
      const column = current?.columns.find((entry) => entry.id === columnId);
      if (!current || !card || !column) {
        return { kind: "disallowed", reason: "That column is gone" };
      }
      return dropVerdict(
        current,
        card,
        column,
        pendingRef.current.has(cardKey),
      );
    },
    [],
  );

  const drag = useBoardDrag({
    scroller: scrollerRef,
    verdict,
    onDrop: (cardKey, columnId) => void move(cardKey, columnId),
    enabled: snapshot !== null && menu === null,
  });
  const dragState = drag.drag;
  useEffect(() => setDragging(dragState !== null), [dragState]);

  const closeDetail = useCallback((refocus = true) => {
    const key = detailKeyRef.current;
    setDetailKey(null);
    if (refocus && key) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        cardButton(rootRef.current, key)?.focus();
      });
    }
  }, []);

  useLayoutEffect(() => {
    control.current = {
      dragging: dragState !== null,
      cancelDrag: drag.cancel,
      menuOpen: menu !== null,
      detailOpen: detailKey !== null,
      closeDetail: () => closeDetail(true),
      search,
      clearSearch: () => setSearch(""),
    };
  });
  useEffect(
    () => () => {
      control.current = { ...IDLE_CONTROL };
    },
    [control],
  );

  const columns = useMemo(() => snapshot?.columns ?? [], [snapshot]);
  const grid = useMemo(
    () =>
      columns.map((column) =>
        (grouped.get(column.id) ?? []).map((card) => card.key),
      ),
    [columns, grouped],
  );
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const loads = useMemo(
    () =>
      new Map(
        columns.map((column) => [
          column.id,
          columnLoad(column, columns, grouped),
        ]),
      ),
    [columns, grouped],
  );

  // The roving tab stop: the last focused card while it is on screen,
  // otherwise the first card on the board.
  const rovingKey = useMemo(() => {
    if (focusKey && grid.some((keys) => keys.includes(focusKey))) {
      return focusKey;
    }
    return grid.find((keys) => keys.length > 0)?.[0] ?? null;
  }, [focusKey, grid]);

  // A card moved from the keyboard remounts in its new column (and again if
  // the move fails); put focus back on it when focus fell to the page.
  useLayoutEffect(() => {
    const key = refocusRef.current;
    if (!key) return;
    const active = document.activeElement;
    if (active && active !== document.body) {
      if (active instanceof HTMLElement && active.dataset.cardKey === key) {
        return;
      }
      if (!rootRef.current?.contains(active)) return;
    }
    cardButton(rootRef.current, key)?.focus();
  }, [grouped]);

  const focusCard = useCallback((key: string) => {
    setFocusKey(key);
    cardButton(rootRef.current, key)?.focus();
  }, []);

  const openCardUrl = useCallback(
    (key: string) => {
      const card = findCard(key);
      if (card?.url) void openUrl(card.url).catch(() => {});
    },
    [findCard],
  );

  const keyboardMove = useCallback(
    (key: string, dir: -1 | 1) => {
      const current = snapshotRef.current;
      const card = findCard(key);
      if (!current || !card) return;
      const target = adjacentMoveTarget(
        current,
        card,
        dir,
        pendingRef.current.has(key),
      );
      if (!target) {
        announceRef.current(
          pendingRef.current.has(key)
            ? `${card.ref} is still moving`
            : `${card.ref} can't move further ${dir < 0 ? "left" : "right"}`,
        );
        return;
      }
      refocusRef.current = key;
      void move(key, target.id);
    },
    [findCard, move],
  );

  const { onCardPointerDown, consumeClick } = drag;
  const handlers = useMemo<BoardCardHandlers>(
    () => ({
      onPointerDown: (key, event) => {
        refocusRef.current = null;
        onCardPointerDown(key, event);
      },
      onClick: (key, event) => {
        if (consumeClick()) return;
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          openCardUrl(key);
          return;
        }
        setFocusKey(key);
        setDetailKey(key);
      },
      onAuxClick: (key, event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        openCardUrl(key);
      },
      onContextMenu: (key, event) => {
        event.preventDefault();
        setFocusKey(key);
        setMenu({ key, x: event.clientX, y: event.clientY });
      },
      onKeyDown: (key, event) => {
        if (
          event.altKey &&
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
        ) {
          // WebView2 treats Alt+Left as "back".
          event.preventDefault();
          keyboardMove(key, event.key === "ArrowLeft" ? -1 : 1);
          return;
        }
        if (
          event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)
        ) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ key, x: rect.left, y: rect.bottom + 2 });
          return;
        }
        if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
          return;
        }
        const direction = FOCUS_KEYS[event.key];
        if (!direction) return;
        event.preventDefault();
        const next = focusNeighbor(gridRef.current, key, direction);
        if (next) {
          refocusRef.current = null;
          focusCard(next);
        }
      },
      onFocus: (key) => {
        if (refocusRef.current && refocusRef.current !== key) {
          refocusRef.current = null;
        }
        setFocusKey(key);
      },
      onDismissError: (key) => dismissMoveError(key),
    }),
    [
      onCardPointerDown,
      consumeClick,
      openCardUrl,
      keyboardMove,
      focusCard,
      dismissMoveError,
    ],
  );

  const menuCard = menu ? findCard(menu.key) : undefined;
  const menuGone = menu !== null && (!menuCard || !snapshot);
  useEffect(() => {
    if (menuGone) setMenu(null);
  }, [menuGone]);
  const detailCard =
    detailKey && snapshot
      ? snapshot.cards.find((card) => card.key === detailKey)
      : undefined;
  const detailGone = detailKey !== null && !detailCard;
  useEffect(() => {
    if (detailGone) setDetailKey(null);
  }, [detailGone]);
  const closeMenu = (refocus: boolean) => {
    const key = menu?.key;
    setMenu(null);
    if (refocus && key) {
      // Only when focus fell to the page: an outside click may have moved it
      // on purpose, or opened another card's menu.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        cardButton(rootRef.current, key)?.focus();
      });
    }
  };

  const onMenuPick = (id: string) => {
    const card = menuCard;
    const action = boardCardMenuAction(id);
    closeMenu(true);
    if (!card || !action) return;
    switch (action.kind) {
      case "details":
        setDetailKey(card.key);
        break;
      case "open":
        openCardUrl(card.key);
        break;
      case "copy-link":
        void copyText(card.url).then(
          () => announce("Link copied"),
          () => announce("Couldn't copy the link"),
        );
        break;
      case "copy-id":
        void copyText(boardCardCopyId(card)).then(
          () => announce(`Copied ${boardCardCopyId(card)}`),
          () => announce("Couldn't copy the ID"),
        );
        break;
      case "start":
        if (onStart) void Promise.resolve(onStart(boardCardToInboxItem(card)));
        break;
      case "move":
        if (action.columnId !== card.columnId) {
          refocusRef.current = card.key;
          void move(card.key, action.columnId);
        }
        break;
    }
  };

  const connected = connections[config.provider];
  const notConnected =
    connected === false || board.errorCode === "not-connected";
  const edit = () => onEdit(config);

  let content;
  if (notConnected) {
    content = (
      <BoardNotConnected provider={config.provider} onConnect={onConnect} />
    );
  } else if (board.errorCode === "incomplete") {
    content = (
      <BoardError
        message={board.error ?? "Finish setting up this board"}
        onEdit={edit}
      />
    );
  } else if (!snapshot) {
    content =
      board.error && !board.loading ? (
        <BoardError
          message={board.error}
          onRetry={() => board.refresh("all")}
          onEdit={edit}
        />
      ) : (
        <BoardSkeleton />
      );
  } else if (snapshot.notice) {
    content = <BoardNotice message={snapshot.notice} onEdit={edit} />;
  } else {
    content = (
      <BoardColumns scrollerRef={scrollerRef} label={`${config.name} columns`}>
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            load={loads.get(column.id)!}
            cards={grouped.get(column.id) ?? []}
            doneHidden={snapshot.doneHidden}
            drop={
              dragState?.overColumnId === column.id ? dragState.verdict : null
            }
            draggingKey={dragState?.cardKey ?? null}
            focusKey={rovingKey}
            pending={pending}
            moveErrors={moveErrors}
            handlers={handlers}
          />
        ))}
      </BoardColumns>
    );
  }

  const showBanner =
    !!board.error &&
    !!snapshot &&
    !notConnected &&
    board.errorCode !== "incomplete";

  return (
    <div
      ref={rootRef}
      role="tabpanel"
      id={boardPanelId(config.id)}
      aria-labelledby={boardTabId(config.id)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <BoardToolbar
        provider={config.provider}
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
        iterationLabel={snapshot?.iterationLabel}
        iterationTitle={snapshot?.iterationTitle}
        count={snapshot && !snapshot.notice ? board.visibleCount : null}
        truncated={!!snapshot?.truncated}
        limit={snapshot?.limit ?? 0}
        busy={board.loading || board.revalidating}
        webUrl={snapshot?.webUrl ?? null}
        mine={mine}
        onMineChange={config.provider === "azuredevops" ? setMine : undefined}
        onEdit={edit}
        onRefresh={() => board.refresh("all")}
      />
      {showBanner ? (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-stroke bg-red-500/8 px-3 py-1.5 text-[12px] text-red-400"
        >
          <span className="min-w-0 flex-1 break-words">
            Couldn't refresh: {board.error}
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissMoveError()}
            className="grid size-5 shrink-0 place-items-center rounded text-red-400/80 hover:bg-red-500/15 hover:text-red-300"
          >
            <X className="size-3" strokeWidth={2} />
          </button>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{content}</div>
        {detailCard && snapshot ? (
          <BoardDetailPane
            key={detailCard.key}
            card={detailCard}
            snapshot={snapshot}
            pending={pending.has(detailCard.key)}
            canStart={!!onStart}
            onClose={() => closeDetail(true)}
            onMove={(columnId) => {
              if (columnId !== detailCard.columnId) {
                void move(detailCard.key, columnId);
              }
            }}
            onStart={() => {
              if (onStart) {
                void Promise.resolve(onStart(boardCardToInboxItem(detailCard)));
              }
            }}
          />
        ) : null}
      </div>
      {menu && menuCard && snapshot ? (
        <ExplorerMenu
          x={menu.x}
          y={menu.y}
          ariaLabel={`${menuCard.ref} actions`}
          items={boardCardMenuItems(snapshot, menuCard, {
            pending: pending.has(menuCard.key),
            canStart: !!onStart,
          })}
          onPick={onMenuPick}
          onClose={() => closeMenu(true)}
        />
      ) : null}
    </div>
  );
}
