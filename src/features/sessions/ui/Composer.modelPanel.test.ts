// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock(
  "../../../integrations/harness/core/availability",
  async (original) => ({
    ...(await original<object>()),
    getHarnessAvailabilitySnapshot: () => 0,
    hasProbedHarnessAvailability: () => true,
    isHarnessAvailable: (id: string) => id === "claude",
    probeHarnessAvailability: () => Promise.resolve(),
    subscribeHarnessAvailability: () => () => undefined,
  }),
);
vi.mock("../../../integrations/harness/core/registry", async (original) => ({
  ...(await original<object>()),
  refreshHarnessCatalogs: () => Promise.resolve(),
}));

import { Composer } from "./Composer";
import { CLAUDE_MODEL_CATALOG } from "../../../integrations/harness/providers/claude/claudeCatalog";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  setHarnessModels("claude", CLAUDE_MODEL_CATALOG);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  vi.unstubAllGlobals();
});

function openPanel(props: Partial<ComponentProps<typeof Composer>> = {}) {
  act(() =>
    root.render(
      createElement(Composer, {
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
        onSubmit: () => true,
        ...props,
      }),
    ),
  );
  const chip = container.querySelector<HTMLButtonElement>(
    "[data-model-picker-trigger]",
  )!;
  act(() => chip.click());
  const panel = document.querySelector<HTMLElement>("[data-model-slider]")!;
  let frame: HTMLElement = panel;
  while (frame.parentElement && frame.parentElement !== document.body) {
    frame = frame.parentElement;
  }
  return { chip, panel, frame };
}

describe("model panel opened from the composer chip", () => {
  it.each([
    ["the docked composer", false],
    ["the new-session composer", true],
  ])("draws its inset line above the glass in %s", (_, shell) => {
    const { panel, frame } = openPanel({ shell });
    expect(panel).not.toBeNull();
    const glass = frame.querySelector<HTMLElement>(".popover-backdrop")!;
    const line = frame.querySelector<HTMLElement>("[data-popover-line]")!;
    expect(line).not.toBeNull();
    // A sibling stacked over the glass, painted after it, not an outline on
    // the frame that the glass's own layer would cover.
    expect(line.parentElement).toBe(frame);
    expect(frame.lastElementChild).toBe(line);
    expect(
      glass.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(glass.className).toContain("z-0");
    expect(line.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "z-[2]",
        "absolute",
        "inset-0",
        "rounded-[inherit]",
        "pointer-events-none",
        "outline-1",
        "-outline-offset-2",
        "outline-content/10",
      ]),
    );
    expect(frame.className).toContain("rounded-3xl");
    expect(frame.className).not.toMatch(/\boutline|\bborder/);
  });

  it("keeps other popovers on their bordered frame", () => {
    act(() =>
      root.render(
        createElement(Composer, {
          focused: false,
          harness: "claude",
          model: "claude:opus-5-5",
          runtimeMode: "supervised",
          cwd: "/work/monocode",
          executionCwd: "/work/monocode",
          onFocus: () => {},
          onCwdChange: () => {},
          onModelChange: () => {},
          onRuntimeModeChange: () => {},
          onSubmit: () => true,
        }),
      ),
    );
    const plus = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add files or choose a mode"]',
    )!;
    act(() => plus.click());
    const menu = document.querySelector<HTMLElement>("[data-composer-plus]")!;
    let frame: HTMLElement = menu;
    while (frame.parentElement && frame.parentElement !== document.body) {
      frame = frame.parentElement;
    }
    expect(frame.className).toContain("border-content/10");
    expect(frame.querySelector("[data-popover-line]")).toBeNull();
  });
});
