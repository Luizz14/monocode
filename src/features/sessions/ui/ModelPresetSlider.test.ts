// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const haptic = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/tauri/haptics", () => ({ performHaptic: haptic }));

import { ModelPresetSlider } from "./ModelPresetSlider";
import { resolvePresetSteps, stepCenter } from "../model/modelPresetSteps";
import type { AgentModel } from "../model/models";

const opus: AgentModel = {
  id: "claude:opus-5-5",
  harness: "claude",
  name: "Claude Opus 5.5",
  settings: [
    {
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
    },
  ],
};

const steps = resolvePresetSteps(
  ["low", "medium", "high", "max", "ultracode", "ultrathink"].map((effort) => ({
    id: effort,
    harness: "claude" as const,
    model: opus.id,
    effort,
  })),
  {
    find: (id) => (id === opus.id ? opus : undefined),
    resolve: () => opus,
    modelsFor: () => [opus],
    available: () => true,
  },
);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  haptic.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

type RenderProps = Partial<Parameters<typeof ModelPresetSlider>[0]>;

function render(props: RenderProps = {}) {
  const handlers = {
    onCommit: vi.fn(),
    onOpenModels: vi.fn(),
    onDone: vi.fn(),
  };
  act(() =>
    root.render(
      createElement(ModelPresetSlider, {
        steps,
        index: 2,
        modelLabel: "Opus 5.5",
        effortLabel: "High",
        haptics: true,
        ...handlers,
        ...props,
      }),
    ),
  );
  const track = container.querySelector<HTMLElement>('[role="slider"]')!;
  return { ...handlers, track };
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

function pointer(target: HTMLElement, type: string, clientX: number) {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 7,
        clientX,
      }),
    );
  });
}

function knobX(track: HTMLElement): string {
  return track.style.getPropertyValue("--knob-x");
}

const panel = () =>
  container.querySelector<HTMLElement>("[data-model-slider]")!;

