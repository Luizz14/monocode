import type {
  CodeHighlighterPlugin,
  HighlightResult,
  ThemeInput,
} from "@streamdown/code";
import type { BundledLanguage } from "shiki";
import type {
  HighlightRequest,
  HighlightWorkerReply,
  HighlightWorkerRequest,
  TokenLines,
} from "./highlightEngine";
import {
  SHIKI_LANGUAGE_IDS,
  normalizeLanguage,
  supportsLanguage,
} from "./shikiLanguages";

/**
 * `@streamdown/code` keeps every token result in a module-level Map that is
 * never evicted. Streamdown highlights a fence again on every streamed update,
 * so each partial version of every code block an agent wrote stayed in memory
 * for the life of the window. Its key (length plus the first and last 100
 * characters) also let different blocks share a result. This keeps the same
 * `CodeHighlighterPlugin` shape with a bounded LRU and an exact key.
 *
 * Tokenizing happens in a worker (`highlightEngine.ts` explains why). The
 * worker answers in request order and sends back only the lines after the
 * ones this side already holds from the previous answer, so a streaming fence
 * keeps its complete lines' token arrays, and `HighlightedLine` keeps their
 * elements. A worker that cannot start or crashes leaves fences as plain
 * text: shipping the engine for this thread as well would double the grammar
 * chunks on disk for a case module workers should never reach.
 *
 * Mounted blocks hold their tokens in component state, so eviction only means
 * a remounted block briefly shows plain text while it is highlighted again.
 */
const DEFAULT_THEMES: [ThemeInput, ThemeInput] = ["github-light", "github-dark"];
const MAX_ENTRIES = 100;
const MAX_CACHED_CHARS = 500_000;
/** Compiled after boot. Plain-text fences highlight as JavaScript. */
export const WARM_LANGUAGES: readonly string[] = [
  "javascript",
  "typescript",
  "tsx",
];

type HighlightCallback = (result: HighlightResult) => void;

export type HighlightBackend = {
  /** Replies arrive in request order. */
  send(message: HighlightWorkerRequest): Promise<HighlightWorkerReply>;
  /** True when tokenizing never blocks the caller's thread. */
  offThread: boolean;
};

export type BoundedCodePlugin = CodeHighlighterPlugin & {
  /** Number of token results currently cached. */
  cachedResults(): number;
  /**
   * Compiles grammars before their first fence, off the window's thread.
   * Resolves at once when highlighting runs on this thread.
   */
  warmUp(languages?: readonly string[]): Promise<void>;
};

/** Leaves code uncolored: one token per line, in the surrounding text color. */
export function createPlainBackend(): HighlightBackend {
  return {
    send: (message) => {
      if ("warm" in message) {
        return Promise.resolve({ id: message.id, result: undefined });
      }
      const lines: TokenLines = [];
      let offset = 0;
      for (const line of message.request.code.split("\n")) {
        lines.push([{ content: line, offset }]);
        offset += line.length + 1;
      }
      return Promise.resolve({
        id: message.id,
        result: { reusedLines: 0, lines },
      });
    },
    offThread: false,
  };
}

/**
 * Tokenizes in a worker. A worker that cannot start or crashes hands its
 * unanswered requests, in order, to the plain backend, which answers from
 * then on.
 */
export function createWorkerBackend(
  createWorker: () => Worker,
): HighlightBackend {
  const pending = new Map<
    number,
    { message: HighlightWorkerRequest; resolve: (reply: HighlightWorkerReply) => void }
  >();
  let worker: Worker | null = null;
  let fallback: HighlightBackend | null = null;

  const failOver = (reason: unknown) => {
    if (fallback) return;
    console.error(
      "[Code highlight] The highlight worker failed; code stays uncolored.",
      reason,
    );
    worker?.terminate();
    worker = null;
    const plain = createPlainBackend();
    fallback = plain;
    const waiting = [...pending.values()];
    pending.clear();
    for (const { message, resolve } of waiting) {
      void plain.send(message).then(resolve);
    }
  };

  const start = (): Worker | null => {
    try {
      const created = createWorker();
      created.onmessage = ({ data }: MessageEvent<HighlightWorkerReply>) => {
        const entry = pending.get(data.id);
        if (!entry) return;
        pending.delete(data.id);
        entry.resolve(data);
      };
      created.onerror = (event) => {
        failOver(
          typeof event === "object" && event && "message" in event
            ? event.message
            : event,
        );
      };
      created.onmessageerror = (event) => failOver(event);
      return created;
    } catch (error) {
      failOver(error);
      return null;
    }
  };

  return {
    send(message) {
      if (!fallback) worker ??= start();
      if (fallback) return fallback.send(message);
      return new Promise((resolve) => {
        pending.set(message.id, { message, resolve });
        worker!.postMessage(message);
      });
    },
    offThread: true,
  };
}

