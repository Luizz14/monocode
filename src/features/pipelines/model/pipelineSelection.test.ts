import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseProject,
  initialRunBranch,
  isValidBranch,
  loadPipelinesProject,
  loadRecentPipelineProjects,
  orderBranches,
  orderProjects,
  rememberRecentProject,
  savePipelinesProject,
  shortBranch,
} from "./pipelineSelection";

const projects = [
  { id: "1", name: "Mobile Desty" },
  { id: "2", name: "TI Banese" },
  { id: "3", name: "SUINF" },
  { id: "4", name: "Mobile Banese" },
];

describe("project selection", () => {
  it("keeps the remembered project while it exists", () => {
    expect(chooseProject(projects, "Mobile Banese")).toBe("Mobile Banese");
  });

  it("falls back to the most recent project that still exists, then the first", () => {
    expect(
      chooseProject(projects, "Removed", ["Gone", "Mobile Desty"]),
    ).toBe("Mobile Desty");
    expect(chooseProject(projects, null)).toBe("Mobile Desty");
    expect(chooseProject([], "Mobile Banese")).toBeNull();
  });

  it("puts recently used projects first so two projects stay one click apart", () => {
    let recent = rememberRecentProject([], "Mobile Desty");
    recent = rememberRecentProject(recent, "Mobile Banese");
    expect(recent).toEqual(["Mobile Banese", "Mobile Desty"]);
    expect(orderProjects(projects, recent).map((p) => p.name)).toEqual([
      "Mobile Banese",
      "Mobile Desty",
      "SUINF",
      "TI Banese",
    ]);
    recent = rememberRecentProject(recent, "Mobile Desty");
    expect(recent).toEqual(["Mobile Desty", "Mobile Banese"]);
  });

  it("caps the recent list", () => {
    expect(rememberRecentProject(["a", "b", "c", "d"], "e")).toEqual([
      "e",
      "a",
      "b",
      "c",
    ]);
  });
});

describe("remembered project storage", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("saves the project and its place in the recent list", () => {
    expect(loadPipelinesProject()).toBeNull();
    expect(loadRecentPipelineProjects()).toEqual([]);
    savePipelinesProject("Mobile Desty");
    expect(savePipelinesProject("Mobile Banese")).toEqual([
      "Mobile Banese",
      "Mobile Desty",
    ]);
    expect(loadPipelinesProject()).toBe("Mobile Banese");
    expect(loadRecentPipelineProjects()).toEqual([
      "Mobile Banese",
      "Mobile Desty",
    ]);
  });

  it("ignores a corrupt recent list", () => {
    localStorage.setItem("monocode:pipelines:recent-projects", "{nope");
    expect(loadRecentPipelineProjects()).toEqual([]);
    localStorage.setItem(
      "monocode:pipelines:recent-projects",
      JSON.stringify(["ok", 3]),
    );
    expect(loadRecentPipelineProjects()).toEqual(["ok"]);
  });
});

describe("branch selection", () => {
  it("starts on the repository's default branch", () => {
    expect(initialRunBranch("refs/heads/develop", ["main", "develop"])).toBe(
      "develop",
    );
    expect(initialRunBranch("", ["feature/x", "master"])).toBe("master");
    expect(initialRunBranch("", ["feature/x"])).toBe("feature/x");
    expect(initialRunBranch("")).toBe("main");
  });

  it("orders the default branch, then long-lived ones, then the rest", () => {
    expect(
      orderBranches(
        ["feature/b", "main", "develop", "feature/a", "main"],
        "refs/heads/develop",
      ),
    ).toEqual(["develop", "main", "feature/a", "feature/b"]);
  });

  it("filters branches by every word of the query", () => {
    expect(
      orderBranches(
        ["feature/US1/cartão", "feature/US2/pix", "main"],
        "main",
        "us1 cartao",
      ),
    ).toEqual(["feature/US1/cartão"]);
  });

  it("validates typed branches like the host does", () => {
    expect(shortBranch("refs/heads/feature/x")).toBe("feature/x");
    expect(isValidBranch("feature/x")).toBe(true);
    expect(isValidBranch("refs/tags/v1")).toBe(true);
    expect(isValidBranch("")).toBe(false);
    expect(isValidBranch("two words")).toBe(false);
    expect(isValidBranch("a/../b")).toBe(false);
    expect(isValidBranch("/main")).toBe(false);
    expect(isValidBranch("main/")).toBe(false);
  });
});
