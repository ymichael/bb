import Ajv from "ajv";
import { z } from "zod";
import { canonicalizeJson } from "./cache.js";
import type {
  JsonObject,
  JsonSchema,
  JsonValue,
  WorkflowAgentOptions,
} from "./types.js";

export const MAX_WORKFLOW_SOURCE_BYTES = 512 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_SCHEMA_NODES = 4_096;
const MAX_SCHEMA_PROPERTIES = 256;
const MAX_SCHEMA_ENUM_VALUES = 256;

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$comment",
  "additionalProperties",
  "const",
  "default",
  "deprecated",
  "description",
  "enum",
  "examples",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "nullable",
  "properties",
  "readOnly",
  "required",
  "title",
  "type",
  "writeOnly",
]);

const UNSAFE_SCHEMA_KEYWORD_REASONS: Readonly<Record<string, string>> = {
  $dynamicRef: "dynamic references can create unbounded recursive validation",
  $recursiveRef: "recursive references can create unbounded validation",
  $ref: "references can create recursive or disproportionately repeated validation",
  allOf: "schema combinators can multiply validation work",
  anyOf: "schema combinators can multiply validation work",
  contains:
    "contains may scan an unbounded array and evaluate nested schemas repeatedly",
  dependentSchemas: "dependent schemas can multiply validation work",
  dependencies: "dependencies can multiply validation work",
  else: "conditional schema combinators can multiply validation work",
  format: "format validators may execute unbounded host-side validation code",
  if: "conditional schema combinators can multiply validation work",
  not: "schema combinators can multiply validation work",
  oneOf: "schema combinators can multiply validation work",
  pattern: "regular expressions can exhibit catastrophic backtracking",
  patternProperties:
    "regular expressions can exhibit catastrophic backtracking",
  propertyNames:
    "property-name schemas may apply validation to an unbounded set of keys",
  then: "conditional schema combinators can multiply validation work",
  unevaluatedItems: "unevaluated-item tracking can multiply validation work",
  unevaluatedProperties:
    "unevaluated-property tracking can multiply validation work",
  uniqueItems: "uniqueness checks can grow superlinearly with array size",
};

const HIDDEN_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

export function assertValidWorkflowSourceText(source: string): void {
  const sizeBytes = new TextEncoder().encode(source).byteLength;
  if (sizeBytes > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(
      `Workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes (${sizeBytes} bytes)`,
    );
  }
  const match = HIDDEN_CONTROL_CHARACTER.exec(source);
  if (match !== null) {
    const codePoint = match[0]!.codePointAt(0)!;
    const before = source.slice(0, match.index);
    const line = before.split("\n").length;
    const column = before.length - before.lastIndexOf("\n");
    throw new Error(
      `Workflow source contains hidden control character U+${codePoint
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")} at ${line}:${column}`,
    );
  }
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const jsonSchemaValueSchema = z.union([
  z.boolean(),
  z.record(z.string(), z.json()),
]);

const storedAgentOptionsSchema = z
  .object({
    selection: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        reasoningLevel: z.string().min(1),
      })
      .strict()
      .nullable(),
    outputSchema: jsonSchemaValueSchema.nullable(),
    title: z.string().min(1).nullable(),
    phase: z.string().min(1).nullable().default(null),
  })
  .strict();

export function parseStoredAgentOptions(value: unknown): WorkflowAgentOptions {
  const options = storedAgentOptionsSchema.parse(value) as WorkflowAgentOptions;
  if (options.outputSchema !== null) {
    assertValidJsonSchema(options.outputSchema, "stored agent outputSchema");
  }
  return options;
}

function optionalNonEmptyString(
  object: JsonObject,
  key: string,
): string | null {
  const value = object[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`agent options.${key} must be a non-empty string`);
  }
  return value;
}

