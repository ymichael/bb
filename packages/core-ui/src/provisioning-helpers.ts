import { getMessageStartedAt } from "./format-helpers.js";
import type {
  ProvisioningTranscriptEntry,
  ViewMessage,
  ViewProvisioningMetadata,
  ViewProvisioningTranscriptEntry,
} from "@bb/domain";

// --- Helpers used by to-view-messages.ts (event -> view decoding) ---

export function readProvisioningTranscript(
  entries: ProvisioningTranscriptEntry[] | undefined,
): ViewProvisioningTranscriptEntry[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const result: ViewProvisioningTranscriptEntry[] = [];
  for (const entry of entries) {
    const key = entry.key?.trim();
    if (!key) continue;

    const text = (entry.text ?? "").trim();
    if (!text) continue;

    if (entry.type === "step") {
      result.push({
        type: "step",
        key,
        text,
        status: entry.status ?? "started",
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    } else if (entry.type === "output") {
      result.push({
        type: "output",
        key,
        text,
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
      });
    }
  }

  return result.length > 0 ? result : undefined;
}

// --- Helpers used by thread-detail-rows.ts (row-level merging) ---

function isProvisioningOperation(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "operation" }> {
  if (message.kind !== "operation") return false;
  return message.opType === "thread-provisioning";
}

function mergeProvisioningTranscript(
  existing: ViewProvisioningTranscriptEntry[] | undefined,
  incoming: ViewProvisioningTranscriptEntry[] | undefined,
): ViewProvisioningTranscriptEntry[] | undefined {
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

function mergeProvisioningMetadata(
  existing: ViewProvisioningMetadata | undefined,
  incoming: ViewProvisioningMetadata | undefined,
): ViewProvisioningMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.transcript
        ? { transcript: mergeProvisioningTranscript(undefined, incoming.transcript) }
        : {}),
    };
  }

  const transcript = mergeProvisioningTranscript(existing.transcript, incoming.transcript);
  return {
    environmentId: incoming.environmentId ?? existing.environmentId,
    ...(transcript ? { transcript } : {}),
  };
}

function isThreadInterruptedOperation(
  message: ViewMessage,
): message is Extract<ViewMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "thread-interrupted";
}

export function mergeProvisioningOperations(messages: ViewMessage[]): ViewMessage[] {
  const merged: ViewMessage[] = [];
  let active: Array<Extract<ViewMessage, { kind: "operation" }>> = [];
  let bufferedInterruptions: ViewMessage[] = [];

  const flush = () => {
    if (active.length === 0) return;
    if (active.length === 1) {
      const single = active[0];
      if (single) {
        merged.push(single);
      }
      active = [];
      return;
    }

    const first = active[0];
    const last = active[active.length - 1];
    if (!first || !last) {
      active = [];
      return;
    }

    const mergedStatus =
      active.some((message) => message.status === "completed")
        ? "completed"
        : active.some((message) => message.status === "error")
          ? "error"
          : active.some((message) => message.status === "interrupted")
            ? "interrupted"
            : "pending";
    const details = active
      .map((message) => message.detail?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueDetailLines = [...new Set(details)];
    const provisioning = active.reduce<ViewProvisioningMetadata | undefined>(
      (acc, message) => mergeProvisioningMetadata(acc, message.provisioning),
      undefined,
    );
    const title = (() => {
      if (mergedStatus === "interrupted") return "Provisioning thread interrupted";
      if (mergedStatus === "error") return "Provisioning thread failed";
      return mergedStatus === "completed" ? "Provisioned thread" : "Provisioning thread";
    })();

    merged.push({
      kind: "operation",
      id: first.id,
      threadId: first.threadId,
      sourceSeqStart: Math.min(...active.map((message) => message.sourceSeqStart)),
      sourceSeqEnd: Math.max(...active.map((message) => message.sourceSeqEnd)),
      createdAt: Math.max(...active.map((message) => message.createdAt)),
      startedAt: Math.min(...active.map((message) => getMessageStartedAt(message))),
      turnId: first.turnId ?? last.turnId,
      opType: "thread-provisioning",
      title,
      detail: uniqueDetailLines.length > 0 ? uniqueDetailLines.join("\n") : undefined,
      status: mergedStatus,
      ...(provisioning ? { provisioning } : {}),
    });

    active = [];
  };

  const flushBufferedInterruptions = () => {
    if (bufferedInterruptions.length === 0) return;
    merged.push(...bufferedInterruptions);
    bufferedInterruptions = [];
  };

  for (const message of messages) {
    if (!isProvisioningOperation(message)) {
      if (active.length > 0 && isThreadInterruptedOperation(message)) {
        bufferedInterruptions.push(message);
        continue;
      }
      flush();
      flushBufferedInterruptions();
      merged.push(message);
      continue;
    }

    active.push(message);
  }

  flush();
  flushBufferedInterruptions();
  return merged;
}
