import { describe, expect, it } from "vitest";
import {
  BOARD_CATEGORY_RANK,
  azureStateCategory,
  isClosedCategory,
  linearStateCategory,
  normalizeHexColor,
  ownValue,
} from "./boardTypes";

describe("state categories", () => {
  it.each([
    ["Proposed", "todo"],
    ["InProgress", "inProgress"],
    ["Resolved", "resolved"],
    ["Completed", "done"],
    ["Removed", "canceled"],
    ["completed", "done"],
    ["Something", "unknown"],
  ] as const)("maps Azure %s to %s", (category, expected) => {
    expect(azureStateCategory(category)).toBe(expected);
  });

  it.each([
    ["triage", "todo"],
    ["backlog", "todo"],
    ["unstarted", "todo"],
    ["started", "inProgress"],
    ["completed", "done"],
    ["canceled", "canceled"],
    ["duplicate", "canceled"],
    ["weird", "unknown"],
  ] as const)("maps Linear %s to %s", (type, expected) => {
    expect(linearStateCategory(type)).toBe(expected);
  });

  it("ranks categories from triage to unknown", () => {
    const ordered = Object.entries(BOARD_CATEGORY_RANK)
      .sort((a, b) => a[1] - b[1])
      .map(([category]) => category);
    expect(ordered).toEqual([
      "triage",
      "backlog",
      "todo",
      "inProgress",
      "resolved",
      "done",
      "canceled",
      "unknown",
    ]);
  });

  it("treats done and canceled as closed", () => {
    expect(isClosedCategory("done")).toBe(true);
    expect(isClosedCategory("canceled")).toBe(true);
    expect(isClosedCategory("resolved")).toBe(false);
    expect(isClosedCategory("inProgress")).toBe(false);
  });
});

describe("normalizeHexColor", () => {
  it.each([
    ["b2b2b2", "#b2b2b2"],
    ["#BEC2C8", "#bec2c8"],
    [" 009CCC ", "#009ccc"],
    ["abc", "#aabbcc"],
    ["#ff000080", "#ff0000"],
  ])("normalizes %s", (raw, expected) => {
    expect(normalizeHexColor(raw)).toBe(expected);
  });

  it.each(["", "#12", "red", "#gggggg", "12345"])("rejects %j", (raw) => {
    expect(normalizeHexColor(raw)).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(normalizeHexColor(null)).toBeUndefined();
    expect(normalizeHexColor(undefined)).toBeUndefined();
  });
});

describe("ownValue", () => {
  it("ignores inherited keys", () => {
    expect(ownValue({ Bug: "Active" }, "Bug")).toBe("Active");
    expect(ownValue({ Bug: "Active" }, "constructor")).toBeUndefined();
    expect(ownValue({ Bug: "Active" }, undefined)).toBeUndefined();
  });
});
