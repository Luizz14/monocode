// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RollNumber, RollText } from "../ui/RollText";
import { saveAnimateNumbers } from "../../features/settings/model/displayPrefs";
import {
  graphemes,
  ROLL_MS,
  ROLL_TOTAL_MS,
  sharedEnds,
  STAGGER,
  staggerDelays,
} from "./rollText";

const ends = (from: string, to: string) =>
  sharedEnds(graphemes(from), graphemes(to));

describe("sharedEnds", () => {
  it("keeps the common runs at either end", () => {
    expect(ends("Opus 5.5", "Opus 5.1")).toEqual([7, 0]);
    expect(ends("feature/a", "fix/a")).toEqual([1, 2]);
    expect(ends("main", "main-2")).toEqual([4, 0]);
  });

  it("never overlaps the prefix and suffix", () => {
    expect(ends("aa", "aaa")).toEqual([2, 0]);
    expect(ends("ab", "b")).toEqual([0, 1]);
    expect(ends("", "main")).toEqual([0, 0]);
  });

  it("counts emoji as one character", () => {
    expect(graphemes("a👍🏽b")).toEqual(["a", "👍🏽", "b"]);
    expect(ends("👍🏽 ok", "👍🏽 no")).toEqual([2, 0]);
  });
});

describe("staggerDelays", () => {
  it("sweeps left to right within the stagger spread", () => {
    const delays = staggerDelays([0, 10, 20, 30]);
    expect(delays[0]).toBe(0);
    expect(delays[3]).toBeCloseTo((ROLL_MS * STAGGER * 3) / 4);
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });

  it("starts a lone glyph at once", () => {
    expect(staggerDelays([12])).toEqual([0]);
    expect(staggerDelays([])).toEqual([]);
  });
});

describe("RollText", () => {
  let host: HTMLDivElement;
  let root: Root;
  let reduced = false;

  const render = (text: string) =>
    act(() => root.render(createElement(RollText, { text })));

  beforeEach(() => {
    vi.useFakeTimers();
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    reduced = false;
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => ({ matches: reduced, media: query }) as MediaQueryList,
    );
    // happy-dom rejects `finished` on cancel, which browsers leave unobserved.
    vi.spyOn(Element.prototype, "animate").mockImplementation(
      () => ({ cancel() {} }) as unknown as Animation,
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    saveAnimateNumbers(true);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the plain label on first render", () => {
    render("Opus 5.5");
    expect(host.querySelector("[data-rolling]")).toBeNull();
    expect(host.textContent).toBe("Opus 5.5");
  });

  it("rolls only the changed middle, then settles on the plain label", () => {
    render("Opus 5.5");
    render("Opus 5.1");
    expect(host.querySelector("[data-rolling]")).not.toBeNull();
    const to = host.querySelector("[data-side='to']")!;
    expect(
      Array.from(to.querySelectorAll("[data-glyph]"), (g) =>
        g.getAttribute("data-text"),
      ),
    ).toEqual(["1"]);
    // Mid-roll, the text content is still just the new label.
    expect(host.textContent).toBe("Opus 5.1");

    act(() => vi.advanceTimersByTime(ROLL_TOTAL_MS));
    expect(host.querySelector("[data-rolling]")).toBeNull();
    expect(host.textContent).toBe("Opus 5.1");
  });

  it("swaps at once under reduced motion", () => {
    render("main");
    reduced = true;
    render("feature/roll");
    expect(host.querySelector("[data-rolling]")).toBeNull();
    expect(host.textContent).toBe("feature/roll");
  });

  it("rolls numbers until the user turns them off", () => {
    const number = (text: number) =>
      act(() => root.render(createElement(RollNumber, { text })));
    number(9);
    number(10);
    expect(host.querySelector("[data-rolling]")).not.toBeNull();

    // Switching off mid-roll settles on the new value at once.
    act(() => saveAnimateNumbers(false));
    expect(host.querySelector("[data-rolling]")).toBeNull();
    expect(host.textContent).toBe("10");

    number(11);
    expect(host.querySelector("[data-rolling]")).toBeNull();
    expect(host.textContent).toBe("11");
  });
});
