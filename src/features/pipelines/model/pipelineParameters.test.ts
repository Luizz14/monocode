import { describe, expect, it } from "vitest";
import {
  initialParameterValues,
  parameterPayload,
  parseRuntimeParameters,
  variablePayload,
} from "./pipelineParameters";

const YAML = `trigger: none

parameters:
  - name: environment   # where to deploy
    displayName: 'Environment'
    type: string
    default: hml
    values:
      - hml
      - "prod"
  - name: runTests
    displayName: Run tests
    type: boolean
    default: True
  - name: retries
    type: number
    default: 2
  - name: platforms
    type: object
    default: [android, ios]
  - name: notes
  - name: flavor
    values: [free, 'paid plan']
    default: free

jobs:
  - job: Build
`;

describe("runtime parameters", () => {
  const parameters = parseRuntimeParameters(YAML);

  it("reads names, display names, types, defaults and allowed values", () => {
    expect(
      parameters.map(({ name, displayName, type, defaultValue, hasDefault, values }) => ({
        name,
        displayName,
        type,
        defaultValue,
        hasDefault,
        values,
      })),
    ).toEqual([
      {
        name: "environment",
        displayName: "Environment",
        type: "string",
        defaultValue: "hml",
        hasDefault: true,
        values: ["hml", "prod"],
      },
      {
        name: "runTests",
        displayName: "Run tests",
        type: "boolean",
        defaultValue: "true",
        hasDefault: true,
        values: [],
      },
      {
        name: "retries",
        displayName: "retries",
        type: "number",
        defaultValue: "2",
        hasDefault: true,
        values: [],
      },
      {
        name: "platforms",
        displayName: "platforms",
        type: "other",
        defaultValue: "",
        hasDefault: true,
        values: [],
      },
      {
        name: "notes",
        displayName: "notes",
        type: "string",
        defaultValue: "",
        hasDefault: false,
        values: [],
      },
      {
        name: "flavor",
        displayName: "flavor",
        type: "string",
        defaultValue: "free",
        hasDefault: true,
        values: ["free", "paid plan"],
      },
    ]);
  });

  it("stops at the next top-level key and handles pipelines without parameters", () => {
    expect(parseRuntimeParameters("trigger: none\njobs:\n  - job: A\n")).toEqual(
      [],
    );
    expect(parseRuntimeParameters("parameters: []\n")).toEqual([]);
    expect(
      parseRuntimeParameters("parameters:\n- name: a\n  default: x\nsteps:\n- script: echo\n").map(
        (parameter) => parameter.name,
      ),
    ).toEqual(["a"]);
  });

  it("reads the legacy name: default mapping", () => {
    expect(
      parseRuntimeParameters("parameters:\n  image: ubuntu-latest\n  steps: []\n").map(
        ({ name, type, defaultValue }) => ({ name, type, defaultValue }),
      ),
    ).toEqual([
      { name: "image", type: "string", defaultValue: "ubuntu-latest" },
      { name: "steps", type: "other", defaultValue: "" },
    ]);
  });

  it("prefills the form with defaults and leaves object types out", () => {
    expect(initialParameterValues(parameters)).toEqual({
      environment: "hml",
      runTests: "true",
      retries: "2",
      notes: "",
      flavor: "free",
    });
  });

  it("sends only changed or required values", () => {
    const values = {
      ...initialParameterValues(parameters),
      environment: "prod",
      notes: "release 1.2",
    };
    expect(parameterPayload(parameters, values)).toEqual({
      ok: true,
      templateParameters: { environment: "prod", notes: "release 1.2" },
    });
  });

  it("rejects missing, non-numeric and out-of-list values", () => {
    const base = { ...initialParameterValues(parameters), notes: "n" };
    expect(parameterPayload(parameters, { ...base, notes: " " })).toEqual({
      ok: false,
      error: "notes is required.",
    });
    expect(parameterPayload(parameters, { ...base, retries: "two" })).toEqual({
      ok: false,
      error: "retries must be a number.",
    });
    expect(
      parameterPayload(parameters, { ...base, environment: "dev" }),
    ).toEqual({
      ok: false,
      error: "Environment must be one of: hml, prod.",
    });
  });

  it("refuses object parameters that have no default", () => {
    const [stages] = parseRuntimeParameters(
      "parameters:\n  - name: stages\n    type: stageList\n",
    );
    expect(parameterPayload([stages], {})).toEqual({
      ok: false,
      error: "stages (stageList) has no default; run it from Azure DevOps.",
    });
  });
});

describe("queue-time variables", () => {
  it("sends changed values and only non-empty secrets", () => {
    const variables = [
      { name: "flavor", value: "hml", isSecret: false },
      { name: "token", value: "", isSecret: true },
      { name: "same", value: "x", isSecret: false },
    ];
    expect(
      variablePayload(variables, { flavor: "prod", token: "", same: "x" }),
    ).toEqual({ flavor: "prod" });
    expect(variablePayload(variables, { token: "s3cret" })).toEqual({
      token: "s3cret",
    });
  });
});
