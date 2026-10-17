import type { HighlightResult, ThemeInput } from "@streamdown/code";
import {
  createHighlighter,
  type BundledLanguage,
  type GrammarState,
} from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { normalizeLanguage, supportsLanguage } from "./shikiLanguages";

/**
 * The tokenizing half of code highlighting. It runs in the highlight worker
 * (`codeHighlight.worker.ts`) and, where workers are unavailable, inline.
 *
 * Shiki's JavaScript regex engine translates and compiles a grammar's rules
 * the first time a scanner reaches them, and the root scanner of TypeScript
 * alone blocks for most of a second. Keeping that work off the window's
 * thread is why the engine lives behind a message protocol instead of being
 * called directly.
 *
 * Streamdown highlights a fence again on every streamed update, so the engine
 * keeps a checkpoint of the last fence: its complete lines' grammar state.
 * The caller keeps those lines' tokens; a response says how many of them to
 * keep (`reusedLines`) and carries only the lines after them. Requests must
 * be answered in order for the two sides to agree on what "the last fence" is.
 */
export type ThemePair = [ThemeInput, ThemeInput];
export type TokenLines = HighlightResult["tokens"];

export type HighlightRequest = {
  code: string;
  language: string;
  themes: ThemePair;
  /** Complete token lines the caller still holds from the previous response. */
  reuseLines: number;
  /** Fences longer than this are not checkpointed. */
  checkpointLimit: number;
};

export type HighlightResponse = Omit<
  HighlightResult,
  "tokens" | "grammarState"
> & {
  /** Leading lines of the previous response that this one shares. */
  reusedLines: number;
  /** The lines after the reused ones, with offsets from the start of the fence. */
  lines: TokenLines;
};

export type HighlightWorkerRequest =
  | { id: number; request: HighlightRequest }
  | { id: number; warm: readonly string[] };

export type HighlightWorkerReply =
  | { id: number; result: HighlightResponse | undefined }
  | { id: number; error: string };

export type HighlightEngine = {
  tokenize(request: HighlightRequest): Promise<HighlightResponse>;
  /** Compiles the grammars of `languages` so their first fence highlights at once. */
  warm(languages: readonly string[]): Promise<void>;
  /** Drops the checkpoint. The next request tokenizes from the start. */
  reset(): void;
};

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

export function themeName(theme: ThemeInput): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

const WARM_SNIPPET = [
  'import { readFile } from "node:fs/promises";',
  "export async function main(path: string): Promise<number> {",
  "  const text = await readFile(path, { encoding: 'utf8' });",
  "  // Count the lines that are not empty.",
  "  return text.split(/\\r?\\n/).filter((line) => line.trim() !== '').length;",
  "}",
].join("\n");

export function createHighlightEngine(): HighlightEngine {
  const engine = createJavaScriptRegexEngine({ forgiving: true });
  const highlighters = new Map<string, Promise<Highlighter>>();
  let checkpoint:
    | {
        config: string;
        source: string;
        lineCount: number;
        state: GrammarState | undefined;
      }
    | undefined;

  const highlighterFor = (pair: ThemePair) => {
    const key = `${themeName(pair[0])}\u0000${themeName(pair[1])}`;
    let highlighter = highlighters.get(key);
    if (!highlighter) {
      highlighter = createHighlighter({ themes: pair, langs: [], engine });
      highlighters.set(key, highlighter);
      highlighter.catch(() => highlighters.delete(key));
    }
    return highlighter;
  };

  const loadedLanguage = async (highlighter: Highlighter, language: string) => {
    const lang = normalizeLanguage(language);
    if (supportsLanguage(lang) && !highlighter.getLoadedLanguages().includes(lang)) {
      await highlighter.loadLanguage(lang as BundledLanguage);
    }
    return highlighter.getLoadedLanguages().includes(lang) ? lang : "text";
  };

  return {
    async tokenize(request) {
      const { code, themes: pair, reuseLines, checkpointLimit } = request;
      const names = [themeName(pair[0]), themeName(pair[1])] as const;
      const highlighter = await highlighterFor(pair);
      const usable = await loadedLanguage(highlighter, request.language);
      const config = `${usable}\u0000${names[0]}\u0000${names[1]}`;
      const previous =
        checkpoint?.config === config &&
        checkpoint.lineCount === reuseLines &&
        code.startsWith(checkpoint.source)
          ? checkpoint
          : undefined;
      const offset = previous?.source.length ?? 0;
      const boundary = code.lastIndexOf("\n") + 1;
      const settings = {
        lang: usable as BundledLanguage,
        themes: { light: names[0], dark: names[1] },
      };
      const lines: TokenLines = [];
      let state = previous?.state;
      if (boundary > offset) {
        const lineEnd =
          code[boundary - 2] === "\r" ? boundary - 2 : boundary - 1;
        const complete = highlighter.codeToTokens(code.slice(offset, lineEnd), {
          ...settings,
          grammarState: state,
        });
        for (const line of complete.tokens) {
          lines.push(
            line.map((token) => ({ ...token, offset: token.offset + offset })),
          );
        }
        state = complete.grammarState;
      }
      const tail = highlighter.codeToTokens(code.slice(boundary), {
        ...settings,
        grammarState: state,
      });
      for (const line of tail.tokens) {
        lines.push(
          line.map((token) => ({ ...token, offset: token.offset + boundary })),
        );
      }
      checkpoint =
        boundary > 0 && boundary <= checkpointLimit
          ? {
              config,
              source: code.slice(0, boundary),
              lineCount: (previous?.lineCount ?? 0) + lines.length - 1,
              state,
            }
          : undefined;
      const { tokens: _tokens, grammarState: _state, ...rest } = tail;
      return { ...rest, reusedLines: previous?.lineCount ?? 0, lines };
    },
    async warm(languages) {
      const highlighter = await highlighterFor(["github-light", "github-dark"]);
      for (const language of languages) {
        const usable = await loadedLanguage(highlighter, language);
        if (usable === "text") continue;
        highlighter.codeToTokens(WARM_SNIPPET, {
          lang: usable as BundledLanguage,
          themes: { light: "github-light", dark: "github-dark" },
        });
      }
    },
    reset() {
      checkpoint = undefined;
    },
  };
}

/**
 * Answers worker messages one at a time, in arrival order, so the engine's
 * checkpoint always describes the reply the caller received just before.
 */
export function createHighlightWorkerHandler(
  engine: HighlightEngine,
): (message: HighlightWorkerRequest) => Promise<HighlightWorkerReply> {
  let queue: Promise<unknown> = Promise.resolve();
  return (message) => {
    const reply = queue.then(async (): Promise<HighlightWorkerReply> => {
      try {
        if ("warm" in message) {
          await engine.warm(message.warm);
          return { id: message.id, result: undefined };
        }
        return { id: message.id, result: await engine.tokenize(message.request) };
      } catch (error) {
        engine.reset();
        return {
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    queue = reply;
    return reply;
  };
}
