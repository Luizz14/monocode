import type { ModelPreset } from "../../settings/model/modelPresets";
import {
  mergeModelSettings,
  modelEffortSetting,
  type AgentModel,
  type ModelSetting,
} from "./models";
import type { HarnessId } from "./session";

/** Effort levels that light the slider up, after the Max row in the effort menu. */
export type EffortTone = "max" | "ultracode" | "ultrathink";

/** A preset resolved against the live catalog, ready to show and apply. */
export type PresetStep = {
  preset: ModelPreset;
  model: AgentModel;
  /** Present when the model has an effort setting and the preset picks a level. */
  effortSetting?: ModelSetting;
  effort?: string;
  modelLabel: string;
  effortLabel?: string;
  tone?: EffortTone;
};

/** The parts of a `ModelSource` presets resolve against. */
export type PresetModelSource = {
  find(id: string): AgentModel | undefined;
  resolve(harness: HarnessId, id?: string): AgentModel;
  modelsFor(harness: HarnessId): AgentModel[];
  available(harness: HarnessId): boolean;
};

/** Claude models drop the family prefix, as in the composer chip. */
export function shortModelName(model: AgentModel): string {
  return model.harness === "claude"
    ? model.name.replace(/^Claude /, "")
    : model.name;
}

export function effortTone(value: string | undefined): EffortTone | undefined {
  switch (value?.toLowerCase()) {
    case "max":
      return "max";
    case "ultracode":
      return "ultracode";
    case "ultrathink":
      return "ultrathink";
    default:
      return undefined;
  }
}

/** The catalog model a preset names, or undefined when the catalog no longer lists it. */
export function resolvePresetModel(
  preset: Pick<ModelPreset, "harness" | "model">,
  source: PresetModelSource,
): AgentModel | undefined {
  const exact = source.find(preset.model);
  if (exact?.harness === preset.harness) return exact;
  // `resolve` also matches a saved id against native ids, but it falls back
  // to the harness default for anything unknown; that must not stand in for
  // a model that is gone.
  const resolved = source.resolve(preset.harness, preset.model);
  const wanted = comparableId(preset.model);
  const same = [resolved.id, resolved.nativeId, resolved.aliasTarget].some(
    (id) => id != null && comparableId(id) === wanted,
  );
  return same &&
    source.modelsFor(preset.harness).some((model) => model.id === resolved.id)
    ? resolved
    : undefined;
}

/** `claude:opus-5-5`, `claude-opus-5-5`, and `opus-5-5` compare equal. */
function comparableId(id: string): string {
  return id
    .slice(id.indexOf(":") + 1)
    .replace(/^claude-/, "")
    .toLowerCase();
}

/**
 * Presets the slider can offer right now, in their saved order. A preset is
 * left out when its provider is unavailable or not allowed here, its model is
 * gone from the catalog, or the model no longer offers its effort level.
 * Two presets that resolve to the same model and effort keep only the first.
 */
