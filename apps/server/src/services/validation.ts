import type { Context } from "hono";
import type { ZodType, ZodTypeAny } from "zod";
import { ZodError } from "zod";
import { ApiError } from "../errors.js";

export async function parseJsonBody<T>(
  context: Context,
  schema: ZodType<T>,
): Promise<T> {
  let payload: unknown;
  try {
    payload = await context.req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid JSON request body");
  }

  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ApiError(400, "invalid_request", error.issues[0]?.message ?? "Invalid request");
    }
    throw error;
  }
}

export function parseValue<TSchema extends ZodTypeAny>(
  value: unknown,
  schema: TSchema,
): ReturnType<TSchema["parse"]> {
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

export function parseQueryValue(
  value: string | undefined,
  name: string,
): string {
  if (!value || value.trim().length === 0) {
    throw new ApiError(400, "invalid_request", `Missing query parameter: ${name}`);
  }
  return value;
}

export function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ApiError(400, "invalid_request", `Invalid boolean value: ${value}`);
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