function defaultBackend(): HighlightBackend {
  if (import.meta.env.MODE === "test") {
    // Dead in the window's build, which keeps the engine out of it.
    const inline = import("./highlightInlineBackend").then((mod) =>
      mod.createInlineBackend(),
    );
    return {
      send: (message) => inline.then((backend) => backend.send(message)),
      offThread: false,
    };
  }
  if (typeof Worker !== "function") return createPlainBackend();
  return createWorkerBackend(
    () =>
      new Worker(new URL("./codeHighlight.worker.ts", import.meta.url), {
        type: "module",
      }),
  );
}

function themeName(theme: ThemeInput): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

export function createBoundedCodePlugin(
  options: {
    themes?: [ThemeInput, ThemeInput];
    maxEntries?: number;
    maxChars?: number;
    backend?: HighlightBackend;
  } = {},
): BoundedCodePlugin {
  const themes = options.themes ?? DEFAULT_THEMES;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const maxChars = options.maxChars ?? MAX_CACHED_CHARS;
  const backend = options.backend ?? defaultBackend();
  const results = new Map<string, HighlightResult>();
  const pending = new Map<string, Set<HighlightCallback>>();
  let cachedChars = 0;
  let nextId = 0;
  // The lines of the latest reply. The engine's checkpoint describes this
  // same fence, so a reply may say to keep a prefix of these lines.
  let lastLines: TokenLines = [];

  const remember = (key: string, result: HighlightResult) => {
    if (results.delete(key)) cachedChars -= key.length;
    // A block larger than the whole budget is delivered but never cached.
    if (key.length > maxChars) return;
    results.set(key, result);
    cachedChars += key.length;
    while (results.size > maxEntries || cachedChars > maxChars) {
      const oldest = results.keys().next().value;
      if (oldest === undefined) break;
      results.delete(oldest);
      cachedChars -= oldest.length;
    }
  };

  return {
    name: "shiki",
    type: "code-highlighter",
    supportsLanguage: (language) => supportsLanguage(language),
    getSupportedLanguages: () => [...SHIKI_LANGUAGE_IDS] as BundledLanguage[],
    getThemes: () => themes,
    cachedResults: () => results.size,
    warmUp: (languages = WARM_LANGUAGES) => {
      if (!backend.offThread) return Promise.resolve();
      return backend
        .send({ id: ++nextId, warm: languages })
        .then((reply) => {
          if ("error" in reply) throw new Error(reply.error);
        })
        .catch((error: unknown) => {
          console.error("[Code highlight] Failed to warm grammars:", error);
        });
    },
    highlight({ code, language, themes: pair }, callback) {
      const lang = normalizeLanguage(language);
      const names = [themeName(pair[0]), themeName(pair[1])] as const;
      const key = `${lang}\u0000${names[0]}\u0000${names[1]}\u0000${code}`;
      const cached = results.get(key);
      if (cached) {
        // Refresh recency so blocks still on screen are evicted last.
        results.delete(key);
        results.set(key, cached);
        return cached;
      }
      const waiting = pending.get(key);
      if (waiting) {
        if (callback) waiting.add(callback);
        return null;
      }
      pending.set(key, new Set(callback ? [callback] : []));
      const request: HighlightRequest = {
        code,
        language: lang,
        themes: pair,
        // Complete lines of the last fence; its unfinished last line is not
        // one of them.
        reuseLines: Math.max(0, lastLines.length - 1),
        checkpointLimit: maxChars,
      };
      void backend
        .send({ id: ++nextId, request })
        .then((reply) => {
          if ("error" in reply) throw new Error(reply.error);
          const response = reply.result!;
          const tokens =
            response.reusedLines > 0
              ? [...lastLines.slice(0, response.reusedLines), ...response.lines]
              : response.lines;
          lastLines = tokens;
          const result: HighlightResult = {
            fg: response.fg,
            bg: response.bg,
            themeName: response.themeName,
            rootStyle: response.rootStyle,
            tokens,
          };
          remember(key, result);
          const callbacks = pending.get(key);
          pending.delete(key);
          callbacks?.forEach((notify) => notify(result));
        })
        .catch((error: unknown) => {
          lastLines = [];
          pending.delete(key);
          console.error("[Code highlight] Failed to highlight code:", error);
        });
      return null;
    },
  };
}

export const boundedCode = createBoundedCodePlugin();

/** Compiles the common grammars after boot, so the first fence colors at once. */
export function warmCodeHighlighting(): Promise<void> {
  return boundedCode.warmUp();
}