export function resolvePresetSteps(
  presets: readonly ModelPreset[],
  source: PresetModelSource,
  allowed: (harness: HarnessId) => boolean = () => true,
): PresetStep[] {
  const steps: PresetStep[] = [];
  const seen = new Set<string>();
  for (const preset of presets) {
    if (!allowed(preset.harness) || !source.available(preset.harness)) {
      continue;
    }
    const model = resolvePresetModel(preset, source);
    if (!model) continue;
    const setting = modelEffortSetting(model);
    const option = preset.effort
      ? setting?.options.find((item) => item.value === preset.effort)
      : undefined;
    if (preset.effort && setting && !option) continue;
    const key = `${model.harness}\u0000${model.id}\u0000${option?.value ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({
      preset,
      model,
      effortSetting: option ? setting : undefined,
      effort: option?.value,
      modelLabel: shortModelName(model),
      effortLabel: option?.label,
      tone: effortTone(option?.value),
    });
  }
  return steps;
}

/**
 * The step matching the session's model and effort, or -1. A step with an
 * effort level wins over a model-only step for the same model.
 */
export function currentStepIndex(
  steps: readonly PresetStep[],
  model: Pick<AgentModel, "id" | "harness">,
  values: Record<string, string>,
): number {
  const sameModel = (step: PresetStep) =>
    step.model.harness === model.harness && step.model.id === model.id;
  const exact = steps.findIndex(
    (step) =>
      sameModel(step) &&
      step.effortSetting != null &&
      (values[step.effortSetting.id] ?? step.effortSetting.value) ===
        step.effort,
  );
  if (exact >= 0) return exact;
  return steps.findIndex(
    (step) => sameModel(step) && step.effortSetting == null,
  );
}

/**
 * Settings to send with a step's model: what carries over from the current
 * values (fast mode, context window), with the step's effort on top.
 */
export function presetStepSettings(
  step: PresetStep,
  values: Record<string, string>,
): Record<string, string> {
  const next = mergeModelSettings(step.model, values);
  if (step.effortSetting && step.effort != null) {
    next[step.effortSetting.id] = step.effort;
  }
  return next;
}

/**
 * A preset to add next in Settings: the last preset's model one effort level
 * up, wrapping around, then the first model and effort no preset uses yet.
 */
export function suggestModelPreset(
  presets: readonly ModelPreset[],
  models: readonly AgentModel[],
): Omit<ModelPreset, "id"> | undefined {
  const key = (harness: HarnessId, model: string, effort: string) =>
    `${harness}\u0000${model}\u0000${effort}`;
  const used = new Set(
    presets.map((preset) => key(preset.harness, preset.model, preset.effort)),
  );
  const last = presets[presets.length - 1];
  const lastModel = last
    ? models.find(
        (model) => model.harness === last.harness && model.id === last.model,
      )
    : undefined;
  const ordered = lastModel ? [lastModel, ...models] : models;
  for (const model of ordered) {
    const values = modelEffortSetting(model)?.options.map(
      (option) => option.value,
    ) ?? [""];
    const start =
      model === lastModel ? values.indexOf(last?.effort ?? "") + 1 : 0;
    for (const effort of [...values.slice(start), ...values.slice(0, start)]) {
      if (!used.has(key(model.harness, model.id, effort))) {
        return { harness: model.harness, model: model.id, effort };
      }
    }
  }
  return undefined;
}

/** Track geometry from the design: a 342px rail and a 36px knob. */
export const SLIDER_TRACK_WIDTH = 342;
export const SLIDER_KNOB_SIZE = 36;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Horizontal center of a step's dot, from the track's left edge. */
export function stepCenter(
  index: number,
  count: number,
  trackWidth = SLIDER_TRACK_WIDTH,
  knobSize = SLIDER_KNOB_SIZE,
): number {
  if (count <= 1) return trackWidth / 2;
  const span = trackWidth - knobSize;
  return knobSize / 2 + (clamp(index, 0, count - 1) * span) / (count - 1);
}

/** The step nearest a pointer at `x` pixels from the track's left edge. */
export function stepAt(
  x: number,
  count: number,
  trackWidth = SLIDER_TRACK_WIDTH,
  knobSize = SLIDER_KNOB_SIZE,
): number {
  if (count <= 1) return 0;
  const span = trackWidth - knobSize;
  const ratio = (x - knobSize / 2) / span;
  return clamp(Math.round(ratio * (count - 1)), 0, count - 1);
}

/** Knob's left offset while it follows a pointer, kept on the track. */
export function knobOffsetAt(
  x: number,
  trackWidth = SLIDER_TRACK_WIDTH,
  knobSize = SLIDER_KNOB_SIZE,
): number {
  return clamp(x - knobSize / 2, 0, trackWidth - knobSize);
}

/**
 * The step a key moves to, or null for keys the slider ignores. From no
 * selection, the first move lands on the nearest end.
 */
export function stepForKey(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return index < 0 ? 0 : Math.min(last, index + 1);
    case "ArrowLeft":
    case "ArrowDown":
      return index < 0 ? last : Math.max(0, index - 1);
    case "PageUp":
      return index < 0 ? 0 : Math.min(last, index + 2);
    case "PageDown":
      return index < 0 ? last : Math.max(0, index - 2);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}
