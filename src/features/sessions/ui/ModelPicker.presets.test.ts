// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: () => Promise.resolve(),
}));

vi.mock("../../../platform/tauri/haptics", () => ({ performHaptic: vi.fn() }));

vi.mock("../../../shared/ui/Popover", () => ({
  Popover: ({
    children,
    role,
    className,
    onKeyDown,
    side,
    gap,
    anchor,
    ...props
  }: {
    anchor?: unknown;
    children: ReactNode;
    role?: string;
    className?: string;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    side?: string;
    gap?: number;
    "aria-label"?: string;
  }) =>
    createElement(
      "div",
      {
        role,
        className,
        onKeyDown,
        "data-side": side,
        "data-gap": gap,
        "data-anchor-trigger": String(
          (
            anchor as { current?: Element | null } | undefined
          )?.current?.hasAttribute("data-model-picker-trigger") ?? false,
        ),
        "aria-label": props["aria-label"],
      },
      children,
    ),
}));

import { ModelPicker } from "./ModelPicker";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
  type ModelSetting,
} from "../model/models";
import { saveModelPresets } from "../../settings/model/modelPresets";

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
const fast: ModelSetting = {
  id: "fast",
  label: "Fast",
  kind: "toggle",
  value: "false",
  options: [
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ],
};
const CLAUDE: AgentModel[] = [
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
    settings: [effort, fast],
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetHarnessModelOverlays();
  setHarnessModels("claude", CLAUDE);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  resetHarnessModelOverlays();
  container.remove();
  vi.unstubAllGlobals();
});

function render(
  props: Partial<Parameters<typeof ModelPicker>[0]> = {},
  values: Record<string, string> = { effort: "high", fast: "true" },
) {
  const onChange = vi.fn();
  const onSettingsChange = vi.fn();
  act(() =>
    root.render(
      createElement(ModelPicker, {
        harness: "claude",
        model: "claude:opus-5-5",
        values,
        presetSlider: true,
        variant: "ghost",
        onChange,
        onSettingsChange,
        ...props,
      }),
    ),
  );
  const trigger = container.querySelector<HTMLButtonElement>(
    "button[data-model-picker-trigger]",
  )!;
  return { onChange, onSettingsChange, trigger };
}

function key(target: HTMLElement, value: string) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

const slider = () => container.querySelector<HTMLElement>('[role="slider"]');

