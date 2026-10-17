import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinearBoardTeam } from "./boardTypes";
import {
  buildLinearColumns,
  clearLinearBoardsCache,
  groupLinearStates,
  linearBoardStates,
  linearBoardWebUrl,
  linearCardColumnId,
  linearIssueToCard,
  resolveLinearMove,
  type LinearBoardIssue,
  type LinearBoardStateRow,
} from "./linearBoards";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const rows: LinearBoardStateRow[] = [
  {
    id: "e-backlog",
    name: "Backlog",
    type: "backlog",
    color: "#bec2c8",
    position: 0,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-todo",
    name: "Todo",
    type: "unstarted",
    color: "#e2e2e2",
    position: 1,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-review",
    name: "In Review",
    type: "started",
    color: "#0f783c",
    position: 3,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-progress",
    name: "In Progress",
    type: "started",
    color: "#f2c94c",
    position: 2,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-done",
    name: "Done",
    type: "completed",
    color: "#5e6ad2",
    position: 4,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "e-dup",
    name: "Duplicate",
    type: "duplicate",
    color: "#95a2b3",
    position: 5,
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
  },
  {
    id: "d-todo",
    name: "To do",
    type: "unstarted",
    color: "#e2e2e2",
    position: 0,
    teamId: "des",
    teamKey: "DES",
    teamName: "Design",
  },
  {
    id: "d-doing",
    name: "Doing",
    type: "started",
    color: "#f2c94c",
    position: 1,
    teamId: "des",
    teamKey: "DES",
    teamName: "Design",
  },
  {
    id: "d-done",
    name: "Shipped",
    type: "completed",
    color: "#5e6ad2",
    position: 2,
    teamId: "des",
    teamKey: "DES",
    teamName: "Design",
  },
];

const teams: LinearBoardTeam[] = groupLinearStates(rows);

