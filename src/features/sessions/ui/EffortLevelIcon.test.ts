// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffortLevelIcon } from "./EffortLevelIcon";
import { EFFORT_LEVELS, type EffortLevel } from "../model/effortLevels";

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

function draw(level: EffortLevel | undefined) {
  act(() => root.render(createElement(EffortLevelIcon, { level, size: 26 })));
  return container.querySelector("svg")!;
}

describe("EffortLevelIcon", () => {
  it("gives every level its own drawing", () => {
    const drawings = EFFORT_LEVELS.map((level) => draw(level).innerHTML);
    expect(new Set(drawings).size).toBe(EFFORT_LEVELS.length);
  });

  it("draws Medium and unknown levels as the design's globe", () => {
    const globe = draw("medium");
    expect(globe.getAttribute("viewBox")).toBe("-88 -88 424 424");
    expect(globe.querySelector("path")!.getAttribute("fill")).toBe(
      "currentColor",
    );
    expect(draw(undefined).dataset.effortIcon).toBe("none");
  });

  it("strokes the other levels in the inherited color", () => {
    const moon = draw("low");
    expect(moon.getAttribute("viewBox")).toBe("0 0 24 24");
    for (const path of moon.querySelectorAll("path")) {
      expect(path.getAttribute("stroke")).toBe("currentColor");
    }
  });

  it("paints Ultrathink with a rainbow it defines itself", () => {
    const galaxy = draw("ultrathink");
    const gradient = galaxy.querySelector("linearGradient")!;
    expect(gradient).not.toBeNull();
    for (const path of galaxy.querySelectorAll("path")) {
      expect(path.getAttribute("stroke")).toBe(`url(#${gradient.id})`);
    }
  });
});