describe("model picker presets", () => {
  it("opens the slider on the default presets", () => {
    const { trigger } = render();
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    act(() => trigger.click());

    const dialog = container.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="Model presets"]',
    )!;
    // Opens where the menu did, above the chip.
    expect(dialog.dataset.side).toBe("top");
    expect(dialog.dataset.anchorTrigger).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[role="menu"]')).toBeNull();
    // Sonnet Medium, Opus Medium, High, Max, Ultracode, Ultrathink.
    expect(slider()!.getAttribute("aria-valuemax")).toBe("5");
    expect(slider()!.getAttribute("aria-valuenow")).toBe("2");
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");

    act(() => trigger.click());
    expect(slider()).toBeNull();
  });

  it("shows a preset's own name while the session is on it", () => {
    saveModelPresets([
      {
        id: "a",
        harness: "claude",
        model: "claude:sonnet-5",
        effort: "low",
        label: "Quick",
      },
      {
        id: "b",
        harness: "claude",
        model: "claude:opus-5-5",
        effort: "high",
        label: "Deep",
      },
    ]);
    const { trigger } = render();
    act(() => trigger.click());
    expect(slider()!.getAttribute("aria-valuetext")).toBe("Deep High");
    // The chip keeps the model's real name.
    expect(trigger.textContent).toContain("Opus 5.5");
  });

  it("switches effort alone when the model stays", () => {
    const { trigger, onChange, onSettingsChange } = render();
    act(() => trigger.click());
    key(slider()!, "ArrowRight");
    expect(onChange).not.toHaveBeenCalled();
    expect(onSettingsChange).toHaveBeenCalledWith({
      effort: "max",
      fast: "true",
    });
  });

  it("switches the model first, then its settings", () => {
    const { trigger, onChange, onSettingsChange } = render();
    act(() => trigger.click());
    key(slider()!, "Home");
    expect(onChange).toHaveBeenCalledWith("claude", "claude:sonnet-5");
    expect(onSettingsChange).toHaveBeenCalledWith({ effort: "medium" });
    expect(onChange.mock.invocationCallOrder[0]).toBeLessThan(
      onSettingsChange.mock.invocationCallOrder[0],
    );
  });

  it("shows the session's tone at rest", () => {
    const { trigger } = render({}, { effort: "ultrathink" });
    act(() => trigger.click());
    expect(
      container.querySelector<HTMLElement>("[data-model-slider]")!.dataset
        .effortTone,
    ).toBe("ultrathink");
  });

  it("reaches the full menu from the slider's label", () => {
    const { trigger } = render();
    act(() => trigger.click());
    const label = container.querySelector<HTMLButtonElement>(
      'button[title="All models and settings"]',
    )!;
    act(() => label.click());
    expect(slider()).toBeNull();
    expect(
      container.querySelector('[role="menu"][aria-label="Model and settings"]'),
    ).not.toBeNull();
  });

  it("follows preset changes from Settings", () => {
    const { trigger } = render();
    act(() => trigger.click());
    act(() =>
      saveModelPresets([
        {
          id: "a",
          harness: "claude",
          model: "claude:opus-5-5",
          effort: "low",
        },
        {
          id: "b",
          harness: "claude",
          model: "claude:opus-5-5",
          effort: "high",
        },
      ]),
    );
    expect(slider()!.getAttribute("aria-valuemax")).toBe("1");
    expect(slider()!.getAttribute("aria-valuenow")).toBe("1");
  });

  it("keeps the menu while fewer than two presets can run", () => {
    saveModelPresets([
      { id: "a", harness: "claude", model: "claude:opus-5-5", effort: "max" },
      { id: "b", harness: "claude", model: "claude:gone", effort: "max" },
    ]);
    const { trigger } = render();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    act(() => trigger.click());
    expect(slider()).toBeNull();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("keeps the menu where no panel is wired", () => {
    const { trigger } = render({ presetSlider: false, variant: "pill" });
    act(() => trigger.click());
    expect(slider()).toBeNull();
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
  });

  it("draws the ghost chip without a fill, in the slider panel's faces", () => {
    const { trigger } = render();
    expect(trigger.className).not.toContain("bg-selection ");
    expect(trigger.className).toContain("hover:bg-selection");
    const [name, level] = trigger.querySelectorAll<HTMLElement>(
      "span.whitespace-nowrap, span.shrink-0.text-content\\/50",
    );
    expect(name.textContent).toBe("Opus 5.5");
    // The bundled mono at its one weight, the serif italic beside it, both
    // at one size, as in the panel.
    expect(name.className.split(/\s+/)).toEqual(
      expect.arrayContaining([
        "model-slider-model",
        "font-medium",
        "text-[12px]",
      ]),
    );
    expect(name.className).not.toContain("font-semibold");
    expect(level.textContent).toBe("High");
    expect(level.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["model-slider-effort", "italic", "text-[12px]"]),
    );
  });

  it("keeps other chips in the interface font", () => {
    const { trigger } = render({ variant: "pill" });
    expect(trigger.querySelector(".model-slider-model")).toBeNull();
    expect(trigger.querySelector(".model-slider-effort")).toBeNull();
  });

  it("marks the chip with the model family's icon, name kept", () => {
    const { trigger } = render();
    expect(trigger.dataset.modelFamily).toBe("opus");
    const icon = trigger.querySelector<SVGElement>("svg[data-model-icon]")!;
    expect(icon.dataset.modelIcon).toBe("opus");
    expect(icon.getAttribute("class")).toContain("model-family-mark");
    expect(trigger.textContent).toContain("Opus 5.5");

    act(() => trigger.click());
    const panel = container.querySelector<HTMLElement>("[data-model-slider]")!;
    expect(panel.dataset.modelFamily).toBe("opus");
    expect(
      panel.querySelector<SVGElement>("svg[data-model-icon]")!.dataset
        .modelIcon,
    ).toBe("opus");
  });

  it("follows the model to another family", () => {
    const { trigger } = render({ model: "claude:sonnet-5" }, { effort: "low" });
    expect(trigger.dataset.modelFamily).toBe("sonnet");
    expect(
      trigger.querySelector<SVGElement>("svg[data-model-icon]")!.dataset
        .modelIcon,
    ).toBe("sonnet");
  });

  it("leaves chips without the slider unmarked", () => {
    const { trigger } = render({ presetSlider: false, variant: "pill" });
    expect(trigger.hasAttribute("data-model-family")).toBe(false);
    expect(trigger.querySelector("svg[data-model-icon]")).toBeNull();
    expect(
      trigger.querySelector("span.shrink-0.text-content\\/50")?.textContent,
    ).toBe("High");
  });
});
