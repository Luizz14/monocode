import { keybindingPressed } from "../../settings/model/settings";
import {
  handleFilePreviewFindKey,
  openFindInActiveFilePreview,
} from "../ui/FilePreviewSearch";

/**
 * The window's find shortcuts, without CodeMirror. App handles Cmd+F before
 * anything else, and taking that from `editorSearch` pulled CodeMirror's
 * view, state and search packages (253 KB) into the boot bundle for an
 * editor that opens on demand. The editor's own module registers itself
 * here when it loads; until then only the parts that need no editor run,
 * which is all `editorSearch` did without one on screen.
 */
type EditorFind = {
  handleEditorFindKey: (event: KeyboardEvent) => boolean;
  openFindInActiveEditor: () => boolean;
};

let editor: EditorFind | null = null;
let loading: Promise<void> | null = null;

export function registerEditorFind(find: EditorFind) {
  editor = find;
}

/** Loads the editor's find handling ahead of the first editor. */
export function preloadEditorFind(): Promise<void> {
  loading ??= import("./editorSearch").then(() => undefined);
  return loading;
}

/**
 * The part of a find keystroke that needs no editor: pickers keep their
 * keys, the file preview's find comes first, and the default shortcuts stay
 * swallowed when the action is bound elsewhere. Undefined means the editor
 * decides.
 */
export function handleFindKeyWithoutEditor(
  event: KeyboardEvent,
): boolean | undefined {
  if (event.isComposing) return false;

  const target = event.target instanceof Element ? event.target : null;
  if (
    target?.closest(
      "[data-file-picker], [data-model-picker], [data-branch-picker], [data-skill-picker], [data-mention-picker]",
    )
  ) {
    return false;
  }

  if (handleFilePreviewFindKey(event)) return true;

  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  const defaultReplace = mod && event.altKey && !event.shiftKey && key === "f";
  const defaultFind = mod && !event.altKey && !event.shiftKey && key === "f";
  if (
    (defaultReplace && !keybindingPressed("Editor: Replace", event, true)) ||
    (defaultFind && !keybindingPressed("Editor: Find", event, true))
  ) {
    event.preventDefault();
    return true;
  }
  return undefined;
}

export function handleEditorFindKey(event: KeyboardEvent): boolean {
  if (editor) return editor.handleEditorFindKey(event);
  return handleFindKeyWithoutEditor(event) ?? false;
}

export function openFindInActiveEditor(): boolean {
  if (editor) return editor.openFindInActiveEditor();
  return openFindInActiveFilePreview();
}
