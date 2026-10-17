// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import {
  loadModelPresets,
  loadModelSliderHaptics,
  saveModelPresets,
} from "../model/modelPresets";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
  type ModelSetting,
} from "../../sessions/model/models";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  convertFileSrc: (path: string) => path,
  isTauri: () => false,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude",
  hasProbedHarnessAvailability: () => true,
  getHarnessAvailabilitySnapshot: () => 0,
  subscribeHarnessAvailability: () => () => {},
  probeHarnessAvailability: async () => {},
  harnessUnavailableHint: () => "",
}));

const effort: ModelSetting = {
  id: "effort",
  label: "Reasoning",
  kind: "select",
  value: "high",
  options: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "max", label: "Max" },
    { value: "ultracode", label: "Ultracode" },
    { value: "ultrathink", label: "Ultrathink" },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetHarnessModelOverlays();
  setHarnessModels("claude", [
    {
      id: "claude:sonnet-5",
      harness: "claude",
      name: "Claude Sonnet 5",
      settings: [effort],
    },
    {
      id: "claude:opus-5-5",
      harness: "claude",
      name: "Claude Opus 5.5",
      settings: [effort],
    },
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(SettingsView, {
        section: "chat",
        cwd: "/repo",
        sessions: [],
        onClose: vi.fn(),
        onSelectSection: vi.fn(),
        onOpenSession: vi.fn(),
        onArchiveSession: vi.fn(),
        onDeleteSession: vi.fn(),
        onOpenWhatsNew: vi.fn(),
      }),
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const rows = () =>
  Array.from(
    container.querySelectorAll<HTMLElement>("[data-model-preset-row]"),
  );

function rowLabels(): string[] {
  return rows().map((row) =>
    Array.from(
      row.querySelectorAll<HTMLButtonElement>(
        'button[aria-haspopup="listbox"]',
      ),
      (button) => button.getAttribute("aria-label")!.split(": ")[1],
    ).join(" "),
  );
}

function click(label: string) {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
  act(() => button.click());
}

function clickText(text: string) {
  const button = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((item) => item.textContent?.trim() === text)!;
  act(() => button.click());
}

describe("model presets settings", () => {
  it("lists the default presets in slider order", () => {
    expect(rowLabels()).toEqual([
      "Sonnet 5 Medium",
      "Opus 5.5 Medium",
      "Opus 5.5 High",
      "Opus 5.5 Max",
      "Opus 5.5 Ultracode",
      "Opus 5.5 Ultrathink",
    ]);
  });

  it("reorders and removes presets", () => {
    click("Move preset 2 left");
    expect(rowLabels().slice(0, 2)).toEqual([
      "Opus 5.5 Medium",
      "Sonnet 5 Medium",
    ]);
    click("Remove preset 1");
    expect(rowLabels()[0]).toBe("Sonnet 5 Medium");
    expect(loadModelPresets()).toHaveLength(5);
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Move preset 1 left"]',
      )!.disabled,
    ).toBe(true);
  });

  it("adds the next unused choice and resets to the defaults", () => {
    clickText("Add preset");
    expect(rowLabels()[6]).toBe("Opus 5.5 Low");
    clickText("Reset");
    expect(rowLabels()).toHaveLength(6);
  });

  it("edits a preset's effort, and keeps it when the model supports it", () => {
    const effortTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preset 3 effort: High"]',
    )!;
    act(() => effortTrigger.click());
    const option = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent === "Low")!;
    act(() => option.click());
    expect(loadModelPresets()[2]).toMatchObject({
      model: "claude:opus-5-5",
      effort: "low",
    });

    const modelTrigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Preset 3 model: Opus 5.5"]',
    )!;
    act(() => modelTrigger.click());
    const sonnet = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((item) => item.textContent === "Sonnet 5")!;
    act(() => sonnet.click());
    expect(loadModelPresets()[2]).toMatchObject({
      model: "claude:sonnet-5",
      effort: "low",
    });
  });

  it("flags presets the slider leaves off", () => {
    act(() =>
      saveModelPresets([
        { id: "a", harness: "claude", model: "claude:gone", effort: "max" },
        { id: "b", harness: "codex", model: "codex:gpt-5.5", effort: "" },
        {
          id: "c",
          harness: "claude",
          model: "claude:opus-5-5",
          effort: "high",
        },
      ]),
    );
    const notOnSlider = rows().map((row) =>
      row.textContent?.includes("Not on slider"),
    );
    expect(notOnSlider).toEqual([true, true, false]);
    expect(rowLabels()[0]).toBe("gone (unavailable)");
  });

  it("toggles trackpad haptics", () => {
    const toggle = container.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Trackpad haptics"]',
    )!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(loadModelSliderHaptics()).toBe(false);
  });
});
