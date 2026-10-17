import { describe, expect, it } from "vitest";
import { CLAUDE_MODEL_CATALOG } from "../../../integrations/harness/providers/claude/claudeCatalog";
import { modelFamily } from "./modelFamilies";

function family(name: string, id = "", nativeId?: string) {
  return modelFamily({ id, name, nativeId });
}

describe("modelFamily", () => {
  it("reads the family and version from Claude names", () => {
    expect(family("Claude Opus 5.5")).toEqual({
      family: "opus",
      version: "5.5",
      legacy: false,
    });
    expect(family("Claude Fable 5")).toEqual({
      family: "fable",
      version: "5",
      legacy: false,
    });
    expect(family("Claude Haiku 4.5")).toEqual({
      family: "haiku",
      version: "4.5",
      legacy: true,
    });
  });

  it("reads native and catalog ids, including dated and older orderings", () => {
    expect(family("x", "claude:opus-4-8")).toMatchObject({
      family: "opus",
      version: "4.8",
    });
    expect(family("x", "", "claude-sonnet-4-20250514")).toMatchObject({
      family: "sonnet",
      version: "4",
      legacy: true,
    });
    expect(family("Claude 3.5 Sonnet")).toMatchObject({
      family: "sonnet",
      version: "3.5",
      legacy: true,
    });
  });

  it("treats a moving alias as the current generation", () => {
    expect(family("Claude Opus", "claude:opus", "opus")).toEqual({
      family: "opus",
      legacy: false,
    });
    expect(family("Claude Opus", "claude:opus", "claude-opus-4-8")).toEqual({
      family: "opus",
      version: "4.8",
      legacy: true,
    });
  });

  it("leaves other models out", () => {
    expect(family("GPT-5.5", "codex:gpt-5.5")).toBeUndefined();
    expect(family("Composer 2.5", "cursor:composer-2.5")).toBeUndefined();
    expect(family("Opusculum", "x:opusculum")).toBeUndefined();
  });

  it("covers every model in the bundled Claude catalog", () => {
    expect(
      CLAUDE_MODEL_CATALOG.map((model) => {
        const info = modelFamily(model);
        return `${info?.family} ${info?.version} ${info?.legacy}`;
      }),
    ).toEqual(
      CLAUDE_MODEL_CATALOG.map((model) => {
        const [, family, version] = model.name.match(/Claude (\w+) ([\d.]+)/)!;
        return `${family.toLowerCase()} ${version} ${Number(version) < 5}`;
      }),
    );
  });
});
