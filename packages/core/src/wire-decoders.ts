import type {
  SystemShutdownBlockedResponse,
  SystemShutdownBlockingThread,
} from "./api-types.js";
import type { ThreadStatus } from "./types.js";
import { getStringField, toRecord } from "./unknown-helpers.js";

const THREAD_STATUSES = [
  "created",
  "provisioning",
  "provisioned",
  "provisioning_failed",
  "error",
  "idle",
  "active",
] as const satisfies readonly ThreadStatus[];

function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === "string" && THREAD_STATUSES.includes(value as ThreadStatus);
}

export function decodeThreadIdFromWireValue(value: unknown): string | undefined {
  const payload = toRecord(value);
  if (!payload) return undefined;

  return (
    getStringField(payload, "threadId") ??
    getStringField(payload, "thread_id") ??
    getStringField(payload, "conversationId") ??
    getStringField(payload, "conversation_id") ??
    getStringField(toRecord(payload.thread), "id")
  );
}

function decodeSystemShutdownBlockingThread(
  value: unknown,
): SystemShutdownBlockingThread | null {
  const record = toRecord(value);
  if (!record) return null;

  const id = getStringField(record, "id");
  const projectId = getStringField(record, "projectId");
  const status = record.status;
  if (!id || !projectId || !isThreadStatus(status)) {
    return null;
  }

  return {
    id,
    projectId,
    status,
  };
}

export function decodeSystemShutdownBlockedResponse(
  value: unknown,
): SystemShutdownBlockedResponse | null {
  const record = toRecord(value);
  if (!record || record.code !== "shutdown_blocked") {
    return null;
  }

  const blockingThreadsRaw = Array.isArray(record.blockingThreads)
    ? record.blockingThreads
    : [];
  const blockingThreads = blockingThreadsRaw
    .map((entry) => decodeSystemShutdownBlockingThread(entry))
    .filter((entry): entry is SystemShutdownBlockingThread => entry !== null);

  return {
    code: "shutdown_blocked",
    message:
      getStringField(record, "message") ??
      "Server shutdown blocked by active thread work",
    blockingThreads,
  };
}
