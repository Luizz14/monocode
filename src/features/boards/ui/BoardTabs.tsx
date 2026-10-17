import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Plus } from "../../../shared/ui/icons";
import { Popover } from "../../../shared/ui/Popover";
import { RollText } from "../../../shared/ui/RollText";
import { ExplorerMenu } from "../../files/ui/ExplorerMenu";
import { InboxProviderMark } from "../../inbox/ui/InboxProviderMark";
import {
  BOARD_PROVIDER_LABELS,
  type BoardConfig,
  type BoardProvider,
} from "../model/boardTypes";

const ADD_MENU_WIDTH = 200;
const PROVIDERS: BoardProvider[] = ["azuredevops", "linear"];

export function boardTabId(id: string): string {
  return `board-tab-${id}`;
}

export function boardPanelId(id: string): string {
  return `board-panel-${id}`;
}

type TabMenu = { config: BoardConfig; x: number; y: number };

export function BoardTabs({
  configs,
  activeId,
  connections,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  onNew,
  onConnect,
  onMenuChange,
}: {
  configs: readonly BoardConfig[];
  activeId: string | null;
  connections: Partial<Record<BoardProvider, boolean | null>>;
  onSelect: (id: string) => void;
  onEdit: (config: BoardConfig) => void;
  onDuplicate: (id: string) => void;
  onDelete: (config: BoardConfig) => void;
  onNew: (provider: BoardProvider) => void;
  onConnect: (provider: BoardProvider) => void;
  /** Reports whether one of this row's menus is open. */
  onMenuChange?: (open: boolean) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const [tabMenu, setTabMenu] = useState<TabMenu | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const menuOpen = tabMenu !== null || addOpen;
  const onMenuChangeRef = useRef(onMenuChange);
  onMenuChangeRef.current = onMenuChange;

  useEffect(() => {
    onMenuChangeRef.current?.(menuOpen);
  }, [menuOpen]);
  useEffect(() => () => onMenuChangeRef.current?.(false), []);

  const focusTab = (id: string) => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-board-tab="${id}"]`)
      ?.focus();
  };

  const onTabKey = (
    index: number,
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % configs.length;
    else if (event.key === "ArrowLeft") {
      next = (index - 1 + configs.length) % configs.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = configs.length - 1;
    else if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setTabMenu({
        config: configs[index]!,
        x: rect.left,
        y: rect.bottom + 2,
      });
      return;
    }
    if (next === -1) return;
    event.preventDefault();
    const target = configs[next];
    if (!target) return;
    onSelect(target.id);
    focusTab(target.id);
  };

  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-stroke px-2">
      {configs.length > 0 ? (
        <div
          ref={listRef}
          role="tablist"
          aria-label="Boards"
          className="flex min-w-0 items-center gap-px overflow-x-auto"
        >
          {configs.map((config, index) => {
            const selected = config.id === activeId;
            return (
              <button
                key={config.id}
                id={boardTabId(config.id)}
                data-board-tab={config.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={selected ? boardPanelId(config.id) : undefined}
                tabIndex={selected ? 0 : -1}
                title={config.name}
                onClick={() => onSelect(config.id)}
                onDoubleClick={() => onEdit(config)}
                onKeyDown={(event) => onTabKey(index, event)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setTabMenu({ config, x: event.clientX, y: event.clientY });
                }}
                className={`flex h-6 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                  selected
                    ? "bg-selection text-content"
                    : "text-content/50 hover:bg-content/5 hover:text-content"
                }`}
              >
                <InboxProviderMark
                  provider={config.provider}
                  className="block size-3.5 shrink-0"
                />
                <RollText
                  text={config.name}
                  className="min-w-0 truncate leading-none"
                />
              </button>
            );
          })}
        </div>
      ) : null}
      <button
        ref={addRef}
        type="button"
        aria-label="New board"
        title="New board"
        aria-haspopup="menu"
        aria-expanded={addOpen}
        onClick={() => setAddOpen(!addOpen)}
        className={`grid size-6 shrink-0 place-items-center rounded-md ${
          addOpen
            ? "bg-selection text-content"
            : "text-content/45 hover:bg-content/10 hover:text-content"
        }`}
      >
        <Plus className="size-3.5" strokeWidth={1.75} />
      </button>
      {addOpen ? (
        <Popover
          anchor={addRef}
          gap={4}
          width={ADD_MENU_WIDTH}
          autoFocus
          onDismiss={() => setAddOpen(false)}
          role="menu"
          aria-label="New board"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitem"]',
              ),
            ];
            const at = items.indexOf(document.activeElement as HTMLElement);
            const step = event.key === "ArrowDown" ? 1 : -1;
            const next =
              at === -1
                ? step === 1
                  ? 0
                  : items.length - 1
                : (at + step + items.length) % items.length;
            items[next]?.focus();
          }}
          onContextMenu={(event) => event.preventDefault()}
          className="p-1"
        >
          {PROVIDERS.map((provider) => {
            const off = connections[provider] === false;
            const label = BOARD_PROVIDER_LABELS[provider];
            return (
              <button
                key={provider}
                type="button"
                role="menuitem"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setAddOpen(false);
                  if (off) onConnect(provider);
                  else onNew(provider);
                }}
                className="flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px] leading-none text-content hover:bg-content/5 focus-visible:bg-content/5 focus-visible:outline-none"
              >
                <InboxProviderMark
                  provider={provider}
                  className="block size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">{label} board</span>
                {off ? (
                  <span className="shrink-0 text-[11px] text-content/45">
                    Connect
                  </span>
                ) : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
      {tabMenu ? (
        <ExplorerMenu
          x={tabMenu.x}
          y={tabMenu.y}
          ariaLabel={`${tabMenu.config.name} actions`}
          items={[
            { kind: "item", id: "edit", label: "Edit board…" },
            { kind: "item", id: "duplicate", label: "Duplicate" },
            { kind: "sep" },
            {
              kind: "item",
              id: "delete",
              label: "Delete board…",
              danger: true,
            },
          ]}
          onPick={(id) => {
            const config = tabMenu.config;
            setTabMenu(null);
            if (id === "edit") onEdit(config);
            else if (id === "duplicate") onDuplicate(config.id);
            else if (id === "delete") onDelete(config);
          }}
          onClose={() => setTabMenu(null)}
        />
      ) : null}
    </div>
  );
}
