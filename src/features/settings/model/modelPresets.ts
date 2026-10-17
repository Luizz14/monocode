import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { readFlag, writeFlag } from "./storageFlags";

/** One stop on the composer's model slider: a model and the effort it runs at. */
export type ModelPreset = {
  id: string;
  harness: HarnessId;
  /** Catalog model id, e.g. `claude:opus-5-5`, as `models.list` reports it. */
  model: string;
  /** Effort option value; empty for a model without an effort setting. */
  effort: string;
};

const MODEL_PRESETS_KEY = "monocode.modelPresets";
const MODEL_SLIDER_HAPTICS_KEY = "monocode.modelSliderHaptics";

/** The slider stays readable up to this many stops. */
export const MODEL_PRESET_LIMIT = 10;

/** Fired on `window` when the preset list changes. */
export const MODEL_PRESETS_CHANGE_EVENT = "monocode:model-presets-change";

/** Fired on `window` when the slider haptics setting flips. */
export const MODEL_SLIDER_HAPTICS_CHANGE_EVENT =
  "monocode:model-slider-haptics-change";

export const MODEL_SLIDER_HAPTICS_DEFAULT = true;

/**
 * Six stops, like the design: a lighter model to start, then Opus from a
 * medium budget up through Max, Ultracode, and Ultrathink.
 */
export const DEFAULT_MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "default-sonnet-medium",
    harness: "claude",
    model: "claude:sonnet-5",
    effort: "medium",
  },
  {
    id: "default-opus-medium",
    harness: "claude",
    model: "claude:opus-5-5",
    effort: "medium",
  },
  {
    id: "default-opus-high",
    harness: "claude",
    model: "claude:opus-5-5",
    effort: "high",
  },
  {
    id: "default-opus-max",
    harness: "claude",
    model: "claude:opus-5-5",
    effort: "max",
  },
  {
    id: "default-opus-ultracode",
    harness: "claude",
    model: "claude:opus-5-5",
    effort: "ultracode",
  },
  {
    id: "default-opus-ultrathink",
    harness: "claude",
    model: "claude:opus-5-5",
    effort: "ultrathink",
  },
];

function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESSES as string[]).includes(value);
}

/**
 * Keeps the well-formed entries of a stored list, gives each a unique id, and
 * caps it at `MODEL_PRESET_LIMIT`. Repeats stay, so a row being edited in
 * Settings never vanishes; the slider shows a repeated choice once. Returns
 * null when the value is not a list at all, so callers can fall back to the
 * defaults.
 */
export function parseModelPresets(value: unknown): ModelPreset[] | null {
  if (!Array.isArray(value)) return null;
  const presets: ModelPreset[] = [];
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item == null) continue;
    const record = item as Record<string, unknown>;
    if (!isHarnessId(record.harness)) continue;
    if (typeof record.model !== "string" || !record.model.trim()) continue;
    const effort = typeof record.effort === "string" ? record.effort : "";
    let id =
      typeof record.id === "string" && record.id.trim()
        ? record.id
        : `preset-${presets.length + 1}`;
    while (ids.has(id)) id = `${id}-${presets.length + 1}`;
    ids.add(id);
    presets.push({ id, harness: record.harness, model: record.model, effort });
    if (presets.length >= MODEL_PRESET_LIMIT) break;
  }
  return presets;
}

// useSyncExternalStore needs a stable snapshot, so the parsed list is cached
// against the raw string it came from.
let cachedRaw: string | null | undefined;
let cachedPresets: readonly ModelPreset[] = DEFAULT_MODEL_PRESETS;

export function loadModelPresets(): readonly ModelPreset[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(MODEL_PRESETS_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedPresets;
  cachedRaw = raw;
  let parsed: ModelPreset[] | null = null;
  if (raw != null) {
    try {
      parsed = parseModelPresets(JSON.parse(raw));
    } catch {
      parsed = null;
    }
  }
  cachedPresets = parsed ?? DEFAULT_MODEL_PRESETS;
  return cachedPresets;
}

export function saveModelPresets(presets: readonly ModelPreset[]) {
  const next = parseModelPresets(presets) ?? [];
  try {
    localStorage.setItem(MODEL_PRESETS_KEY, JSON.stringify(next));
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ModelPreset[]>(MODEL_PRESETS_CHANGE_EVENT, {
      detail: next,
    }),
  );
}

/** Forgets the stored list so the slider uses `DEFAULT_MODEL_PRESETS` again. */
export function resetModelPresets() {
  try {
    localStorage.removeItem(MODEL_PRESETS_KEY);
  } catch {
    // private mode / quota
  }
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MODEL_PRESETS_CHANGE_EVENT));
}

export function subscribeModelPresets(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === MODEL_PRESETS_KEY) onStoreChange();
  };
  window.addEventListener(MODEL_PRESETS_CHANGE_EVENT, onStoreChange);
  // Other windows (the quick composer) share localStorage.
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(MODEL_PRESETS_CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** A fresh id for a preset added in Settings. */
export function newModelPresetId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadModelSliderHaptics(): boolean {
  return readFlag(MODEL_SLIDER_HAPTICS_KEY) ?? MODEL_SLIDER_HAPTICS_DEFAULT;
}

export function saveModelSliderHaptics(value: boolean) {
  writeFlag(MODEL_SLIDER_HAPTICS_KEY, value);
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<boolean>(MODEL_SLIDER_HAPTICS_CHANGE_EVENT, {
      detail: value,
    }),
  );
}

export function subscribeModelSliderHaptics(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(MODEL_SLIDER_HAPTICS_CHANGE_EVENT, onStoreChange);
  return () =>
    window.removeEventListener(
      MODEL_SLIDER_HAPTICS_CHANGE_EVENT,
      onStoreChange,
    );
}
