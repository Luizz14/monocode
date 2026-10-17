import { describe, expect, it } from "vitest";
import type { ModelPreset } from "../../settings/model/modelPresets";
import {
  currentStepIndex,
  effortTone,
  knobOffsetAt,
  presetStepSettings,
  resolvePresetSteps,
  shortModelName,
  stepAt,
  stepCenter,
  stepForKey,
  dragStepAt,
  snapRadius,
  suggestModelPreset,
  type PresetModelSource,
} from "./modelPresetSteps";
import type { AgentModel, ModelSetting } from "./models";
import type { HarnessId } from "./session";

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

const opus: AgentModel = {
  id: "claude:opus-5-5",
  harness: "claude",
  name: "Claude Opus 5.5",
  settings: [effort, fast],
};
const sonnet: AgentModel = {
  id: "claude:sonnet-5",
  harness: "claude",
  name: "Claude Sonnet 5",
  settings: [{ ...effort, options: effort.options.slice(0, 4) }],
};
const gpt: AgentModel = {
  id: "codex:gpt-5.5",
  harness: "codex",
  name: "GPT-5.5",
  settings: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      kind: "select",
      value: "medium",
      options: [
        { value: "medium", label: "Medium" },
        { value: "xhigh", label: "Extra High" },
      ],
    },
  ],
};
const plain: AgentModel = {
  id: "cursor:auto",
  harness: "cursor",
  name: "Auto",
};

function source(
  models: AgentModel[],
  unavailable: HarnessId[] = [],
): PresetModelSource {
  return {
    find: (id) => models.find((model) => model.id === id),
    resolve: (harness, id) =>
      models.find((model) => model.harness === harness && model.id === id) ??
      models.find((model) => model.harness === harness) ?? {
        id: id ?? "",
        harness,
        name: id ?? "",
      },
    modelsFor: (harness) => models.filter((model) => model.harness === harness),
    available: (harness) => !unavailable.includes(harness),
  };
}

function preset(
  model: string,
  effortValue = "",
  harness: HarnessId = "claude",
): ModelPreset {
  return { id: `${model}-${effortValue}`, harness, model, effort: effortValue };
}

const catalog = source([opus, sonnet, gpt, plain]);

describe("resolvePresetSteps", () => {
  it("labels each step with the short model name and effort label", () => {
    const steps = resolvePresetSteps(
      [preset(opus.id, "medium"), preset(gpt.id, "xhigh", "codex")],
      catalog,
    );
    expect(
      steps.map((step) => [step.modelLabel, step.effortLabel, step.tone]),
    ).toEqual([
      ["Opus 5.5", "Medium", undefined],
      ["GPT-5.5", "Extra High", undefined],
    ]);
    expect(steps[1].effortSetting?.id).toBe("reasoningEffort");
  });

  it("marks Max, Ultracode, and Ultrathink with their tone", () => {
    const steps = resolvePresetSteps(
      ["high", "max", "ultracode", "ultrathink"].map((value) =>
        preset(opus.id, value),
      ),
      catalog,
    );
    expect(steps.map((step) => step.tone)).toEqual([
      undefined,
      "max",
      "ultracode",
      "ultrathink",
    ]);
  });

  it("skips what the catalog cannot run and repeated choices", () => {
    const steps = resolvePresetSteps(
      [
        preset(opus.id, "high"),
        preset("claude:gone", "high"),
        preset(sonnet.id, "ultracode"),
        preset(opus.id, "high"),
        preset(gpt.id, "medium", "codex"),
        preset(plain.id, "", "cursor"),
      ],
      source([opus, sonnet, gpt, plain], ["codex"]),
    );
    expect(steps.map((step) => step.preset.model)).toEqual([opus.id, plain.id]);
  });

  it("finds a model by native id but never by the default fallback", () => {
    const live = {
      ...opus,
      id: "claude:live-opus",
      nativeId: "claude-opus-5-5",
    };
    const fallback: PresetModelSource = {
      ...source([live, sonnet]),
      resolve: (_harness, id) => (id === "claude:opus-5-5" ? live : sonnet),
    };
    const steps = resolvePresetSteps(
      [preset("claude:opus-5-5", "high"), preset("claude:gone", "high")],
      fallback,
    );
    expect(steps.map((step) => step.model.id)).toEqual(["claude:live-opus"]);
  });

  it("filters by the harnesses a surface allows", () => {
    const steps = resolvePresetSteps(
      [preset(opus.id, "high"), preset(gpt.id, "medium", "codex")],
      catalog,
      (harness) => harness === "codex",
    );
    expect(steps.map((step) => step.model.id)).toEqual([gpt.id]);
  });

  it("shows a preset's own name instead of the model's", () => {
    const [named, plainName] = resolvePresetSteps(
      [
        { ...preset(opus.id, "max"), label: "  Big brain  " },
        { ...preset(opus.id, "low"), label: "   " },
      ],
      catalog,
    );
    expect(named.modelLabel).toBe("Big brain");
    expect(plainName.modelLabel).toBe("Opus 5.5");
  });

  it("keeps model-only presets for models without an effort setting", () => {
    const [step] = resolvePresetSteps(
      [preset(plain.id, "high", "cursor")],
      catalog,
    );
    expect(step.effortSetting).toBeUndefined();
    expect(step.effortLabel).toBeUndefined();
  });
});

