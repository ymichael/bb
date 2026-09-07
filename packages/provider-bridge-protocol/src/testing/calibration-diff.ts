import type { ThreadEvent } from "@bb/domain";

export interface NormalizeCalibrationEventsOptions {
  internedIdFields?: readonly string[];
}

const DEFAULT_INTERNED_ID_FIELDS = [
  "turnId",
  "itemId",
  "id",
  "parentToolCallId",
] as const;

const BLANKED_FIELDS = new Set(["threadId", "providerThreadId"]);

const DROPPED_FIELDS = new Set(["providerCheckpointId"]);

class IdInterner {
  private readonly assigned = new Map<string, string>();

  intern(value: string): string {
    const existing = this.assigned.get(value);
    if (existing !== undefined) {
      return existing;
    }
    const token = `#${this.assigned.size + 1}`;
    this.assigned.set(value, token);
    return token;
  }
}

function normalizeValue(
  value: unknown,
  interner: IdInterner,
  idFields: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, interner, idFields));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || DROPPED_FIELDS.has(key)) {
      continue;
    }
    if (BLANKED_FIELDS.has(key)) {
      normalized[key] = entry === null ? null : "";
      continue;
    }
    if (idFields.has(key) && typeof entry === "string") {
      normalized[key] = interner.intern(entry);
      continue;
    }
    normalized[key] = normalizeValue(entry, interner, idFields);
  }
  return normalized;
}

export function normalizeCalibrationEvents(
  events: readonly ThreadEvent[],
  options: NormalizeCalibrationEventsOptions = {},
): unknown[] {
  const interner = new IdInterner();
  const idFields = new Set<string>(
    options.internedIdFields ?? DEFAULT_INTERNED_ID_FIELDS,
  );
  const wireShaped: unknown = JSON.parse(JSON.stringify(events));
  const list = Array.isArray(wireShaped) ? wireShaped : [];
  return list.map((event) => normalizeValue(event, interner, idFields));
}

export interface CalibrationStreamDiff {
  onlyInBridge: unknown[];
  onlyInLegacy: unknown[];
}

export function diffCalibrationStreams(
  legacy: readonly unknown[],
  bridge: readonly unknown[],
): CalibrationStreamDiff {
  const left = legacy.map((event) => JSON.stringify(event));
  const right = bridge.map((event) => JSON.stringify(event));
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const onlyInLegacy: unknown[] = [];
  const onlyInBridge: unknown[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      onlyInLegacy.push(legacy[i]);
      i += 1;
    } else {
      onlyInBridge.push(bridge[j]);
      j += 1;
    }
  }
  onlyInLegacy.push(...legacy.slice(i));
  onlyInBridge.push(...bridge.slice(j));
  return { onlyInLegacy, onlyInBridge };
}

export function describeCalibrationEvents(
  events: readonly unknown[],
): string[] {
  return events.map((event) => {
    if (event === null || typeof event !== "object") {
      return String(event);
    }
    const record: Record<string, unknown> = { ...event };
    const type = typeof record.type === "string" ? record.type : "?";
    const item = record.item;
    if (item !== null && typeof item === "object" && "type" in item) {
      return `${type}:${String((item as { type: unknown }).type)}`;
    }
    return type;
  });
}
