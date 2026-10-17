/**
 * Runtime parameters from a pipeline's YAML `parameters:` block, for the Run
 * dialog. This is a small reader for that one block, not a YAML parser: it
 * understands the documented shapes (a list of `name`/`displayName`/`type`/
 * `default`/`values` entries, or the legacy `name: default` mapping) and
 * leaves anything richer (objects, step lists) to Azure's defaults.
 */

export type PipelineParameterType = "string" | "number" | "boolean" | "other";

export type PipelineParameter = {
  name: string;
  displayName: string;
  type: PipelineParameterType;
  /** The type as written, e.g. `stepList`, for parameters shown read-only. */
  rawType: string;
  defaultValue: string;
  hasDefault: boolean;
  values: string[];
};

type Line = { indent: number; text: string };

function stripComment(text: string): string {
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      return text.slice(0, index).trimEnd();
    }
  }
  return text.trimEnd();
}

function scalar(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(["\\])/g, "$1");
  }
  return text;
}

/** `[a, 'b c']` flow sequences, as used for short `values:` lists. */
function flowList(raw: string): string[] | null {
  const text = raw.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(scalar(current));
      current = "";
    } else {
      current += char;
    }
  }
  items.push(scalar(current));
  return items;
}

function splitKey(text: string): [string, string] | null {
  const match = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/.exec(text);
  return match ? [match[1], match[2] ?? ""] : null;
}

/** Lines of the top-level `parameters:` block, comments and blanks removed. */
function parameterBlock(yaml: string): Line[] | null {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) =>
    /^parameters\s*:\s*(#.*)?$/.test(line),
  );
  if (start === -1) {
    const inline = lines.find((line) => /^parameters\s*:/.test(line));
    // `parameters: []` and friends declare nothing to ask for.
    return inline ? [] : null;
  }
  const block: Line[] = [];
  for (const line of lines.slice(start + 1)) {
    const text = stripComment(line);
    if (!text.trim()) continue;
    const indent = text.length - text.trimStart().length;
    // A top-level key ends the block; a top-level `- ` still belongs to it.
    if (indent === 0 && !text.startsWith("-")) break;
    block.push({ indent, text: text.trim() });
  }
  return block;
}

function parameterType(rawType: string): PipelineParameterType {
  switch (rawType.toLowerCase()) {
    case "":
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "other";
  }
}

function fromFields(fields: Map<string, string>, values: string[]) {
  const name = scalar(fields.get("name") ?? "");
  if (!name) return null;
  const rawType = scalar(fields.get("type") ?? "string");
  const hasDefault = fields.has("default");
  const rawDefault = fields.get("default") ?? "";
  const listDefault = flowList(rawDefault);
  const parameter: PipelineParameter = {
    name,
    displayName: scalar(fields.get("displayName") ?? "") || name,
    type: parameterType(rawType),
    rawType,
    // Block or flow collections as defaults belong to `object`-like types.
    defaultValue:
      listDefault || rawDefault === "|" || rawDefault === ">"
        ? ""
        : scalar(rawDefault),
    hasDefault,
    values,
  };
  if (parameter.type === "boolean" && hasDefault) {
    parameter.defaultValue =
      parameter.defaultValue.toLowerCase() === "true" ? "true" : "false";
  }
  return parameter;
}

