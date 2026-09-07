import { jsonValueSchema } from "@bb/domain";
import type { JsonValue } from "@get-bb/plugin-sdk";

export function serializePluginPanelParams(
  params: JsonValue | undefined,
): string | null {
  if (params === undefined) return null;
  const result = jsonValueSchema.safeParse(params);
  if (!result.success) {
    throw new Error('"params" must be a JSON value');
  }
  const serialized = JSON.stringify(result.data);
  if (serialized === undefined) {
    throw new Error('"params" must be a JSON value');
  }
  return serialized;
}

export function parsePersistedPluginPanelParams(
  paramsJson: string | null,
): JsonValue | null {
  if (paramsJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(paramsJson);
    const result = jsonValueSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
