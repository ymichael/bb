import { getMessageStartedAt } from "./format-helpers.js";
import type {
  ViewMessage,
  ViewProvisioningMetadata,
  ViewProvisioningTranscriptEntry,
} from "@bb/domain";

// --- Helpers used by to-view-messages.ts (event -> view decoding) ---

export function readProvisioningTranscript(
  entries: Array<{ type: string; key: string; text?: string; startedAt?: number; status?: string; metadata?: Record<string, unknown> }> | undefined,
): ViewProvisioningTranscriptEntry[] | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;

  const result: ViewProvisioningTranscriptEntry[] = [];
  for (const entry of entries) {
    const key = entry.key?.trim();
    if (!key) continue;

    const text = (entry.text ?? "").trim();
    if (!text) continue;

    if (entry.type === "step") {
      const status = entry.status as "started" | "completed" | "failed" | undefined;
      result.push({
        type: "step",
        key,
        text,
        ...(status ? { status } : { status: "started" }),
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
  return message.opType === "provisioning";
}

function mergeProvisioningTranscriptEntry(
  existing: ViewProvisioningTranscriptEntry | undefined,
  incoming: ViewProvisioningTranscriptEntry,
): ViewProvisioningTranscriptEntry {
  if (!existing) {
    return { ...incoming };
  }

  // Output entries are append-only (unique keys, never merge)
  if (incoming.type === "output") {
    return { ...incoming };
  }

  // Steps with same key: latest wins
  if (existing.type === "step" && incoming.type === "step") {
    return {
      type: "step",
      key: existing.key,
      text: incoming.text,
      ...(incoming.status ? { status: incoming.status } : {}),
      ...(incoming.startedAt !== undefined ? { startedAt: incoming.startedAt } : existing.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
      ...(incoming.metadata ? { metadata: incoming.metadata } : existing.metadata ? { metadata: existing.metadata } : {}),
    };
  }

  return { ...incoming };
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

  const merged = new Map<string, ViewProvisioningTranscriptEntry>();
  const order: string[] = [];
  for (const entry of existing) {
    const key = entry.key;
    order.push(key);
    merged.set(key, { ...entry });
  }
  for (const entry of incoming) {
    const key = entry.key;
    if (!merged.has(key)) {
      order.push(key);
    }
    merged.set(key, mergeProvisioningTranscriptEntry(merged.get(key), entry));
  }
  return order
    .map((key) => merged.get(key))
    .filter((entry): entry is ViewProvisioningTranscriptEntry => Boolean(entry));
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
      if (mergedStatus === "interrupted") return "Provisioning environment interrupted";
      if (mergedStatus === "error") return "Provisioning environment failed";
      return mergedStatus === "completed" ? "Provisioned environment" : "Provisioning environment";
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
      opType: "provisioning",
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
