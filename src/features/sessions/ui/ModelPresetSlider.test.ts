// @vitest-environment happy-dom
import { act, createElement, Profiler } from "react";
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

// Animation frames run only when a test asks, on a 60fps clock.
let frameQueue = new Map<number, FrameRequestCallback>();
let frameId = 0;
let clock = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frameQueue = new Map();
  frameId = 0;
  clock = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameId += 1;
    frameQueue.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frameQueue.delete(id);
  });
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

/** Runs animation frames for `ms`, calling `onFrame` after each. */
function frames(ms: number, onFrame?: () => void) {
  const end = clock + ms;
  while (clock < end && frameQueue.size > 0) {
    clock += 1000 / 60;
    const due = [...frameQueue.values()];
    frameQueue.clear();
    act(() => due.forEach((callback) => callback(clock)));
    onFrame?.();
  }
}

/** Lets the knob finish gliding or springing. */
const settle = () => frames(2000);

/** The knob's center, read back from its transform. */
function knobCenter(): number {
  const knob = container.querySelector<HTMLElement>(".model-slider-knob")!;
  const match = /translate3d\((-?[\d.]+)px/.exec(knob.style.transform);
  return Number(match?.[1]) + 18;
}

/** Where the fill ends, read back from its clip. */
function fillEdge(): number {
  const fill = container.querySelector<HTMLElement>(".model-slider-fill")!;
  const match = /inset\(0(?:px)? (-?[\d.]+)px/.exec(fill.style.clipPath);
  return 342 - Number(match?.[1]);
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
    expect(knobCenter()).toBe(stepCenter(2, 6));
    expect(fillEdge()).toBe(stepCenter(2, 6));
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
      settle();
      expect(knobCenter()).toBeCloseTo(stepCenter(2, 6) + 32, 6);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 High");
      expect(haptic).not.toHaveBeenCalled();

      // Near the dot it is pulled onto it and takes its step.
      pointer(track, "pointermove", stepCenter(3, 6) - 12);
      settle();
      expect(knobCenter()).toBeCloseTo(stepCenter(3, 6), 6);
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
      pointer(track, "pointerdown", stepCenter(4, 6) - 24);
      expect(track.getAttribute("aria-valuetext")).toBe("Opus 5.5 Ultracode");
      pointer(track, "pointerup", stepCenter(4, 6) - 24);
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

    it("jumps to a clicked dot without a tick", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(5, 6));
      expect(panel().dataset.effortTone).toBe("ultrathink");
      pointer(track, "pointerup", stepCenter(5, 6));
      expect(onCommit).toHaveBeenCalledWith(5);
      expect(haptic).not.toHaveBeenCalled();
    });

    it("does not tick for a click on the rail between dots", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(4, 6) - 24);
      pointer(track, "pointerup", stepCenter(4, 6) - 24);
      expect(onCommit).toHaveBeenCalledWith(4);
      expect(haptic).not.toHaveBeenCalled();
    });

    it("ticks once per step a drag crosses after a jumping press", () => {
      const { track } = render();
      pointer(track, "pointerdown", stepCenter(0, 6));
      expect(haptic).not.toHaveBeenCalled();
      pointer(track, "pointermove", stepCenter(1, 6));
      pointer(track, "pointermove", stepCenter(1, 6) + 3);
      pointer(track, "pointermove", stepCenter(2, 6));
      expect(haptic).toHaveBeenCalledTimes(2);
    });

    it("clamps past either end of the rail", () => {
      const { track, onCommit } = render();
      pointer(track, "pointerdown", stepCenter(2, 6));
      pointer(track, "pointermove", -200);
      settle();
      expect(knobCenter()).toBeCloseTo(stepCenter(0, 6), 6);
      // The first step leaves fill showing left of the knob.
      expect(knobCenter() - 18).toBe(30);
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
      settle();
      expect(knobCenter()).toBeCloseTo(stepCenter(2, 6), 6);
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

  it("draws the model family's icon and the one being dragged over", () => {
    const sonnet: AgentModel = {
      ...opus,
      id: "claude:sonnet-4.6",
      name: "Claude Sonnet 4.6",
    };
    const mixed = resolvePresetSteps(
      [
        { id: "s", harness: "claude", model: sonnet.id, effort: "low" },
        { id: "o", harness: "claude", model: opus.id, effort: "high" },
      ],
      {
        find: (id) => [opus, sonnet].find((model) => model.id === id),
        resolve: () => opus,
        modelsFor: () => [opus, sonnet],
        available: () => true,
      },
    );
    const { track } = render({
      steps: mixed,
      index: 1,
      family: mixed[1].family,
    });
    const icon = () =>
      panel().querySelector<SVGElement>("svg[data-model-icon]")!.dataset
        .modelIcon;
    expect(panel().dataset.modelFamily).toBe("opus");
    expect(panel().hasAttribute("data-model-legacy")).toBe(false);
    expect(icon()).toBe("opus");
    // The model stays in words beside the icon.
    expect(panel().textContent).toContain("Opus 5.5");

    pointer(track, "pointerdown", stepCenter(1, 2));
    pointer(track, "pointermove", stepCenter(0, 2));
    expect(panel().dataset.modelFamily).toBe("sonnet");
    expect(panel().hasAttribute("data-model-legacy")).toBe(true);
    expect(icon()).toBe("sonnet");
    expect(panel().textContent).toContain("Sonnet 4.6");
    pointer(track, "pointercancel", stepCenter(0, 2));
    expect(icon()).toBe("opus");
  });

  it("keeps a neutral globe for a model outside the families", () => {
    render({ index: -1, modelLabel: "GPT-5.5", effortLabel: "Minimal" });
    expect(panel().hasAttribute("data-model-family")).toBe(false);
    expect(
      panel().querySelector<SVGElement>("svg[data-model-icon]")!.dataset
        .modelIcon,
    ).toBe("none");
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

describe("ModelPresetSlider motion", () => {
  it("ends the fill at the knob's center on every frame", () => {
    const { track } = render();
    const gaps: number[] = [];
    const measure = () => gaps.push(Math.abs(knobCenter() - fillEdge()));
    pointer(track, "pointerdown", stepCenter(2, 6));
    for (const x of [175, 196, 230, 262, 300, 120, 60]) {
      pointer(track, "pointermove", x);
      frames(48, measure);
    }
    pointer(track, "pointerup", 60);
    frames(600, measure);
    expect(gaps.length).toBeGreaterThan(40);
    expect(Math.max(...gaps)).toBeLessThan(1e-9);
  });

  it("glides after the pointer instead of jumping", () => {
    const { track } = render();
    const from = stepCenter(2, 6);
    const to = stepCenter(2, 6) + 32;
    pointer(track, "pointerdown", from);
    pointer(track, "pointermove", to);
    // Nothing moves until a frame runs, and one frame covers part of the way.
    expect(knobCenter()).toBe(from);
    frames(1000 / 60);
    expect(knobCenter()).toBeGreaterThan(from);
    expect(knobCenter()).toBeLessThan(to);
    // Within about 1px of the pointer after 100ms.
    frames(100);
    expect(to - knobCenter()).toBeLessThan(1);
  });

  it("springs onto the dot on release, a little past it and back", () => {
    const { track, onCommit } = render();
    pointer(track, "pointerdown", stepCenter(2, 6));
    pointer(track, "pointermove", stepCenter(3, 6));
    // Held on Max with the pointer between dots, then let go.
    pointer(track, "pointermove", stepCenter(3, 6) + 25);
    settle();
    pointer(track, "pointerup", stepCenter(3, 6) + 25);
    expect(onCommit).toHaveBeenCalledWith(3);
    // The parent applies the step, as the composer does.
    render({ index: 3, effortLabel: "Max", tone: "max" });
    const path: number[] = [];
    frames(1000, () => path.push(knobCenter()));
    const target = stepCenter(3, 6);
    expect(Math.min(...path)).toBeLessThan(target - 0.5);
    expect(Math.min(...path)).toBeGreaterThan(target - 6);
    expect(knobCenter()).toBe(target);
  });

  it("springs to a step chosen from the keyboard", () => {
    const view = render();
    key(view.track, "ArrowRight");
    render({ index: 3, effortLabel: "Max", tone: "max" });
    expect(knobCenter()).toBe(stepCenter(2, 6));
    frames(1000 / 60);
    expect(knobCenter()).toBeGreaterThan(stepCenter(2, 6));
    settle();
    expect(knobCenter()).toBe(stepCenter(3, 6));
  });

  it("only jumps from step to step under reduced motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    const { track } = render();
    frames(100);
    const requested = frameId;
    pointer(track, "pointerdown", stepCenter(2, 6));
    pointer(track, "pointermove", stepCenter(2, 6) + 32);
    // Between dots the knob stays on its step.
    expect(knobCenter()).toBe(stepCenter(2, 6));
    pointer(track, "pointermove", stepCenter(3, 6) - 12);
    expect(knobCenter()).toBe(stepCenter(3, 6));
    expect(fillEdge()).toBe(stepCenter(3, 6));
    pointer(track, "pointerup", stepCenter(3, 6) - 12);
    render({ index: 3, effortLabel: "Max", tone: "max" });
    expect(knobCenter()).toBe(stepCenter(3, 6));
    // No animation frame was ever asked for.
    expect(frameId).toBe(requested);
  });

  it("renders only when the drag crosses into another step", () => {
    let renders = 0;
    const handlers = {
      onCommit: vi.fn(),
      onOpenModels: vi.fn(),
      onDone: vi.fn(),
    };
    act(() =>
      root.render(
        createElement(
          Profiler,
          { id: "slider", onRender: () => (renders += 1) },
          createElement(ModelPresetSlider, {
            steps,
            index: 2,
            modelLabel: "Opus 5.5",
            effortLabel: "High",
            haptics: true,
            ...handlers,
          }),
        ),
      ),
    );
    const track = container.querySelector<HTMLElement>('[role="slider"]')!;
    pointer(track, "pointerdown", stepCenter(2, 6));
    const afterPress = renders;
    for (const x of [161, 165, 170, 175, 180, 185, 190]) {
      pointer(track, "pointermove", x);
      frames(32);
    }
    expect(renders).toBe(afterPress);
    pointer(track, "pointermove", stepCenter(3, 6));
    expect(renders).toBe(afterPress + 1);
  });
});
