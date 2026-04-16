import type { JsonRpcMessage } from "../runtime-json-rpc.js";

export interface StringRecord {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is StringRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getRecordProperty(
  value: StringRecord,
  key: string,
): StringRecord | null {
  const next = value[key];
  return isRecord(next) ? next : null;
}

export function getStringProperty(
  value: StringRecord,
  key: string,
): string | undefined {
  const next = value[key];
  return typeof next === "string" ? next : undefined;
}

export function getRawSdkMessage(event: JsonRpcMessage): StringRecord | null {
  if (event.method !== "sdk/message") {
    return null;
  }
  if (!isRecord(event.params)) {
    return null;
  }
  const message = event.params["message"];
  return isRecord(message) ? message : null;
}

export function getMessageContentTypes(message: StringRecord): string[] {
  const messagePayload = getRecordProperty(message, "message");
  const content = messagePayload?.["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  const types = new Set<string>();
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = getStringProperty(block, "type");
    if (!type) continue;
    types.add(type);
  }
  return [...types];
}
