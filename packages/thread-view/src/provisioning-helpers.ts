import type { ProvisioningTranscriptEntry } from "@bb/domain";
import type {
  EventProjectionOperationMessage,
  EventProjectionProvisioningMetadata,
  EventProjectionProvisioningTranscriptEntry,
} from "./event-projection-types.js";

export function readProvisioningTranscript(
  entries: ProvisioningTranscriptEntry[] | undefined,
): EventProjectionProvisioningTranscriptEntry[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const result: EventProjectionProvisioningTranscriptEntry[] = [];
  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) continue;

    const text = entry.text.trim();
    if (!text) continue;

    if (entry.type === "step") {
      result.push({
        type: "step",
        key,
        text,
        status: entry.status ?? "started",
        ...(entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    } else if (entry.type === "output") {
      result.push({
        type: "output",
        key,
        text,
        ...(entry.startedAt !== undefined
          ? { startedAt: entry.startedAt }
          : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    }
  }

  return result.length > 0 ? result : undefined;
}

export function provisioningKey(
  message: EventProjectionOperationMessage,
): string {
  return message.provisioning?.provisioningId ?? message.id;
}

export function provisioningTitleForStatus(
  status: EventProjectionOperationMessage["status"],
): string {
  switch (status) {
    case "completed":
      return "Provisioned thread";
    case "error":
      return "Provisioning thread failed";
    case "interrupted":
      return "Provisioning thread interrupted";
    case "pending":
    case undefined:
      return "Provisioning thread";
  }
}

/** Transcript entries arrive as deltas, so merging is concatenation. */
function mergeTranscriptEntries(
  existing: EventProjectionProvisioningTranscriptEntry[] | undefined,
  incoming: EventProjectionProvisioningTranscriptEntry[] | undefined,
): EventProjectionProvisioningTranscriptEntry[] | undefined {
  if (!incoming) {
    return existing?.map((entry) => ({ ...entry }));
  }
  if (!existing) {
    return incoming.map((entry) => ({ ...entry }));
  }

  return [
    ...existing.map((entry) => ({ ...entry })),
    ...incoming.map((entry) => ({ ...entry })),
  ];
}

export function mergeProvisioningMetadata(
  existing: EventProjectionProvisioningMetadata | undefined,
  incoming: EventProjectionProvisioningMetadata | undefined,
): EventProjectionProvisioningMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.transcript
        ? {
            transcript: mergeTranscriptEntries(
              undefined,
              incoming.transcript,
            ),
          }
        : {}),
    };
  }

  const transcript = mergeTranscriptEntries(
    existing.transcript,
    incoming.transcript,
  );
  return {
    environmentId: incoming.environmentId ?? existing.environmentId,
    provisioningId: incoming.provisioningId,
    ...(transcript ? { transcript } : {}),
  };
}