describe("currentStepIndex", () => {
  const steps = resolvePresetSteps(
    [
      preset(opus.id),
      preset(opus.id, "medium"),
      preset(opus.id, "max"),
      preset(sonnet.id, "low"),
    ],
    catalog,
  );

  it("matches model and effort, preferring a step with the effort", () => {
    expect(currentStepIndex(steps, opus, { effort: "max" })).toBe(2);
    expect(currentStepIndex(steps, opus, { effort: "medium" })).toBe(1);
    expect(currentStepIndex(steps, sonnet, { effort: "low" })).toBe(3);
  });

  it("falls back to a model-only step, then to none", () => {
    expect(currentStepIndex(steps, opus, { effort: "low" })).toBe(0);
    expect(currentStepIndex(steps, sonnet, { effort: "high" })).toBe(-1);
    expect(currentStepIndex(steps, gpt, {})).toBe(-1);
  });

  it("reads the setting default when the value is unset", () => {
    const highOnly = resolvePresetSteps([preset(opus.id, "high")], catalog);
    expect(currentStepIndex(highOnly, opus, {})).toBe(0);
  });
});

describe("presetStepSettings", () => {
  it("carries compatible values over and applies the effort", () => {
    const [step] = resolvePresetSteps([preset(opus.id, "ultrathink")], catalog);
    expect(
      presetStepSettings(step, {
        effort: "low",
        fast: "true",
        reasoningEffort: "xhigh",
      }),
    ).toEqual({ effort: "ultrathink", fast: "true" });
  });

  it("uses the model defaults for a model-only step", () => {
    const [step] = resolvePresetSteps([preset(opus.id)], catalog);
    expect(presetStepSettings(step, {})).toEqual({
      effort: "high",
      fast: "false",
    });
  });
});

