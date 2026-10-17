// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  AzurePipeline,
  AzurePipelineRun,
} from "../model/azurePipelines";
import { clearAzurePipelinesCache } from "../model/azurePipelines";
import { PipelinesView } from "./PipelinesView";

const invoke = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));

const ORG = "https://dev.azure.com/BaneseAgile";

function run(
  id: number,
  pipelineName: string,
  overrides: Partial<AzurePipelineRun> = {},
): AzurePipelineRun {
  return {
    id,
    number: "20261016.1",
    pipelineId: id,
    pipelineName,
    status: "completed",
    result: "succeeded",
    reason: "individualCI",
    sourceBranch: "refs/heads/main",
    sourceVersion: String(id).repeat(40).slice(0, 40),
    repositoryId: "repo",
    repositoryType: "TfsGit",
    requestedFor: "Microsoft.VisualStudio.Services.TFS",
    queueTime: "2026-10-16T20:30:00Z",
    startTime: "2026-10-16T20:30:05Z",
    finishTime: "2026-10-16T20:30:53Z",
    url: `${ORG}/p/_build/results?buildId=${id}`,
    triggerInfo: {},
    ...overrides,
  };
}

function pipeline(id: number, name: string): AzurePipeline {
  return {
    id,
    name,
    folder: "\\",
    url: `${ORG}/p/_build?definitionId=${id}`,
    queueStatus: "enabled",
    latestRun: run(id, name),
  };
}

const LISTS: Record<string, AzurePipeline[]> = {
  "Mobile Banese": [pipeline(1, "Cria Tags CartaoElo")],
  "Mobile Desty": [pipeline(2, "OnboardingApp Fastlane Homologacao")],
};

const PIPELINE_YAML = `trigger: none
parameters:
  - name: environment
    type: string
    default: hml
    values: [hml, prod]
jobs:
  - job: Build
`;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const storage = new Map<string, string>([
    ["monocode:pipelines:project", "Mobile Banese"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  clearAzurePipelinesCache();
  invoke.mockReset();
  openUrl.mockClear();
  invoke.mockImplementation(async (command: string, args?: any) => {
    switch (command) {
      case "azure_devops_status":
        return { connected: true, url: ORG, organization: ORG.toLowerCase() };
      case "azure_devops_projects":
        return [
          { id: "d", name: "Mobile Desty" },
          { id: "b", name: "Mobile Banese" },
        ];
      case "azure_pipelines_list":
        return LISTS[args.project];
      case "azure_pipelines_runs":
        return [];
      case "azure_pipelines_run_titles":
        return {
          commits: args.commits.map((commit: any) => ({
            ...commit,
            message: `Atualização em ${args.project}`,
          })),
          pullRequests: [],
        };
      case "azure_pipelines_definition":
        return {
          id: args.pipelineId,
          name: "Cria Tags CartaoElo",
          folder: "\\",
          url: "",
          queueStatus: "enabled",
          yamlFilename: ".azure/pipeline.yaml",
          repository: {
            id: "repo",
            name: "CartaoElo",
            kind: "TfsGit",
            defaultBranch: "refs/heads/main",
          },
          variables: [],
        };
      case "azure_pipelines_branches":
        return ["develop", "main"];
      case "azure_pipelines_file":
        return PIPELINE_YAML;
      case "azure_pipelines_queue":
        return run(99, "Cria Tags CartaoElo", {
          number: "20261017.1",
          status: "inProgress",
          result: "",
          finishTime: "",
        });
      case "azure_pipelines_run":
        return run(99, "Cria Tags CartaoElo", { number: "20261017.1" });
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render() {
  await act(async () =>
    root.render(createElement(PipelinesView, { onClose: vi.fn() })),
  );
  await settle();
  await settle();
}

function rowText(id: number): string {
  return (
    container.querySelector(`[data-pipeline-row="${id}"]`)?.textContent ?? ""
  );
}

function commands(name: string) {
  return invoke.mock.calls.filter(([command]) => command === name);
}

it("lists the remembered project's recent pipelines like the web", async () => {
  await render();
  const breadcrumb = container.querySelector('[aria-label="Breadcrumb"]');
  expect(breadcrumb?.textContent).toContain("BaneseAgile");
  expect(
    container.querySelector('[aria-label="Project: Mobile Banese"]'),
  ).not.toBeNull();
  expect(rowText(1)).toContain("Cria Tags CartaoElo");
  expect(rowText(1)).toContain("#20261016.1 • Atualização em Mobile Banese");
  expect(rowText(1)).toContain("Individual CI");
  expect(rowText(1)).toContain("main");
  expect(rowText(1)).toContain("48s");
});

it("switches between Mobile Banese and Mobile Desty and remembers the choice", async () => {
  await render();
  const trigger = container.querySelector<HTMLButtonElement>(
    '[aria-label="Project: Mobile Banese"]',
  )!;
  await act(async () => trigger.click());
  const desty = [
    ...document.body.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((option) => option.textContent?.includes("Mobile Desty"))!;
  await act(async () => desty.click());
  await settle();
  await settle();

  expect(commands("azure_pipelines_list").at(-1)?.[1]).toEqual({
    project: "Mobile Desty",
  });
  expect(rowText(2)).toContain("OnboardingApp Fastlane Homologacao");
  expect(container.querySelector('[data-pipeline-row="1"]')).toBeNull();
  expect(localStorage.getItem("monocode:pipelines:project")).toBe(
    "Mobile Desty",
  );
  expect(
    JSON.parse(localStorage.getItem("monocode:pipelines:recent-projects")!),
  ).toEqual(["Mobile Desty"]);
});

it("filters pipelines by name", async () => {
  await render();
  const filter = container.querySelector<HTMLInputElement>(
    '[aria-label="Filter pipelines"]',
  )!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(filter, "nada disso");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-pipeline-row="1"]')).toBeNull();
  expect(container.textContent).toContain("No pipelines match the filter.");
});

it("queues a run only after Run is pressed, then follows it", async () => {
  await render();
  const runButton = container.querySelector<HTMLButtonElement>(
    '[aria-label="Run Cria Tags CartaoElo"]',
  )!;
  await act(async () => runButton.click());
  await settle();
  await settle(350);
  await settle();

  const dialog = document.body.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Run pipeline");
  expect(
    dialog.querySelector('[aria-label="Branch: main"]'),
  ).not.toBeNull();
  expect(
    dialog.querySelector('[aria-label="environment: hml"]'),
  ).not.toBeNull();
  expect(commands("azure_pipelines_file")[0]?.[1]).toEqual({
    project: "Mobile Banese",
    repositoryId: "repo",
    path: ".azure/pipeline.yaml",
    branch: "main",
  });
  expect(commands("azure_pipelines_queue")).toHaveLength(0);

  const submit = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.type === "submit",
  )!;
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  await settle();

  expect(commands("azure_pipelines_queue")).toEqual([
    [
      "azure_pipelines_queue",
      {
        project: "Mobile Banese",
        pipelineId: 1,
        branch: "main",
        templateParameters: {},
        variables: {},
      },
    ],
  ]);
  const queued = document.body.querySelector("[data-run-queued]")!;
  expect(queued.textContent).toContain("#20261017.1");
  expect(queued.textContent).toContain("In progress");

  const openRun = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.includes("Open run"),
  )!;
  await act(async () => openRun.click());
  expect(openUrl).toHaveBeenCalledWith(`${ORG}/p/_build/results?buildId=99`);
});
