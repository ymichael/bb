function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function extractErrorMessage(
  value: unknown,
  opts?: { legacyKeys?: readonly string[] },
): string | null {
  if (typeof value === "string") {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length === 0) return null;
    return normalized;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractErrorMessage(item, opts);
      if (message) return message;
    }
    return null;
  }
  const record = toRecord(value);
  if (!record) return null;
  if (typeof record.message === "string") {
    const message = extractErrorMessage(record.message, opts);
    if (message) return message;
  }
  for (const key of opts?.legacyKeys ?? ["detail"]) {
    const message = extractErrorMessage(record[key], opts);
    if (message) return message;
  }
  return null;
}