describe("ModelPresetSlider", () => {
  it("shows the current choice on a rail with one dot per preset", () => {
    const { track } = render();
    expect(panel().textContent).toContain("Opus 5.5");
    expect(panel().textContent).toContain("High");
    expect(track.getAttribute("aria-valuemin")).toBe("0");
    expect(track.getAttribute("aria-valuemax")).toBe("5");
    expect(track.getAttribute("aria-valuenow")).toBe("2");
    expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");
    expect(container.querySelectorAll(".model-slider-dot")).toHaveLength(6);
    expect(knobX(track)).toBe(`${stepCenter(2, 6) - 18}px`);
    expect(panel().dataset.effortTone).toBeUndefined();
  });

  it("hides the knob when the session runs something else", () => {
    const { track } = render({ index: -1, effortLabel: "Extra High" });
    expect(track.hasAttribute("data-empty")).toBe(true);
    expect(track.hasAttribute("aria-valuenow")).toBe(false);
    expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 Extra High");
  });

  describe("keyboard", () => {
    it("steps with the arrows and jumps with Home and End", () => {
      const { track, onCommit } = render();
      key(track, "ArrowRight");
      key(track, "ArrowLeft");
      key(track, "Home");
      key(track, "End");
      key(track, "PageDown");
      expect(onCommit.mock.calls.map(([index]) => index)).toEqual([
        3, 1, 0, 5, 0,
      ]);
    });

    it("does not commit the step it is already on", () => {
      const { track, onCommit } = render({ index: 5 });
      key(track, "ArrowRight");
      key(track, "End");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("starts from the nearest end with no current step", () => {
      const { track, onCommit } = render({ index: -1 });
      key(track, "ArrowLeft");
      expect(onCommit).toHaveBeenCalledWith(5);
    });

    it("finishes on Enter and ignores other keys", () => {
      const { track, onCommit, onDone } = render();
      key(track, "a");
      key(track, "Enter");
      expect(onCommit).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("does not tick the trackpad from the keyboard", () => {
      const { track } = render();
      key(track, "ArrowRight");
      expect(haptic).not.toHaveBeenCalled();
    });
  });

  describe("drag", () => {
    it("previews each step it crosses and applies the last on release", () => {
      const { track, onCommit } = render();

      pointer(track, "pointerdown", stepCenter(2, 6));
      expect(track.hasAttribute("data-dragging")).toBe(true);
      expect(haptic).not.toHaveBeenCalled();

      // Halfway to the next dot the knob follows the pointer, still on High.
      pointer(track, "pointermove", stepCenter(2, 6) + 32);
      expect(knobX(track)).toBe(`${stepCenter(2, 6) + 32 - 18}px`);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");
      expect(haptic).not.toHaveBeenCalled();

      // Near the dot it is pulled onto it and takes its step.
      pointer(track, "pointermove", stepCenter(3, 6) - 12);
      expect(knobX(track)).toBe(`${stepCenter(3, 6) - 18}px`);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 Max");
      expect(panel().dataset.effortTone).toBe("max");
      expect(haptic).toHaveBeenCalledTimes(1);
      expect(haptic).toHaveBeenLastCalledWith("levelChange");

      pointer(track, "pointermove", stepCenter(3, 6) - 10);
      expect(haptic).toHaveBeenCalledTimes(1);

      pointer(track, "pointermove", stepCenter(4, 6));
      expect(panel().dataset.effortTone).toBe("ultracode");
      expect(container.querySelector(".model-slider-tiles")).not.toBeNull();
      expect(haptic).toHaveBeenCalledTimes(2);
      expect(onCommit).not.toHaveBeenCalled();

      pointer(track, "pointerup", stepCenter(4, 6));
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit).toHaveBeenCalledWith(4);
      expect(track.hasAttribute("data-dragging")).toBe(false);
    });

    it("holds a step between dots, even back toward the previous one", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      pointer(track, "pointermove", stepCenter(3, 6));
      pointer(track, "pointermove", stepCenter(2, 6) + 25);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 Max");
      pointer(track, "pointerup", stepCenter(2, 6) + 25);
      expect(onCommit).toHaveBeenCalledWith(3);
    });

    it("jumps to the nearest dot when the rail is pressed off the knob", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(4, 6) - 28);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 Ultracode");
      pointer(track, "pointerup", stepCenter(4, 6) - 28);
      expect(onCommit).toHaveBeenCalledWith(4);
    });

    it("keeps its step when the knob is grabbed off center", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6) + 16);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");
      expect(haptic).not.toHaveBeenCalled();
      pointer(track, "pointerup", stepCenter(2, 6) + 16);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("jumps to a clicked dot", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(5, 6));
      expect(panel().dataset.effortTone).toBe("ultrathink");
      expect(haptic).toHaveBeenCalledTimes(1);
      pointer(track, "pointerup", stepCenter(5, 6));
      expect(onCommit).toHaveBeenCalledWith(5);
    });

    it("clamps past either end of the rail", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      pointer(track, "pointermove", -200);
      expect(knobX(track)).toBe("0px");
      pointer(track, "pointerup", -200);
      expect(onCommit).toHaveBeenCalledWith(0);
    });

    it("keeps the session as is when released on its own step", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      pointer(track, "pointermove", stepCenter(4, 6));
      pointer(track, "pointermove", stepCenter(2, 6) + 6);
      pointer(track, "pointerup", stepCenter(2, 6) + 6);
      expect(onCommit).not.toHaveBeenCalled();
      expect(knobX(track)).toBe(`${stepCenter(2, 6) - 18}px`);
    });

    it("drops a cancelled drag", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      pointer(track, "pointermove", stepCenter(5, 6));
      pointer(track, "pointercancel", stepCenter(5, 6));
      expect(onCommit).not.toHaveBeenCalled();
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");
    });

    it("ignores moves from another pointer and keys mid-drag", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      act(() => {
        track.dispatchEvent(
          new PointerEvent("pointermove", {
            bubbles: true,
            pointerId: 9,
            clientX: stepCenter(5, 6),
          }),
        );
      });
      key(track, "End");
      expect(track.getAttribute("aria-valuenow")).toBe("2");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("stays still when haptics are off", () => {
      const { track } = render({ haptics: false });
      pointer(track, "pointerdown", stepCenter(0, 6));
      pointer(track, "pointermove", stepCenter(5, 6));
      expect(haptic).not.toHaveBeenCalled();
    });
  });

  it("lights the rail for the current top level at rest", () => {
    render({ index: 3, effortLabel: "Max", tone: "max" });
    expect(panel().dataset.effortTone).toBe("max");
    expect(container.querySelector(".model-slider-tiles")).not.toBeNull();
    expect(container.querySelector(".model-slider-ripple")).not.toBeNull();
  });

  it("shows the focus ring only once the keyboard drives it", () => {
    const { track } = render();
    expect(track.hasAttribute("data-focus-ring")).toBe(false);
    key(track, "ArrowRight");
    expect(track.hasAttribute("data-focus-ring")).toBe(true);
    pointer(track, "pointerdown", stepCenter(2, 6));
    expect(track.hasAttribute("data-focus-ring")).toBe(false);
    act(() => root.unmount());
    root = createRoot(container);
    expect(
      render({ keyboard: true }).track.hasAttribute("data-focus-ring"),
    ).toBe(true);
  });

  it("opens the full menu from the label", () => {
    const { onOpenModels } = render();
    const label = container.querySelector<HTMLButtonElement>(
      'button[title="All models and settings"]',
    )!;
    act(() => label.click());
    expect(onOpenModels).toHaveBeenCalledTimes(1);
  });
});
