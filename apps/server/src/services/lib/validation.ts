import type { output, ZodType } from "zod";
import { ZodError } from "zod";
import { ApiError } from "../../errors.js";

export function parseValue<TSchema extends ZodType>(
  value: unknown,
  schema: TSchema,
): output<TSchema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(
        400,
        "invalid_request",
        error.issues[0]?.message ?? "Invalid request",
      );
    }
    throw error;
  }
}

export function parseInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_request", `Invalid integer for ${name}`);
  }
  return parsed;
}

export function parseOptionalInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, "invalid_request", `Invalid integer for ${name}`);
  }
  return parsed;
}
