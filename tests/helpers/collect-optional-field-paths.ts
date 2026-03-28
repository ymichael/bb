import { z } from "zod";

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault
  ) {
    return unwrapSchema(schema._def.innerType);
  }
  if (schema instanceof z.ZodEffects) {
    return unwrapSchema(schema._def.schema);
  }
  return schema;
}

export function collectOptionalFieldPaths(
  schemas: Record<string, z.ZodTypeAny>,
): string[] {
  const paths = new Set<string>();

  function walk(schema: z.ZodTypeAny, prefix: string): void {
    const unwrapped = unwrapSchema(schema);
    if (unwrapped instanceof z.ZodObject) {
      const shape = unwrapped._def.shape();
      for (const [key, value] of Object.entries(shape)) {
        const path = `${prefix}.${key}`;
        if (value instanceof z.ZodOptional) {
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
      for (const option of unwrapped._def.options) {
        walk(option, prefix);
      }
      return;
    }
    if (unwrapped instanceof z.ZodIntersection) {
      walk(unwrapped._def.left, prefix);
      walk(unwrapped._def.right, prefix);
    }
  }

  for (const [name, schema] of Object.entries(schemas)) {
    walk(schema, name);
  }

  return [...paths].sort();
}
