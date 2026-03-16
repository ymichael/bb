import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export interface DynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type ToolCallForwarder = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: string; isError?: boolean }>;

/**
 * Builds Pi-compatible ToolDefinition objects from dynamic tool definitions
 * that forward execution back to the daemon via the bridge protocol.
 */
export function buildDynamicTools(
  dynamicTools: DynamicToolDefinition[],
  forwardToolCall: ToolCallForwarder,
): ToolDefinition[] {
  return dynamicTools.map((def) => {
    const parameters = buildTypeBoxSchema(def.inputSchema);
    return {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters,
      async execute(
        _toolCallId: string,
        params: Record<string, unknown>,
        _signal: AbortSignal | undefined,
      ) {
        const result = await forwardToolCall(def.name, params);
        return {
          content: [{ type: "text" as const, text: result.content }],
          details: {},
          ...(result.isError ? { isError: true } : {}),
        };
      },
    } as ToolDefinition;
  });
}

function buildTypeBoxSchema(inputSchema: unknown): TSchema {
  const schema = toJsonSchemaObject(inputSchema);
  if (!schema) {
    return Type.Object({});
  }
  return toTypeBoxSchema(schema);
}

interface JsonSchemaObject {
  type?: unknown;
  properties?: unknown;
  items?: unknown;
  enum?: unknown;
  required?: unknown;
}

function toTypeBoxSchema(schema: JsonSchemaObject): TSchema {
  const enumValues = toEnumValues(schema.enum);
  if (enumValues) {
    return enumValues.length > 0 ? Type.Union(enumValues) : Type.Unknown();
  }

  switch (schema.type) {
    case "object":
      return toObjectSchema(schema);
    case "array":
      return Type.Array(toArrayItemSchema(schema.items));
    case "string":
      return Type.String();
    case "number":
    case "integer":
      return Type.Number();
    case "boolean":
      return Type.Boolean();
    case undefined:
      if (schema.properties) {
        return toObjectSchema(schema);
      }
      return Type.Unknown();
    default:
      // JSON Schema is provider-owned here, so unsupported shapes intentionally degrade.
      return Type.Unknown();
  }
}

function toObjectSchema(schema: JsonSchemaObject): TSchema {
  const properties = toPropertiesRecord(schema.properties);
  const required = new Set(toStringArray(schema.required));
  const shape: Record<string, TSchema> = {};

  for (const [key, value] of Object.entries(properties)) {
    const propertySchema = toTypeBoxSchema(value);
    shape[key] = required.has(key)
      ? propertySchema
      : Type.Optional(propertySchema);
  }

  return Type.Object(shape);
}

function toArrayItemSchema(items: unknown): TSchema {
  const schema = toJsonSchemaObject(items);
  return schema ? toTypeBoxSchema(schema) : Type.Unknown();
}

function toEnumValues(enumValues: unknown): TSchema[] | null {
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    return null;
  }

  const literals: TSchema[] = [];
  for (const value of enumValues) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      literals.push(Type.Literal(value));
    }
  }

  return literals.length > 0 ? literals : null;
}

function toJsonSchemaObject(value: unknown): JsonSchemaObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchemaObject;
}

function toPropertiesRecord(
  value: unknown,
): Record<string, JsonSchemaObject> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, JsonSchemaObject> = {};
  for (const [key, property] of Object.entries(value)) {
    const schema = toJsonSchemaObject(property);
    if (schema) {
      result[key] = schema;
    }
  }
  return result;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
