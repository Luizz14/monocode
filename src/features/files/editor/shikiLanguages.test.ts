import { bundledLanguagesInfo } from "shiki";
import { describe, expect, it } from "vitest";
import {
  SHIKI_LANGUAGE_ALIASES,
  SHIKI_LANGUAGE_IDS,
  normalizeLanguage,
  supportsLanguage,
} from "./shikiLanguages";

describe("shiki language list", () => {
  it("matches the installed shiki bundle (regenerate shikiLanguages.ts when this fails)", () => {
    const ids = bundledLanguagesInfo.map((info) => info.id).sort();
    expect([...SHIKI_LANGUAGE_IDS]).toEqual(ids);
    const aliases = Object.fromEntries(
      bundledLanguagesInfo.flatMap((info) =>
        (info.aliases ?? []).map((alias) => [alias, info.id]),
      ),
    );
    expect({ ...SHIKI_LANGUAGE_ALIASES }).toEqual(aliases);
  });

  it("resolves aliases and case like the highlighter did", () => {
    expect(normalizeLanguage("TS")).toBe("typescript");
    expect(normalizeLanguage(" sh ")).toBe("shellscript");
    expect(normalizeLanguage("bash")).toBe("shellscript");
    expect(normalizeLanguage("typescript")).toBe("typescript");
    expect(supportsLanguage("ts")).toBe(true);
    expect(supportsLanguage("not-a-language")).toBe(false);
    expect(supportsLanguage("text")).toBe(false);
  });
});
