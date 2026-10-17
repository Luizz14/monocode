import { useState, type ReactNode } from "react";
import {
  AlertCircle,
  Kanban,
  RefreshCw,
  SlidersHorizontal,
} from "../../../shared/ui/icons";
import { InboxProviderMark } from "../../inbox/ui/InboxProviderMark";
import {
  AZURE_URL_INVALID_MESSAGE,
  parseAzureBoardUrl,
} from "../model/azureBoardUrl";
import { BOARD_PROVIDER_LABELS, type BoardProvider } from "../model/boardTypes";

const BUTTON =
  "inline-flex h-7 items-center gap-1.5 rounded-md border border-content/15 px-3 text-[12px] text-content/80 hover:border-content/30 hover:bg-content/10 hover:text-content disabled:cursor-default disabled:opacity-40";
const BUTTON_FILLED =
  "inline-flex h-7 items-center gap-1.5 rounded-md bg-content px-3 text-[12px] font-medium text-background-base hover:bg-content/80 disabled:cursor-default disabled:opacity-40";

function StateFrame({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        {icon}
        <p className="text-[13px] font-medium text-content">{title}</p>
        {children}
      </div>
    </div>
  );
}

/** Whether a provider can't be used yet (unknown counts as usable). */
function disconnected(
  connections: Partial<Record<BoardProvider, boolean | null>>,
  provider: BoardProvider,
): boolean {
  return connections[provider] === false;
}

export function BoardEmpty({
  connections,
  onNew,
  onImport,
  onConnect,
}: {
  connections: Partial<Record<BoardProvider, boolean | null>>;
  onNew: (provider: BoardProvider) => void;
  /** Opens the new-board dialog with this Azure DevOps link imported. */
  onImport: (url: string) => void;
  onConnect: (provider: BoardProvider) => void;
}) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);
  const azureOff = disconnected(connections, "azuredevops");

  const tryImport = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError(null);
      return;
    }
    if (!parseAzureBoardUrl(trimmed)) {
      setError(AZURE_URL_INVALID_MESSAGE);
      return;
    }
    setError(null);
    setLink("");
    onImport(trimmed);
  };

  return (
    <StateFrame
      icon={
        <Kanban
          aria-hidden
          className="size-6 text-content/35"
          strokeWidth={1.5}
        />
      }
      title="Organize work items on a board"
    >
      <p className="text-[12px] leading-relaxed text-content/55">
        Pick a team's work from Azure DevOps or Linear. Moving a card updates
        its state in the provider.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {(["azuredevops", "linear"] as const).map((provider) =>
          disconnected(connections, provider) ? (
            <button
              key={provider}
              type="button"
              onClick={() => onConnect(provider)}
              className={BUTTON}
            >
              <InboxProviderMark
                provider={provider}
                className="block size-3.5 shrink-0"
              />
              Connect {BOARD_PROVIDER_LABELS[provider]}
            </button>
          ) : (
            <button
              key={provider}
              type="button"
              onClick={() => onNew(provider)}
              className={BUTTON}
            >
              <InboxProviderMark
                provider={provider}
                className="block size-3.5 shrink-0"
              />
              New {BOARD_PROVIDER_LABELS[provider]} board
            </button>
          ),
        )}
      </div>
      {azureOff ? null : (
        <form
          className="flex w-full flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            tryImport(link);
          }}
        >
          <input
            value={link}
            onChange={(event) => {
              setLink(event.target.value);
              if (error) setError(null);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (!pasted.trim()) return;
              event.preventDefault();
              setLink(pasted);
              tryImport(pasted);
            }}
            placeholder="Paste an Azure DevOps backlog link"
            aria-label="Paste an Azure DevOps backlog link"
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            autoComplete="off"
            className="h-8 w-full rounded-md border border-content/10 bg-background-base px-2.5 text-[12px] text-content outline-none placeholder:text-content/40 focus:border-content/25"
          />
          {error ? (
            <p role="alert" className="text-left text-[11.5px] text-red-400">
              {error}
            </p>
          ) : null}
        </form>
      )}
    </StateFrame>
  );
}

export function BoardNotConnected({
  provider,
  onConnect,
}: {
  provider: BoardProvider;
  onConnect: (provider: BoardProvider) => void;
}) {
  const label = BOARD_PROVIDER_LABELS[provider];
  return (
    <StateFrame
      icon={
        <InboxProviderMark
          provider={provider}
          className="block size-6 text-content/50"
        />
      }
      title={`${label} isn't connected`}
    >
      <p className="text-[12px] text-content/55">
        Connect {label} to load this board.
      </p>
      <button
        type="button"
        onClick={() => onConnect(provider)}
        className={BUTTON_FILLED}
      >
        Connect {label}
      </button>
    </StateFrame>
  );
}

export function BoardError({
  message,
  onRetry,
  onEdit,
}: {
  message: string;
  onRetry?: () => void;
  onEdit: () => void;
}) {
  return (
    <StateFrame
      icon={
        <AlertCircle
          aria-hidden
          className="size-5 text-red-400"
          strokeWidth={1.75}
        />
      }
      title="This board couldn't load"
    >
      <p role="alert" className="break-words text-[12px] text-content/60">
        {message}
      </p>
      <div className="flex gap-2">
        {onRetry ? (
          <button type="button" onClick={onRetry} className={BUTTON}>
            <RefreshCw className="size-3.5" strokeWidth={1.75} />
            Retry
          </button>
        ) : null}
        <button type="button" onClick={onEdit} className={BUTTON}>
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
          Edit board
        </button>
      </div>
    </StateFrame>
  );
}

/** Shown instead of cards when the board can't be queried as configured. */
export function BoardNotice({
  message,
  onEdit,
}: {
  message: string;
  onEdit: () => void;
}) {
  return (
    <StateFrame title={message}>
      <button type="button" onClick={onEdit} className={BUTTON}>
        <SlidersHorizontal className="size-3.5" strokeWidth={1.75} />
        Edit board
      </button>
    </StateFrame>
  );
}

export function BoardSkeleton() {
  return (
    <div
      aria-hidden
      data-board-skeleton
      className="flex min-h-0 flex-1 gap-2.5 overflow-hidden p-3"
    >
      {[5, 3, 4, 2].map((count, index) => (
        <div
          key={index}
          className="flex w-[272px] shrink-0 flex-col gap-1.5 rounded-lg bg-content/[0.03] p-1.5 ring-1 ring-content/6"
        >
          <div className="mx-1 my-2 h-3 w-24 animate-pulse rounded bg-content/8 motion-reduce:animate-none" />
          {Array.from({ length: count }, (_, card) => (
            <div
              key={card}
              className="h-[68px] animate-pulse rounded-md bg-content/6 motion-reduce:animate-none"
            />
          ))}
        </div>
      ))}
    </div>
  );
}
