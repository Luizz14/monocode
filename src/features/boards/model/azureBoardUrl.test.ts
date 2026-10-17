import { describe, expect, it } from "vitest";
import {
  applyAzureUrlImport,
  azureOrgName,
  parseAzureBoardUrl,
  resolveAzureAreaHints,
  sameAzureOrg,
} from "./azureBoardUrl";
import type { AzureBoardFilters } from "./boardTypes";

const USER_LINK =
  "https://dev.azure.com/BaneseAgile/TI%20Banese/_backlogs/backlog/SUTEC%20App%20Banese/Stories" +
  "?text=flutter" +
  "&System.AreaPath=SUTEC%20App%20Banese%20Frontend%20Manuten%C3%A7%C3%A3o" +
  "&System.IterationPath=%40CurrentIteration(%27%5BTI%20Banese%5D%5CSUTEC%20App%20Banese%20%3Cid%3A4f0c2a%3E%27)";

describe("parseAzureBoardUrl", () => {
  it("reads the user's backlog link", () => {
    expect(parseAzureBoardUrl(USER_LINK)).toEqual({
      organization: "BaneseAgile",
      orgUrl: "https://dev.azure.com/BaneseAgile",
      project: "TI Banese",
      team: "SUTEC App Banese",
      backlogLevelName: "Stories",
      text: "flutter",
      areaPathHints: ["SUTEC App Banese Frontend Manutenção"],
      iteration: { kind: "current" },
      assignedToMe: false,
    });
  });

  it("reads board links with and without the t segment", () => {
    for (const path of [
      "_boards/board/t/Team%20A/Backlog%20items",
      "_boards/board/Team%20A/Backlog%20items",
    ]) {
      expect(
        parseAzureBoardUrl(`https://dev.azure.com/acme/Web/${path}`),
      ).toMatchObject({
        project: "Web",
        team: "Team A",
        backlogLevelName: "Backlog items",
      });
    }
  });

  it("reads the team of a sprint link", () => {
    expect(
      parseAzureBoardUrl(
        "https://dev.azure.com/acme/Web/_sprints/taskboard/Team%20A/Web/Sprint%2042",
      ),
    ).toMatchObject({ project: "Web", team: "Team A", backlogLevelName: null });
  });

  it("reads visualstudio.com links", () => {
    expect(
      parseAzureBoardUrl(
        "https://acme.visualstudio.com/DefaultCollection/Web/_backlogs/backlog/Team/Epics?System.AssignedTo=%40Me",
      ),
    ).toMatchObject({
      organization: "acme",
      orgUrl: "https://acme.visualstudio.com",
      project: "Web",
      team: "Team",
      backlogLevelName: "Epics",
      assignedToMe: true,
    });
  });

  it("accepts a link without a scheme", () => {
    expect(
      parseAzureBoardUrl(
        "dev.azure.com/acme/Web/_backlogs/backlog/Team/Stories",
      ),
    ).toMatchObject({ organization: "acme", team: "Team" });
  });

  it("accepts a project-only link", () => {
    expect(parseAzureBoardUrl("https://dev.azure.com/acme/Web")).toMatchObject({
      project: "Web",
      team: null,
      backlogLevelName: null,
      iteration: null,
    });
  });

  it("reads iteration paths and every area", () => {
    const parsed = parseAzureBoardUrl(
      "https://dev.azure.com/acme/Web/_backlogs/backlog/Team/Stories" +
        "?System.AreaPath=Web%5CA&System.AreaPath=Web%5CB&System.IterationPath=Web%5CSprint%201",
    );
    expect(parsed?.areaPathHints).toEqual(["Web\\A", "Web\\B"]);
    expect(parsed?.iteration).toEqual({ kind: "path", path: "Web\\Sprint 1" });
  });

  it("treats any @CurrentIteration form as current", () => {
    for (const value of [
      "@CurrentIteration",
      "@currentiteration",
      "@CurrentIteration('[TI Banese]\\SUTEC App Banese <id:abc>')",
    ]) {
      const parsed = parseAzureBoardUrl(
        `https://dev.azure.com/acme/Web/_backlogs/backlog/Team/Stories?System.IterationPath=${encodeURIComponent(value)}`,
      );
      expect(parsed?.iteration).toEqual({ kind: "current" });
    }
  });

  it("normalizes to NFC", () => {
    const nfd = "Manutenção";
    const parsed = parseAzureBoardUrl(
      `https://dev.azure.com/acme/Web/_backlogs/backlog/Team/Stories?System.AreaPath=${encodeURIComponent(nfd)}`,
    );
    expect(parsed?.areaPathHints).toEqual(["Manutenção"]);
  });

  it.each([
    "",
    "not a link",
    "https://github.com/acme/web",
    "https://dev.azure.com/",
    "https://dev.azure.com/acme/_settings",
    "ftp://dev.azure.com/acme/Web",
  ])("returns null for %j", (raw) => {
    expect(parseAzureBoardUrl(raw)).toBeNull();
  });
});

