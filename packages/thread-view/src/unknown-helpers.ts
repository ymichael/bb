function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
