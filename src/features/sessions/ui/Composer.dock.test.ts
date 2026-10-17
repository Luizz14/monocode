// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../source-control/hooks/useProjectBranches", () => ({
  useProjectBranchesState: () => ({
    branches: {
      current: "main",
      detached: false,
      branches: [{ name: "main", remote: null, current: true }],
    },
    settled: true,
  }),
}));

import { Composer } from "./Composer";

type Props = ComponentProps<typeof Composer>;

const containers: HTMLDivElement[] = [];
const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const container of containers.splice(0)) container.remove();
  vi.unstubAllGlobals();
});

function mount(props: Partial<Props> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  containers.push(container);
  roots.push(root);
  const onSubmit = vi.fn();
  const onStop = vi.fn();
  const base: Props = {
    focused: false,
    harness: "claude",
    model: "claude:opus-5-5",
    modelSettings: { effort: "high" },
    runtimeMode: "supervised",
    cwd: "/work/monocode",
    executionCwd: "/work/monocode",
    branch: "main",
    onFocus: () => {},
    onCwdChange: () => {},
    onModelChange: () => {},
    onRuntimeModeChange: () => {},
    onSubmit,
    onStop,
  };
  const render = (next: Partial<Props> = {}) =>
    act(() =>
      root.render(createElement(Composer, { ...base, ...props, ...next })),
    );
  render();
  const box = () =>
    container.querySelector<HTMLElement>("[data-composer-box]")!;
  return { container, box, render, onSubmit, onStop };
}

/** The box's markup with its line style and per-mount ids taken out. */
function structure(box: HTMLElement): string {
  return box.outerHTML
    .replace(/data-composer-border="\w+"/, "")
    .replace(/outline-(dashed|solid)/, "outline-LINE")
    .replace(/«[^»]*»|:r[0-9a-z]+:/g, "ID");
}

describe("composer box line", () => {
  it("is dashed in a new session and solid once docked", () => {
    const fresh = mount({ shell: true }).box();
    expect(fresh.dataset.composerBorder).toBe("dashed");
    expect(fresh.className).toContain("outline-dashed");
    expect(fresh.className).not.toContain("outline-solid");

    const docked = mount({ shell: false }).box();
    expect(docked.dataset.composerBorder).toBe("solid");
    expect(docked.className).toContain("outline-solid");
    expect(docked.className).not.toContain("outline-dashed");
  });

  it("can be chosen outright", () => {
    expect(
      mount({ shell: true, boxBorder: "solid" }).box().dataset.composerBorder,
    ).toBe("solid");
    expect(mount({ boxBorder: "dashed" }).box().dataset.composerBorder).toBe(
      "dashed",
    );
  });

  it("shares the rounded glass and inset line in both places", () => {
    for (const shell of [true, false]) {
      const classes = mount({ shell }).box().className.split(/\s+/);
      expect(classes).toEqual(
        expect.arrayContaining([
          "rounded-3xl",
          "bg-content/3",
          "backdrop-blur-sm",
          "outline-[1.5px]",
          "-outline-offset-3",
          "outline-content/10",
        ]),
      );
      expect(classes.some((name) => name.startsWith("border"))).toBe(false);
    }
  });
});

describe("composer parity", () => {
  it("draws the docked box exactly like the new-session box, line aside", () => {
    const fresh = mount({ shell: true }).box();
    const docked = mount({ shell: false }).box();
    expect(structure(docked)).toBe(structure(fresh));
  });

  it("uses the new-session chips, insets, and send button when docked", () => {
    const { box } = mount({ shell: false });
    const chip = box().querySelector<HTMLElement>(
      "[data-model-picker-trigger]",
    )!;
    expect(chip.dataset.modelFamily).toBe("opus");
    expect(chip.className).not.toContain("bg-selection ");
    expect(
      box().querySelector<HTMLElement>("[data-access-picker-trigger]")!
        .className,
    ).toContain("hover:bg-selection");
    expect(box().querySelector("textarea")!.className).toContain("px-4");
    expect(box().querySelector(".composer-send")!.className).toContain(
      "rounded-lg",
    );
    // The project goes by its name, with a chevron.
    const project = box().querySelector<HTMLElement>(
      'button[aria-label^="Project"]',
    )!;
    expect(project.textContent).toBe("monocode");
    expect(project.querySelector("svg:last-child")).not.toBeNull();
  });
});