describe("track geometry", () => {
  it("places six dots where the design does", () => {
    expect(
      Array.from({ length: 6 }, (_, i) => stepCenter(i, 6)).map((x) =>
        Number(x.toFixed(1)),
      ),
    ).toEqual([18, 79.2, 140.4, 201.6, 262.8, 324]);
    expect(stepCenter(0, 1)).toBe(171);
  });

  it("maps a pointer to the nearest step, clamped to the ends", () => {
    expect(stepAt(-40, 6)).toBe(0);
    expect(stepAt(18, 6)).toBe(0);
    expect(stepAt(48, 6)).toBe(0);
    expect(stepAt(50, 6)).toBe(1);
    expect(stepAt(140, 6)).toBe(2);
    expect(stepAt(400, 6)).toBe(5);
    expect(stepAt(100, 1)).toBe(0);
  });

  it("round-trips every step center", () => {
    for (const count of [2, 3, 6, 10]) {
      for (let i = 0; i < count; i += 1) {
        expect(stepAt(stepCenter(i, count), count)).toBe(i);
      }
    }
  });

  it("lands on a dot only near it", () => {
    expect(snapRadius(6)).toBeCloseTo(19.58, 1);
    expect(snapRadius(2)).toBe(22);
    expect(snapRadius(10)).toBe(10.88);
    const center = stepCenter(3, 6);
    expect(dragStepAt(center + 19, 1, 6)).toEqual({ index: 3, center });
    expect(dragStepAt(center + 25, 1, 6)).toEqual({
      index: 1,
      center: center + 25,
    });
    expect(dragStepAt(-50, 3, 6)).toEqual({ index: 0, center: 18 });
    expect(dragStepAt(900, 0, 6)).toEqual({ index: 5, center: 324 });
    expect(dragStepAt(100, -1, 0)).toEqual({ index: -1, center: 100 });
  });

  it("keeps the knob on the track", () => {
    expect(knobOffsetAt(0)).toBe(0);
    expect(knobOffsetAt(100)).toBe(82);
    expect(knobOffsetAt(500)).toBe(306);
  });
});

describe("stepForKey", () => {
  it("steps with arrows and pages, jumps with Home and End", () => {
    expect(stepForKey("ArrowRight", 2, 6)).toBe(3);
    expect(stepForKey("ArrowUp", 5, 6)).toBe(5);
    expect(stepForKey("ArrowLeft", 0, 6)).toBe(0);
    expect(stepForKey("ArrowDown", 3, 6)).toBe(2);
    expect(stepForKey("PageUp", 3, 6)).toBe(5);
    expect(stepForKey("PageDown", 1, 6)).toBe(0);
    expect(stepForKey("Home", 4, 6)).toBe(0);
    expect(stepForKey("End", 1, 6)).toBe(5);
  });

  it("lands on the nearest end from no selection", () => {
    expect(stepForKey("ArrowRight", -1, 6)).toBe(0);
    expect(stepForKey("ArrowLeft", -1, 6)).toBe(5);
  });

  it("ignores other keys and empty tracks", () => {
    expect(stepForKey("a", 1, 6)).toBeNull();
    expect(stepForKey("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("labels", () => {
  it("shortens Claude names only", () => {
    expect(shortModelName(opus)).toBe("Opus 5.5");
    expect(shortModelName(gpt)).toBe("GPT-5.5");
  });

  it("tones only the top levels", () => {
    expect(effortTone("MAX")).toBe("max");
    expect(effortTone("xhigh")).toBeUndefined();
    expect(effortTone(undefined)).toBeUndefined();
  });
});

describe("suggestModelPreset", () => {
  it("steps the last preset's model up one effort level", () => {
    expect(
      suggestModelPreset([preset(opus.id, "high")], [sonnet, opus]),
    ).toEqual({ harness: "claude", model: opus.id, effort: "max" });
  });

  it("wraps around, then moves on to other models", () => {
    const opusAll = effort.options.map((option) =>
      preset(opus.id, option.value),
    );
    expect(
      suggestModelPreset(
        [preset(opus.id, "low"), preset(opus.id, "ultrathink")],
        [opus],
      ),
    ).toEqual({ harness: "claude", model: opus.id, effort: "medium" });
    expect(suggestModelPreset(opusAll, [opus, plain])).toEqual({
      harness: "cursor",
      model: plain.id,
      effort: "",
    });
  });

  it("starts from the first model when there are no presets", () => {
    expect(suggestModelPreset([], [sonnet, opus])).toEqual({
      harness: "claude",
      model: sonnet.id,
      effort: "low",
    });
  });

  it("returns nothing once every choice is taken", () => {
    expect(
      suggestModelPreset([preset(plain.id, "", "cursor")], [plain]),
    ).toBeUndefined();
  });
});
