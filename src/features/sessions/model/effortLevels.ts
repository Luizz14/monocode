/**
 * The effort ladder the composer's model controls draw: each level has its
 * own icon and color (`EffortLevelIcon`, `[data-effort-level]` in
 * `ModelPresetSlider.css`). The design names its one drawn level "Terra
 * Médio", so the ladder climbs through bodies in the sky: moon, earth,
 * Saturn, sun, stars, comet, galaxy. The level's text label always shows
 * beside the icon; color is never the only cue.
 */
export type EffortLevel =
  "low" | "medium" | "high" | "xhigh" | "max" | "ultracode" | "ultrathink";

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
  "ultrathink",
];

/**
 * The level an effort option value names, or undefined for values outside
 * the ladder (Codex `minimal`, a `none` or `off` choice, provider-specific
 * variants). Those keep a neutral look.
 */
export function effortLevel(
  value: string | undefined,
): EffortLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  return EFFORT_LEVELS.find((level) => level === normalized);
}