describe("composer attach button", () => {
  const ATTACH = 'button[aria-label="Add files or choose a mode"]';

  it.each([
    ["the new-session composer", true],
    ["the docked composer", false],
  ])("sits right before Send in %s", (_, shell) => {
    const { box } = mount({ shell });
    const attach = box().querySelector<HTMLButtonElement>(ATTACH)!;
    const send = box().querySelector<HTMLButtonElement>(".composer-send")!;
    const chip = box().querySelector("[data-model-picker-trigger]")!;
    // Same row, after the model chip, and nothing focusable between it and
    // Send.
    const row = send.closest(".pb-3")!;
    expect(row.contains(attach)).toBe(true);
    expect(
      chip.compareDocumentPosition(attach) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const controls = [...row.querySelectorAll("button")].filter(
      (button) => !button.closest("[data-composer-plus]"),
    );
    expect(controls.indexOf(send) - controls.indexOf(attach)).toBe(1);
  });

  it("draws a paperclip with no fill at rest", () => {
    const { box } = mount({ shell: false });
    const attach = box().querySelector<HTMLButtonElement>(ATTACH)!;
    expect(attach.title).toBe("Add files or choose a mode");
    const path = attach.querySelector("svg path")!;
    expect(path.getAttribute("d")).toMatch(/^M19\.5 12\.0001V13\.5001/);
    const svg = attach.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("size-3.5");
    expect(
      svg.getAttribute("stroke-width") ?? path.getAttribute("stroke-width"),
    ).toBe("1.75");
    const classes = attach.className.split(/\s+/);
    expect(classes).not.toContain("bg-selection");
    expect(classes).toEqual(
      expect.arrayContaining([
        "size-6.5",
        "hover:bg-selection",
        "focus-visible:bg-selection",
      ]),
    );
  });

  it("still opens the attach and mode menu, aligned to its right edge", () => {
    const { box } = mount({ shell: false });
    const attach = box().querySelector<HTMLButtonElement>(ATTACH)!;
    act(() => attach.click());
    const menu = document.querySelector<HTMLElement>("[data-composer-plus]")!;
    expect(menu.textContent).toContain("Upload file");
    // Aligned to the button's right edge, so it opens inward from the
    // composer's right side. (Without layout here it may flip vertically.)
    expect(menu.style.transformOrigin).toMatch(/^100% /);
    expect(attach.className).toContain("bg-selection");
    act(() => attach.click());
    expect(document.querySelector("[data-composer-plus]")).toBeNull();
  });

  it("stays hidden in the compact composer", () => {
    const { box } = mount({ shell: false, compact: true });
    expect(box().querySelector(ATTACH)!.closest(".hidden")).not.toBeNull();
  });
});

describe("docked composer behavior", () => {
  it("offers Stop during a turn, and Send again once something is typed", () => {
    const { box, render, onStop } = mount({ shell: false, busy: true });
    const stop = box().querySelector<HTMLButtonElement>(
      'button[aria-label="Stop"]',
    )!;
    expect(stop.className).toContain("rounded-lg");
    act(() => stop.click());
    expect(onStop).toHaveBeenCalledTimes(1);

    render({ busy: false });
    expect(box().querySelector('button[aria-label="Stop"]')).toBeNull();
    expect(
      box().querySelector<HTMLButtonElement>('button[aria-label="Send"]')!
        .disabled,
    ).toBe(true);
  });

  it("sends with Enter", () => {
    const { box, onSubmit } = mount({ shell: false });
    const field = box().querySelector("textarea")!;
    act(() => {
      field.value = "fix the flaky test";
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toBe("fix the flaky test");
  });

  it("keeps the queue and the usage limit above the box", () => {
    const { container, box } = mount({
      shell: false,
      queuedMessages: [
        { id: "q1", text: "then update the docs", attachments: [] },
      ],
      usageLimit: { resetsAt: Date.now() + 60_000 },
    });
    expect(container.textContent).toContain("then update the docs");
    expect(box().textContent).not.toContain("then update the docs");
    const queue = [...container.querySelectorAll<HTMLElement>("*")].find(
      (node) => node.textContent === "then update the docs",
    )!;
    expect(
      queue.compareDocumentPosition(box()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("dashes the box's own line, in the accent color, while editing the last turn", () => {
    // The box draws its line with an outline, so the edit style must restyle
    // the outline rather than a border it no longer has.
    const css = readFileSync(
      join(process.cwd(), "src/styles/index.css"),
      "utf8",
    );
    const rule = /\.edit-last-turn-composer \{([^}]*)\}/.exec(css)![1];
    expect(rule).toContain("outline-style: dashed");
    expect(rule).toContain("outline-color:");
    expect(rule).toContain("--user-accent-color, var(--color-accent)");
    expect(rule).not.toContain("border");
  });
});
