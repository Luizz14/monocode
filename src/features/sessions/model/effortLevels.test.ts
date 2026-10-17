import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS, effortLevel } from "./effortLevels";
import { resolvePresetSteps } from "./modelPresetSteps";
import type { AgentModel } from "./models";

describe("effortLevel", () => {
  it("names every rung of the ladder, whatever the case", () => {
    expect(EFFORT_LEVELS.map((level) => effortLevel(level))).toEqual([
      ...EFFORT_LEVELS,
    ]);
    expect(effortLevel(" XHigh ")).toBe("xhigh");
  });

  it("leaves values outside the ladder unmarked", () => {
    for (const value of ["minimal", "none", "off", "fast", "", undefined]) {
      expect(effortLevel(value)).toBeUndefined();
    }
  });

  it("puts the level on each preset step", () => {
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
          options: EFFORT_LEVELS.map((value) => ({ value, label: value })),
        },
      ],
    };
    const steps = resolvePresetSteps(
      [...EFFORT_LEVELS, ""].map((effort) => ({
        id: effort || "none",
        harness: "claude" as const,
        model: opus.id,
        effort,
      })),
      {
        find: () => opus,
        resolve: () => opus,
        modelsFor: () => [opus],
        available: () => true,
      },
    );
    expect(steps.map((step) => step.level)).toEqual([
      ...EFFORT_LEVELS,
      undefined,
    ]);
  });
});