describe("Azure organizations", () => {
  it("reads the org name from URLs and names", () => {
    expect(azureOrgName("https://dev.azure.com/baneseagile")).toBe(
      "baneseagile",
    );
    expect(azureOrgName("https://BaneseAgile.visualstudio.com/")).toBe(
      "baneseagile",
    );
    expect(azureOrgName("BaneseAgile")).toBe("baneseagile");
  });

  it("compares organizations case-insensitively", () => {
    expect(
      sameAzureOrg("https://dev.azure.com/baneseagile", "BaneseAgile"),
    ).toBe(true);
    expect(
      sameAzureOrg(
        "https://dev.azure.com/baneseagile",
        "https://baneseagile.visualstudio.com",
      ),
    ).toBe(true);
    expect(sameAzureOrg("https://dev.azure.com/other", "BaneseAgile")).toBe(
      false,
    );
    expect(sameAzureOrg("", "")).toBe(false);
  });
});

describe("resolveAzureAreaHints", () => {
  const areas = [
    "TI Banese",
    "TI Banese\\SUTEC App Banese",
    "TI Banese\\SUTEC App Banese\\SUTEC App Banese Frontend Manutenção",
    "TI Banese\\SUTEC App Banese\\Backend",
    "TI Banese\\Other Team\\Backend",
    "TI Banese\\Third Team\\Backend",
  ];

  it("matches the full path", () => {
    expect(
      resolveAzureAreaHints(["ti banese\\sutec app banese\\backend"], areas),
    ).toEqual({
      areas: [
        {
          path: "TI Banese\\SUTEC App Banese\\Backend",
          includeChildren: false,
        },
      ],
      ambiguous: [],
      unresolved: [],
    });
  });

  it("matches the path without the project", () => {
    expect(resolveAzureAreaHints(["Other Team\\Backend"], areas).areas).toEqual(
      [{ path: "TI Banese\\Other Team\\Backend", includeChildren: false }],
    );
  });

  it("matches the leaf", () => {
    expect(
      resolveAzureAreaHints(["SUTEC App Banese Frontend Manutenção"], areas)
        .areas,
    ).toEqual([
      {
        path: "TI Banese\\SUTEC App Banese\\SUTEC App Banese Frontend Manutenção",
        includeChildren: false,
      },
    ]);
  });

  it("matches NFD hints against NFC areas but keeps accents significant", () => {
    const nfd = "SUTEC App Banese Frontend Manutenção";
    expect(resolveAzureAreaHints([nfd], areas).areas).toHaveLength(1);
    expect(
      resolveAzureAreaHints(["SUTEC App Banese Frontend Manutencao"], areas),
    ).toEqual({
      areas: [],
      ambiguous: [],
      unresolved: ["SUTEC App Banese Frontend Manutencao"],
    });
  });

  it("breaks leaf ties with the team's areas", () => {
    expect(
      resolveAzureAreaHints(["Backend"], areas, [
        "TI Banese\\SUTEC App Banese",
      ]),
    ).toEqual({
      areas: [
        {
          path: "TI Banese\\SUTEC App Banese\\Backend",
          includeChildren: false,
        },
      ],
      ambiguous: [],
      unresolved: [],
    });
  });

  it("selects every match and reports a tie it cannot break", () => {
    const result = resolveAzureAreaHints(["Backend"], areas, [
      "TI Banese\\Nowhere",
    ]);
    expect(result.areas.map((area) => area.path)).toEqual([
      "TI Banese\\SUTEC App Banese\\Backend",
      "TI Banese\\Other Team\\Backend",
      "TI Banese\\Third Team\\Backend",
    ]);
    expect(result.ambiguous).toEqual(["Backend"]);
  });
});

describe("applyAzureUrlImport", () => {
  const empty: AzureBoardFilters = {
    project: "",
    team: "",
    backlogLevel: { id: "", name: "" },
    areaPaths: [],
    iteration: { kind: "any" },
    text: "",
    assignedToMe: false,
    includeDone: true,
  };

  it("fills the filters from the user's link", () => {
    const parsed = parseAzureBoardUrl(USER_LINK)!;
    const resolved = resolveAzureAreaHints(parsed.areaPathHints, [
      "TI Banese\\SUTEC App Banese Frontend Manutenção",
    ]);
    expect(applyAzureUrlImport(empty, parsed, resolved)).toEqual({
      project: "TI Banese",
      team: "SUTEC App Banese",
      backlogLevel: { id: "", name: "Stories" },
      areaPaths: [
        {
          path: "TI Banese\\SUTEC App Banese Frontend Manutenção",
          includeChildren: false,
        },
      ],
      iteration: { kind: "current" },
      text: "flutter",
      assignedToMe: false,
      includeDone: true,
    });
  });

  it("keeps team and level for a project link of the same project", () => {
    const current: AzureBoardFilters = {
      ...empty,
      project: "Web",
      team: "Team",
      backlogLevel: { id: "x", name: "Stories" },
    };
    const next = applyAzureUrlImport(
      current,
      parseAzureBoardUrl("https://dev.azure.com/acme/Web")!,
    );
    expect(next.team).toBe("Team");
    expect(next.backlogLevel).toEqual({ id: "x", name: "Stories" });
    expect(next.iteration).toEqual({ kind: "any" });
  });

  it("clears the team when the project changes", () => {
    const next = applyAzureUrlImport(
      { ...empty, project: "Web", team: "Team" },
      parseAzureBoardUrl("https://dev.azure.com/acme/Mobile")!,
    );
    expect(next).toMatchObject({
      project: "Mobile",
      team: "",
      backlogLevel: { id: "", name: "" },
      iteration: { kind: "current" },
    });
  });
});
