import type { HighlightBackend } from "./codeHighlightPlugin";

/**
 * Tokenizes on the calling thread. Only tests use it: in the window the
 * engine runs in `codeHighlight.worker.ts`, and bundling it here as well
 * would emit every grammar chunk a second time.
 */
export function createInlineBackend(): HighlightBackend {
  const handler = import("./highlightEngine").then((mod) =>
    mod.createHighlightWorkerHandler(mod.createHighlightEngine()),
  );
  return {
    send: (message) => handler.then((handle) => handle(message)),
    offThread: false,
  };
}