function issue(overrides: Partial<LinearBoardIssue> = {}): LinearBoardIssue {
  return {
    id: "issue-uuid",
    identifier: "ENG-12",
    number: 12,
    title: "Fix auth",
    url: "https://linear.app/acme/issue/ENG-12/fix-auth",
    stateId: "e-progress",
    stateName: "In Progress",
    stateType: "started",
    stateColor: "#f2c94c",
    teamId: "eng",
    teamKey: "ENG",
    teamName: "Engineering",
    projectName: "Auth",
    priority: 0,
    priorityLabel: "No priority",
    estimate: null,
    sortOrder: -42.5,
    cycle: null,
    labels: [{ name: "Bug", color: "eb5757" }],
    assignee: { login: "maya", avatarUrl: "https://example.com/maya.png" },
    updatedAt: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

describe("groupLinearStates", () => {
  it("groups the flat list by team in order", () => {
    expect(
      teams.map((team) => [team.id, team.key, team.states.length]),
    ).toEqual([
      ["eng", "ENG", 6],
      ["des", "DES", 3],
    ]);
  });
});

describe("buildLinearColumns", () => {
  it("uses one team's states by type then position, without duplicates", () => {
    const columns = buildLinearColumns(teams, ["eng"]);
    expect(columns.map((column) => column.id)).toEqual([
      "ln:e-backlog",
      "ln:e-todo",
      "ln:e-progress",
      "ln:e-review",
      "ln:e-done",
    ]);
    expect(columns[2]).toEqual({
      id: "ln:e-progress",
      title: "In Progress",
      color: "#f2c94c",
      category: "inProgress",
      target: {
        provider: "linear",
        statesByTeam: {
          eng: {
            id: "e-progress",
            name: "In Progress",
            type: "started",
            color: "#f2c94c",
          },
        },
      },
    });
  });

  it("uses one column per type across teams, targeting the lowest position", () => {
    const columns = buildLinearColumns(teams, ["eng", "des"]);
    expect(columns.map((column) => [column.id, column.title])).toEqual([
      ["lt:backlog", "Backlog"],
      ["lt:unstarted", "Todo"],
      ["lt:started", "In Progress"],
      ["lt:completed", "Done"],
    ]);
    const started = columns[2]!.target;
    expect(started).toMatchObject({
      statesByTeam: {
        eng: { id: "e-progress" },
        des: { id: "d-doing" },
      },
    });
    expect(columns[0]!.target).toEqual({
      provider: "linear",
      statesByTeam: {
        eng: {
          id: "e-backlog",
          name: "Backlog",
          type: "backlog",
          color: "#bec2c8",
        },
      },
    });
  });

  it("ignores teams that were not picked", () => {
    expect(buildLinearColumns(teams, [])).toEqual([]);
    expect(buildLinearColumns(teams, ["gone"])).toEqual([]);
  });
});

describe("linearCardColumnId", () => {
  const single = buildLinearColumns(teams, ["eng"]);
  const multi = buildLinearColumns(teams, ["eng", "des"]);

  it("finds the exact state column", () => {
    expect(linearCardColumnId(issue(), single)).toBe("ln:e-progress");
    expect(linearCardColumnId(issue(), multi)).toBe("lt:started");
  });

  it("uses the type column for a state that is not the type's first", () => {
    expect(
      linearCardColumnId(
        issue({ stateId: "e-review", stateName: "In Review" }),
        multi,
      ),
    ).toBe("lt:started");
  });

  it("falls back to Other", () => {
    expect(
      linearCardColumnId(
        issue({ stateId: "e-dup", stateType: "duplicate" }),
        single,
      ),
    ).toBe("other");
  });
});

describe("linearIssueToCard", () => {
  const columns = buildLinearColumns(teams, ["eng"]);

  it("builds a card", () => {
    expect(linearIssueToCard(issue(), columns)).toEqual({
      provider: "linear",
      key: "linear:issue-uuid",
      id: "issue-uuid",
      ref: "ENG-12",
      number: 12,
      title: "Fix auth",
      url: "https://linear.app/acme/issue/ENG-12/fix-auth",
      state: "In Progress",
      stateId: "e-progress",
      stateType: "started",
      stateCategory: "inProgress",
      stateColor: "#f2c94c",
      columnId: "ln:e-progress",
      tags: [{ name: "Bug", color: "#eb5757" }],
      project: "Auth",
      teamId: "eng",
      teamKey: "ENG",
      teamName: "Engineering",
      order: -42.5,
      updatedAt: "2026-10-01T10:00:00Z",
      assignee: { name: "maya", avatarUrl: "https://example.com/maya.png" },
    });
  });

  it("keeps priority, estimate and cycle when present", () => {
    const card = linearIssueToCard(
      issue({
        priority: 2,
        priorityLabel: "High",
        estimate: 3,
        cycle: { id: "c", number: 7, name: "", startsAt: "", endsAt: "" },
        assignee: null,
      }),
      columns,
    );
    expect(card.priority).toEqual({ value: 2, label: "High" });
    expect(card.effort).toBe(3);
    expect(card.iteration).toBe("Cycle 7");
    expect(card).not.toHaveProperty("assignee");
  });
});

describe("resolveLinearMove", () => {
  const single = buildLinearColumns(teams, ["eng"]);
  const multi = buildLinearColumns(teams, ["eng", "des"]);

  it("moves to the column's state for the card's team", () => {
    const card = linearIssueToCard(issue(), single);
    expect(resolveLinearMove(card, single[4]!)).toEqual({ stateId: "e-done" });
    const designCard = linearIssueToCard(
      issue({ teamId: "des", stateId: "d-todo", stateType: "unstarted" }),
      multi,
    );
    expect(resolveLinearMove(designCard, multi[2]!)).toEqual({
      stateId: "d-doing",
    });
  });

  it("rejects the same column and teams without that type", () => {
    const card = linearIssueToCard(issue(), single);
    expect(resolveLinearMove(card, single[2]!)).toEqual({
      error: "same-column",
    });
    const designCard = linearIssueToCard(
      issue({ teamId: "des", stateId: "d-todo", stateType: "unstarted" }),
      multi,
    );
    expect(resolveLinearMove(designCard, multi[0]!)).toEqual({
      error: "not-allowed",
    });
  });

  it("treats the type's own state in a type column as the same column", () => {
    const card = {
      ...linearIssueToCard(issue({ stateId: "e-review" }), multi),
      columnId: "lt:unstarted",
    };
    expect(resolveLinearMove(card, multi[2]!)).toEqual({
      stateId: "e-progress",
    });
    const already = { ...linearIssueToCard(issue(), multi), columnId: "x" };
    expect(resolveLinearMove(already, multi[2]!)).toEqual({
      error: "same-column",
    });
  });
});

describe("linearBoardStates", () => {
  beforeEach(() => {
    clearLinearBoardsCache();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "linear_boards_states") return rows;
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("groups and caches by team set", async () => {
    const first = await linearBoardStates(["des", "eng"]);
    const second = await linearBoardStates(["eng", "des", "eng"]);
    expect(second).toBe(first);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("linear_boards_states", {
      teamIds: ["des", "eng"],
    });
    expect(first.map((team) => team.id)).toEqual(["eng", "des"]);
  });
});

describe("linearBoardWebUrl", () => {
  it("links one team's board from an issue URL", () => {
    expect(
      linearBoardWebUrl(
        teams,
        ["eng"],
        "https://linear.app/acme/issue/ENG-12/x",
      ),
    ).toBe("https://linear.app/acme/team/ENG/active");
    expect(
      linearBoardWebUrl(
        teams,
        ["eng", "des"],
        "https://linear.app/acme/issue/x",
      ),
    ).toBeNull();
    expect(linearBoardWebUrl(teams, ["eng"], undefined)).toBeNull();
  });
});
