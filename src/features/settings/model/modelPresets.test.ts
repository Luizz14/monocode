// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_PRESETS,
  loadModelPresets,
  loadModelSliderHaptics,
  MODEL_PRESET_LIMIT,
  parseModelPresets,
  resetModelPresets,
  saveModelPresets,
  saveModelSliderHaptics,
  subscribeModelPresets,
  subscribeModelSliderHaptics,
  type ModelPreset,
} from "./modelPresets";

const opusHigh: ModelPreset = {
  id: "a",
  harness: "claude",
  model: "claude:opus-5-5",
  effort: "high",
};

beforeEach(() => {
  localStorage.clear();
});

describe("parseModelPresets", () => {
  it("rejects values that are not a list", () => {
    expect(parseModelPresets(null)).toBeNull();
    expect(parseModelPresets({ presets: [] })).toBeNull();
    expect(parseModelPresets("[]")).toBeNull();
  });

  it("keeps well-formed entries and drops the rest", () => {
    expect(
      parseModelPresets([
        opusHigh,
        { id: "b", harness: "nope", model: "x", effort: "" },
        { id: "c", harness: "codex", model: "  ", effort: "" },
        { id: "d", harness: "codex", model: "codex:gpt-5.5" },
        "claude:opus",
        null,
      ]),
    ).toEqual([
      opusHigh,
      { id: "d", harness: "codex", model: "codex:gpt-5.5", effort: "" },
    ]);
  });

  it("keeps repeated choices and repairs missing or repeated ids", () => {
    expect(
      parseModelPresets([
        opusHigh,
        { ...opusHigh, id: "other" },
        { ...opusHigh, id: "a", effort: "max" },
        { harness: "claude", model: "claude:sonnet-5", effort: "low" },
      ]),
    ).toEqual([
      opusHigh,
      { ...opusHigh, id: "other" },
      { ...opusHigh, id: "a-3", effort: "max" },
      {
        id: "preset-4",
        harness: "claude",
        model: "claude:sonnet-5",
        effort: "low",
      },
    ]);
  });

  it("keeps a trimmed, capped name and drops an empty one", () => {
    const [named, blank] = parseModelPresets([
      { ...opusHigh, label: "  Deep work  " },
      { ...opusHigh, id: "b", label: "   " },
    ])!;
    expect(named.label).toBe("Deep work");
    expect(blank).not.toHaveProperty("label");
    expect(
      parseModelPresets([{ ...opusHigh, label: "x".repeat(80) }])![0].label,
    ).toHaveLength(32);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MODEL_PRESET_LIMIT + 4 }, (_, i) => ({
      id: `p${i}`,
      harness: "claude",
      model: `claude:model-${i}`,
      effort: "",
    }));
    expect(parseModelPresets(many)).toHaveLength(MODEL_PRESET_LIMIT);
  });
});

describe("persistence", () => {
  it("starts from the defaults", () => {
    expect(loadModelPresets()).toBe(DEFAULT_MODEL_PRESETS);
    expect(DEFAULT_MODEL_PRESETS).toHaveLength(6);
    expect(parseModelPresets(DEFAULT_MODEL_PRESETS)).toEqual(
      DEFAULT_MODEL_PRESETS,
    );
  });

  it("round-trips a saved list and returns a stable snapshot", () => {
    saveModelPresets([opusHigh]);
    const first = loadModelPresets();
    expect(first).toEqual([opusHigh]);
    expect(loadModelPresets()).toBe(first);
  });

  it("keeps an empty list instead of restoring the defaults", () => {
    saveModelPresets([]);
    expect(loadModelPresets()).toEqual([]);
  });

  it("falls back to the defaults for corrupt storage", () => {
    localStorage.setItem("monocode.modelPresets", "{not json");
    expect(loadModelPresets()).toBe(DEFAULT_MODEL_PRESETS);
    localStorage.setItem("monocode.modelPresets", '{"a":1}');
    expect(loadModelPresets()).toBe(DEFAULT_MODEL_PRESETS);
  });

  it("resets to the defaults", () => {
    saveModelPresets([opusHigh]);
    resetModelPresets();
    expect(loadModelPresets()).toBe(DEFAULT_MODEL_PRESETS);
  });

  it("notifies subscribers on save, reset, and other windows", () => {
    const listener = vi.fn();
    const stop = subscribeModelPresets(listener);
    saveModelPresets([opusHigh]);
    resetModelPresets();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "monocode.modelPresets" }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    saveModelPresets([]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("stores the haptics toggle, on by default", () => {
    const listener = vi.fn();
    const stop = subscribeModelSliderHaptics(listener);
    expect(loadModelSliderHaptics()).toBe(true);
    saveModelSliderHaptics(false);
    expect(loadModelSliderHaptics()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });
});
