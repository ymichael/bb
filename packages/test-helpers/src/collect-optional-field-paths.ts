import { z } from "zod";

type ZodSchema = z.core.$ZodType;
type ZodSchemaMap = Record<string, ZodSchema>;

function unwrapSchema(schema: ZodSchema): ZodSchema {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodExactOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly
  ) {
    return unwrapSchema(schema.unwrap());
  }
  if (schema instanceof z.ZodPipe) {
    return unwrapSchema(schema.in);
  }
  return schema;
}

export function collectOptionalFieldPaths(schemas: ZodSchemaMap): string[] {
  const paths = new Set<string>();

  function walk(schema: ZodSchema, prefix: string): void {
    const unwrapped = unwrapSchema(schema);
    if (unwrapped instanceof z.ZodObject) {
      const shape = unwrapped.shape;
      for (const key in shape) {
        const value = shape[key];
        const path = `${prefix}.${key}`;
        if (
          value instanceof z.ZodOptional ||
          value instanceof z.ZodExactOptional
        ) {
          paths.add(path);
        }
        walk(value, path);
      }
      return;
    }
    if (unwrapped instanceof z.ZodDiscriminatedUnion) {
      for (const option of unwrapped.options.values()) {
        walk(option, prefix);
      }
      return;
    }
    if (unwrapped instanceof z.ZodUnion) {
      for (const option of unwrapped.options) {
        walk(option, prefix);
      }
      return;
    }
    if (unwrapped instanceof z.ZodIntersection) {
      walk(unwrapped.def.left, prefix);
      walk(unwrapped.def.right, prefix);
    }
  }

  for (const [name, schema] of Object.entries(schemas)) {
    walk(schema, name);
  }

  return [...paths].sort();
}