function parseList(block: Line[]): PipelineParameter[] {
  const dashIndent = block[0].indent;
  const parameters: PipelineParameter[] = [];
  let fields: Map<string, string> | null = null;
  let values: string[] = [];
  let listKey: string | null = null;
  let fieldIndent = dashIndent + 2;
  const flush = () => {
    if (!fields) return;
    const parameter = fromFields(fields, values);
    if (parameter) parameters.push(parameter);
  };
  for (const line of block) {
    if (line.indent === dashIndent && line.text.startsWith("-")) {
      flush();
      fields = new Map();
      values = [];
      listKey = null;
      const rest = line.text.slice(1).trimStart();
      fieldIndent = line.indent + (line.text.length - rest.length);
      const pair = splitKey(rest);
      if (pair) fields.set(pair[0], pair[1]);
      continue;
    }
    if (!fields || line.indent < fieldIndent) continue;
    if (line.indent === fieldIndent && !line.text.startsWith("-")) {
      const pair = splitKey(line.text);
      listKey = null;
      if (!pair) continue;
      const [key, value] = pair;
      if (key === "values") {
        const inline = flowList(value);
        if (inline) values = inline;
        else if (!value) listKey = key;
      } else {
        fields.set(key, value);
      }
      continue;
    }
    // `values:` items sit one level in (or at the same column, which YAML allows).
    if (listKey === "values" && line.text.startsWith("-")) {
      values.push(scalar(line.text.slice(1)));
    }
  }
  flush();
  return parameters;
}

/** Legacy `parameters:` mapping of `name: default`. */
function parseMapping(block: Line[]): PipelineParameter[] {
  const keyIndent = block[0].indent;
  return block
    .filter((line) => line.indent === keyIndent)
    .map((line) => splitKey(line.text))
    .filter((pair): pair is [string, string] => pair !== null)
    .map(([name, value]) => {
      const nested = !value || flowList(value) !== null;
      return {
        name,
        displayName: name,
        type: nested ? "other" : "string",
        rawType: nested ? "object" : "string",
        defaultValue: nested ? "" : scalar(value),
        hasDefault: true,
        values: [],
      } satisfies PipelineParameter;
    });
}

export function parseRuntimeParameters(yaml: string): PipelineParameter[] {
  const block = parameterBlock(yaml);
  if (!block?.length) return [];
  return block[0].text.startsWith("-") ? parseList(block) : parseMapping(block);
}

/** Starting values for the form: each parameter's default. */
export function initialParameterValues(
  parameters: readonly PipelineParameter[],
): Record<string, string> {
  return Object.fromEntries(
    parameters
      .filter((parameter) => parameter.type !== "other")
      .map((parameter) => [
        parameter.name,
        parameter.hasDefault
          ? parameter.defaultValue
          : (parameter.values[0] ??
            (parameter.type === "boolean" ? "false" : "")),
      ]),
  );
}

export type ParameterPayload =
  | { ok: true; templateParameters: Record<string, string> }
  | { ok: false; error: string };

/**
 * The `templateParameters` to send. Only values that differ from the
 * default, or have no default, are sent, so everything else keeps the
 * pipeline's own defaults and types.
 */
export function parameterPayload(
  parameters: readonly PipelineParameter[],
  values: Readonly<Record<string, string>>,
): ParameterPayload {
  const templateParameters: Record<string, string> = {};
  for (const parameter of parameters) {
    if (parameter.type === "other") {
      if (!parameter.hasDefault) {
        return {
          ok: false,
          error: `${parameter.displayName} (${parameter.rawType}) has no default; run it from Azure DevOps.`,
        };
      }
      continue;
    }
    const value = (values[parameter.name] ?? "").trim();
    if (!parameter.hasDefault && !value && parameter.type !== "boolean") {
      return { ok: false, error: `${parameter.displayName} is required.` };
    }
    if (parameter.type === "number" && value && !Number.isFinite(Number(value))) {
      return { ok: false, error: `${parameter.displayName} must be a number.` };
    }
    if (parameter.values.length && !parameter.values.includes(value)) {
      return {
        ok: false,
        error: `${parameter.displayName} must be one of: ${parameter.values.join(", ")}.`,
      };
    }
    if (!parameter.hasDefault || value !== parameter.defaultValue) {
      templateParameters[parameter.name] = value;
    }
  }
  return { ok: true, templateParameters };
}

/** Queue-time variables that changed; empty secrets keep their stored value. */
export function variablePayload(
  variables: readonly { name: string; value: string; isSecret: boolean }[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const variable of variables) {
    const value = values[variable.name];
    if (value === undefined) continue;
    if (variable.isSecret ? value !== "" : value !== variable.value) {
      changed[variable.name] = value;
    }
  }
  return changed;
}
