// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFamilyIcon } from "./ModelFamilyIcon";
import type { ModelFamily } from "../model/modelFamilies";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function draw(family: ModelFamily | undefined) {
  act(() => root.render(createElement(ModelFamilyIcon, { family, size: 26 })));
  return container.querySelector("svg")!;
}

describe("ModelFamilyIcon", () => {
  it("gives every family its own drawing", () => {
    const families: ModelFamily[] = ["fable", "opus", "sonnet", "haiku"];
    const drawings = families.map((family) => {
      const svg = draw(family);
      expect(svg.dataset.modelIcon).toBe(family);
      return svg.innerHTML;
    });
    expect(new Set(drawings).size).toBe(families.length);
  });

  it("strokes in the inherited color", () => {
    for (const path of draw("opus").querySelectorAll("path")) {
      expect(path.getAttribute("stroke")).toBe("currentColor");
    }
  });

  it("falls back to the design's globe", () => {
    const globe = draw(undefined);
    expect(globe.dataset.modelIcon).toBe("none");
    expect(globe.getAttribute("viewBox")).toBe("-88 -88 424 424");
  });
});
