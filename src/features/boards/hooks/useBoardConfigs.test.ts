// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newBoardConfig } from "../model/boardConfigs";
import * as snapshots from "../model/boardSnapshot";
import { useBoardConfigs, type UseBoardConfigs } from "./useBoardConfigs";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let result: UseBoardConfigs;

function Probe() {
  result = useBoardConfigs();
  return null;
}

beforeEach(() => {
  localStorage.clear();
});

describe("useBoardConfigs", () => {
  it("saves, activates, duplicates and removes boards", () => {
    const forget = vi.spyOn(snapshots, "forgetBoardSnapshot");
    const root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Probe)));
    expect(result.configs).toEqual([]);
    expect(result.active).toBeNull();

    const first = {
      ...newBoardConfig("linear", { teamIds: ["eng"] }),
      id: "one",
    };
    const second = {
      ...newBoardConfig("linear", { teamIds: ["des"] }),
      id: "two",
    };
    act(() => result.save(first));
    act(() => result.save(second));
    expect(result.configs.map((config) => config.id)).toEqual(["one", "two"]);
    expect(result.activeId).toBe("two");

    act(() => result.setActive("one"));
    expect(result.active?.id).toBe("one");

    let copyId = "";
    act(() => {
      copyId = result.duplicate("one")!.id;
    });
    expect(result.configs.map((config) => config.id)).toEqual([
      "one",
      copyId,
      "two",
    ]);
    expect(result.activeId).toBe(copyId);

    act(() => result.remove(copyId));
    expect(result.configs.map((config) => config.id)).toEqual(["one", "two"]);
    expect(result.activeId).toBe("two");
    expect(forget).toHaveBeenCalledWith(copyId);

    act(() => root.unmount());
  });
});