export function assertValidJsonSchema(
  schema: JsonValue,
  path: string,
): asserts schema is JsonSchema {
  if (typeof schema !== "boolean" && !isObject(schema)) {
    throw new Error(`${path} must be a JSON Schema object or boolean`);
  }
  const stack: Array<{
    value: unknown;
    depth: number;
    path: string;
    exiting?: boolean;
  }> = [{ value: schema, depth: 0, path }];
  const ancestors = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.exiting) {
      ancestors.delete(current.value as object);
      continue;
    }
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(`${path} exceeds the ${MAX_SCHEMA_NODES}-node limit`);
    }
    if (current.depth > MAX_SCHEMA_DEPTH) {
      throw new Error(
        `${path} exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}`,
      );
    }
    const value = current.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`${current.path} contains a non-finite number`);
      }
      continue;
    }
    if (typeof value !== "object") {
      throw new Error(`${current.path} contains a non-JSON value`);
    }
    if (ancestors.has(value)) {
      throw new Error(`${current.path} contains a cyclic value`);
    }
    ancestors.add(value);
    stack.push({ ...current, exiting: true });
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new Error(`${current.path} contains a sparse or decorated array`);
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: value[index],
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
        });
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          `${current.path} contains an object with an unsafe prototype`,
        );
      }
      const keys = Reflect.ownKeys(value);
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        if (typeof key !== "string") {
          throw new Error(`${current.path} contains a symbol-keyed property`);
        }
        if (
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype"
        ) {
          throw new Error(
            `${current.path} contains forbidden key ${JSON.stringify(key)}`,
          );
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        ) {
          throw new Error(`${current.path}.${key} contains an unsafe property`);
        }
        stack.push({
          value: descriptor.value,
          depth: current.depth + 1,
          path: `${current.path}.${key}`,
        });
      }
    }
  }
  const serialized = JSON.stringify(schema);
  if (serialized === undefined) throw new Error(`${path} is not JSON`);
  const sizeBytes = new TextEncoder().encode(serialized).byteLength;
  if (sizeBytes > MAX_SCHEMA_BYTES) {
    throw new Error(
      `${path} exceeds the ${MAX_SCHEMA_BYTES} byte limit (${sizeBytes} bytes)`,
    );
  }

  assertSupportedSchema(schema, path);
  try {
    new Ajv({ strict: false, allErrors: true }).compile(schema);
  } catch (error) {
    throw new Error(
      `${path} is not a valid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertSupportedSchema(schema: JsonSchema, path: string): void {
  if (typeof schema === "boolean") return;
  for (const keyword of Object.keys(schema)) {
    if (SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) continue;
    const reason = UNSAFE_SCHEMA_KEYWORD_REASONS[keyword];
    if (reason !== undefined) {
      throw new Error(
        `${path}.${keyword} is not supported by the safe workflow schema subset: ${reason}; schema validation runs in the Node host, outside the QuickJS deadline`,
      );
    }
    throw new Error(
      `${path}.${keyword} is not supported by the safe workflow schema subset`,
    );
  }

  const properties = schema.properties;
  if (properties !== undefined) {
    if (!isObject(properties)) {
      throw new Error(`${path}.properties must be an object`);
    }
    const entries = Object.entries(properties);
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      throw new Error(
        `${path}.properties exceeds the ${MAX_SCHEMA_PROPERTIES}-property limit`,
      );
    }
    for (const [name, child] of entries) {
      if (typeof child !== "boolean" && !isObject(child)) {
        throw new Error(`${path}.properties.${name} must be a schema`);
      }
      assertSupportedSchema(child, `${path}.properties.${name}`);
    }
  }

  const items = schema.items;
  if (items !== undefined) {
    if (typeof items !== "boolean" && !isObject(items)) {
      throw new Error(`${path}.items must be a single schema`);
    }
    assertSupportedSchema(items, `${path}.items`);
  }

  const additionalProperties = schema.additionalProperties;
  if (
    additionalProperties !== undefined &&
    typeof additionalProperties !== "boolean"
  ) {
    if (!isObject(additionalProperties)) {
      throw new Error(
        `${path}.additionalProperties must be a boolean or schema`,
      );
    }
    assertSupportedSchema(additionalProperties, `${path}.additionalProperties`);
  }

  const enumValues = schema.enum;
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues)) {
      throw new Error(`${path}.enum must be an array`);
    }
    if (enumValues.length > MAX_SCHEMA_ENUM_VALUES) {
      throw new Error(
        `${path}.enum exceeds the ${MAX_SCHEMA_ENUM_VALUES}-value limit`,
      );
    }
    if (
      enumValues.some((value) => value !== null && typeof value === "object")
    ) {
      throw new Error(
        `${path}.enum supports only scalar values in the safe workflow schema subset`,
      );
    }
  }
}

export function parseAgentOptions(
  value: JsonValue | undefined,
): WorkflowAgentOptions {
  if (value === undefined) {
    return {
      selection: null,
      outputSchema: null,
      title: null,
      phase: null,
    };
  }
  if (!isObject(value)) throw new Error("agent options must be an object");

  const allowed = new Set([
    "provider",
    "model",
    "reasoningLevel",
    "outputSchema",
    "schema",
    "title",
    "label",
    "phase",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(`Unknown agent option ${JSON.stringify(key)}`);
  }

  const provider = optionalNonEmptyString(value, "provider");
  const model = optionalNonEmptyString(value, "model");
  const reasoningLevel = optionalNonEmptyString(value, "reasoningLevel");
  const selectionCount = [provider, model, reasoningLevel].filter(
    (item) => item !== null,
  ).length;
  if (selectionCount !== 0 && selectionCount !== 3) {
    throw new Error(
      "agent options must provide provider, model, and reasoningLevel together, or omit all three",
    );
  }

  const hasOutputSchema = Object.hasOwn(value, "outputSchema");
  const hasSchema = Object.hasOwn(value, "schema");
  const outputSchemaAlias = hasOutputSchema ? value.outputSchema! : null;
  const schemaAlias = hasSchema ? value.schema! : null;
  if (outputSchemaAlias !== null) {
    assertValidJsonSchema(outputSchemaAlias, "agent options.outputSchema");
  }
  if (schemaAlias !== null) {
    assertValidJsonSchema(schemaAlias, "agent options.schema");
  }
  if (
    hasOutputSchema &&
    hasSchema &&
    canonicalizeJson(outputSchemaAlias) !== canonicalizeJson(schemaAlias)
  ) {
    throw new Error(
      "agent options.outputSchema and agent options.schema must be structurally identical when both are provided",
    );
  }
  const outputSchema = hasOutputSchema ? outputSchemaAlias : schemaAlias;

  const title = optionalNonEmptyString(value, "title");
  const label = optionalNonEmptyString(value, "label");
  if (title !== null && label !== null && title !== label) {
    throw new Error(
      "agent options.title and agent options.label must match when both are provided",
    );
  }

  return {
    selection:
      provider !== null && model !== null && reasoningLevel !== null
        ? { provider, model, reasoningLevel }
        : null,
    outputSchema,
    title: title ?? label,
    phase: optionalNonEmptyString(value, "phase"),
  };
}
