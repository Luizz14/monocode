// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Switching `composerLook` back to upstream's look is the documented way out
// of the fork's composer design; this keeps that path rendering upstream's box.
vi.mock("./composerLook", async (original) => {
  const looks = await original<typeof import("./composerLook")>();
  return { ...looks, composerLook: looks.officialLook };
});
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    branches: {
      current: "main",
      detached: false,
      branches: [{ name: "main", remote: null, current: true }],
    },
    settled: true,
  }),
}));

import { Composer } from "./Composer";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("renders upstream's composer when composerLook is officialLook", () => {
  const props: ComponentProps<typeof Composer> = {
    focused: false,
    harness: "claude",
    model: "claude:opus-5-5",
    modelSettings: { effort: "high" },
    runtimeMode: "supervised",
    cwd: "/work/monocode",
    executionCwd: "/work/monocode",
    branch: "main",
    onFocus: () => {},
    onCwdChange: () => {},
    onModelChange: () => {},
    onRuntimeModeChange: () => {},
    onSubmit: () => {},
    onStop: () => {},
  };
  act(() => root.render(createElement(Composer, props)));
  const box = container.querySelector<HTMLElement>("[data-composer-box]")!;
  const classes = box.className.split(/\s+/);
  expect(box.dataset.composerLook).toBe("official");
  expect(classes).toEqual(
    expect.arrayContaining(["border", "rounded-lg", "border-content/10"]),
  );
  expect(classes.some((name) => name.startsWith("outline"))).toBe(false);
  // Attach opens the toolbar row, ahead of the model chip.
  const row = box.querySelector('[aria-label="Add files or choose a mode"]')!
    .parentElement!.parentElement!;
  const attach = row.firstElementChild!;
  expect(
    attach.querySelector('[aria-label="Add files or choose a mode"]'),
  ).not.toBeNull();
  expect(
    box.querySelector<HTMLElement>("[aria-label='Send']")!.className,
  ).toContain("rounded-md");
});
