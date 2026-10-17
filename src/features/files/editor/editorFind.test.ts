// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { keybindingPressed, handleFilePreviewFindKey, openFindInActiveFilePreview } =
  vi.hoisted(() => ({
    keybindingPressed: vi.fn(),
    handleFilePreviewFindKey: vi.fn(),
    openFindInActiveFilePreview: vi.fn(),
  }));

vi.mock("../../settings/model/settings", () => ({ keybindingPressed }));
vi.mock("../ui/FilePreviewSearch", () => ({
  handleFilePreviewFindKey,
  openFindInActiveFilePreview,
}));

import {
  handleEditorFindKey,
  handleFindKeyWithoutEditor,
  openFindInActiveEditor,
  registerEditorFind,
} from "./editorFind";

function key(
  overrides: Partial<KeyboardEvent> & { target?: unknown } = {},
): KeyboardEvent {
  const event = {
    key: "f",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target: null,
    preventDefault: vi.fn(),
    ...overrides,
  };
  return event as unknown as KeyboardEvent;
}

beforeEach(() => {
  keybindingPressed.mockReset();
  handleFilePreviewFindKey.mockReset().mockReturnValue(false);
  openFindInActiveFilePreview.mockReset().mockReturnValue(false);
});

describe("find keys before the editor module loads", () => {
  it("leaves the default shortcut alone when it is still bound to find", () => {
    keybindingPressed.mockImplementation((_action, _event, fallback) => fallback);
    const event = key();
    expect(handleFindKeyWithoutEditor(event)).toBeUndefined();
    expect(handleEditorFindKey(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("swallows the default shortcut when find is bound elsewhere", () => {
    keybindingPressed.mockReturnValue(false);
    const event = key();
    expect(handleEditorFindKey(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(keybindingPressed).toHaveBeenCalledWith("Editor: Find", event, true);
  });

  it("gives the file preview and pickers their keys first", () => {
    handleFilePreviewFindKey.mockReturnValue(true);
    expect(handleEditorFindKey(key())).toBe(true);
    expect(keybindingPressed).not.toHaveBeenCalled();

    handleFilePreviewFindKey.mockReturnValue(false);
    const picker = { closest: (selector: string) => (selector.includes("[data-file-picker]") ? {} : null) };
    const inPicker = key({ target: Object.assign(Object.create(Element.prototype), picker) });
    expect(handleEditorFindKey(inPicker)).toBe(false);
    expect(handleFilePreviewFindKey).toHaveBeenCalledTimes(1);

    expect(openFindInActiveEditor()).toBe(false);
    openFindInActiveFilePreview.mockReturnValue(true);
    expect(openFindInActiveEditor()).toBe(true);
  });

  it("hands both entry points to the editor module once it registers", () => {
    const editor = {
      handleEditorFindKey: vi.fn(() => true),
      openFindInActiveEditor: vi.fn(() => true),
    };
    registerEditorFind(editor);
    const event = key();
    expect(handleEditorFindKey(event)).toBe(true);
    expect(editor.handleEditorFindKey).toHaveBeenCalledWith(event);
    expect(openFindInActiveEditor()).toBe(true);
    expect(editor.openFindInActiveEditor).toHaveBeenCalled();
  });
});

describe("the editor module", () => {
  it("registers its find handling when imported", async () => {
    const search = await import("./editorSearch");
    keybindingPressed.mockImplementation((_action, _event, fallback) => fallback);
    const event = key();
    // No editor on screen: the editor module also answers false, without
    // swallowing the key.
    expect(search.handleEditorFindKey(event)).toBe(false);
    expect(handleEditorFindKey(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
