import type { ProvisioningTranscriptEntry } from "@bb/domain";
import { getMessageStartedAt } from "./format-helpers.js";
import type {
  UIMessage,
  UIProvisioningMetadata,
  UIProvisioningSetupMetadata,
  UIProvisioningTranscriptEntry,
} from "@bb/domain";

// --- Helpers used by to-ui-messages.ts (event → UI decoding) ---

export function provisioningProgressTitle(
  phase: "prepare_environment" | "start_provider_session" | undefined,
  status: "started" | "completed" | "failed" | undefined,
): string {
  switch (phase) {
    case "prepare_environment":
      switch (status) {
        case "started":
          return "Preparing environment";
        case "completed":
          return "Environment prepared";
        case "failed":
          return "Environment preparation failed";
        default:
          return "Provisioning progress";
      }
    case "start_provider_session":
      switch (status) {
        case "started":
          return "Starting provider session";
        case "completed":
          return "Provider session started";
        case "failed":
          return "Provider session start failed";
        default:
          return "Provisioning progress";
      }
    default:
      return "Provisioning progress";
  }
}

export function readProvisioningTranscript(
  transcript: ProvisioningTranscriptEntry[] | undefined,
): UIProvisioningTranscriptEntry[] | undefined {
  if (!Array.isArray(transcript) || transcript.length === 0) return undefined;

  const entries: UIProvisioningTranscriptEntry[] = [];
  for (const entry of transcript) {
    const key = entry.key?.trim();
    const text = entry.text?.trim();
    if (!key || !text) continue;

    entries.push({
      key,
      text,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    });
  }

  return entries.length > 0 ? entries : undefined;
}

export function getProvisioningProgressFromTranscript(
  transcript: UIProvisioningTranscriptEntry[] | undefined,
): {
  phase?: "prepare_environment" | "start_provider_session";
  status?: "started" | "completed" | "failed";
} {
  const progressEntry = transcript?.find((entry) => entry.key.startsWith("phase:"));
  if (!progressEntry) return {};
  const metadata = progressEntry.metadata ?? null;
  const phase = metadata?.phase;
  const status = metadata?.status;

  return {
    phase: phase === "prepare_environment" || phase === "start_provider_session" ? phase : undefined,
    status: status === "started" || status === "completed" || status === "failed" ? status : undefined,
  };
}

// --- Helpers used by thread-detail-rows.ts (row-level merging) ---

export function isProvisioningOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  if (message.kind !== "operation") return false;
  // opType is open/external; unknown values are intentionally ignored.
  return (
    message.opType === "provisioning-started" ||
    message.opType === "provisioning-progress" ||
    message.opType === "provisioning-env-setup" ||
    message.opType === "provisioning-fallback" ||
    message.opType === "provisioning-completed" ||
    message.opType === "provisioning-cleanup-failed"
  );
}

function appendProvisioningOutput(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!incoming) return existing;
  if (!existing) return incoming;
  if (existing.endsWith("\n") || incoming.startsWith("\n")) {
    return `${existing}${incoming}`;
  }
  return `${existing}\n${incoming}`;
}

export function mergeProvisioningSetup(
  existing: UIProvisioningSetupMetadata | undefined,
  incoming: UIProvisioningSetupMetadata | undefined,
): UIProvisioningSetupMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
    };
  }

  return {
    status: incoming.status,
    startedAt: existing.startedAt ?? incoming.startedAt,
    scriptPath: incoming.scriptPath ?? existing.scriptPath,
    timeoutMs: incoming.timeoutMs ?? existing.timeoutMs,
    durationMs: incoming.durationMs ?? existing.durationMs,
    output: appendProvisioningOutput(existing.output, incoming.output),
  };
}

function provisioningTranscriptEntryKey(entry: UIProvisioningTranscriptEntry): string {
  return entry.key;
}

export function mergeProvisioningTranscriptEntry(
  existing: UIProvisioningTranscriptEntry | undefined,
  incoming: UIProvisioningTranscriptEntry,
): UIProvisioningTranscriptEntry {
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.metadata ? { metadata: { ...incoming.metadata } } : {}),
    };
  }

  const shouldPreserveStartedAt =
    incoming.startedAt === undefined &&
    existing.text === incoming.text;

  return {
    key: existing.key,
    text: incoming.text,
    ...(incoming.startedAt !== undefined
      ? { startedAt: existing.startedAt ?? incoming.startedAt }
      : shouldPreserveStartedAt && existing.startedAt !== undefined
        ? { startedAt: existing.startedAt }
        : {}),
    ...(incoming.metadata ? { metadata: { ...incoming.metadata } } : {}),
  };
}

export function mergeProvisioningTranscript(
  existing: UIProvisioningTranscriptEntry[] | undefined,
  incoming: UIProvisioningTranscriptEntry[] | undefined,
): UIProvisioningTranscriptEntry[] | undefined {
  if (!incoming) {
    return existing?.map((entry) => mergeProvisioningTranscriptEntry(undefined, entry));
  }
  if (!existing) {
    return incoming.map((entry) => mergeProvisioningTranscriptEntry(undefined, entry));
  }

  const merged = new Map<string, UIProvisioningTranscriptEntry>();
  const order: string[] = [];
  for (const entry of existing) {
    const key = provisioningTranscriptEntryKey(entry);
    order.push(key);
    merged.set(key, mergeProvisioningTranscriptEntry(undefined, entry));
  }
  for (const entry of incoming) {
    const key = provisioningTranscriptEntryKey(entry);
    if (!merged.has(key)) {
      order.push(key);
    }
    merged.set(key, mergeProvisioningTranscriptEntry(merged.get(key), entry));
  }
  return order
    .map((key) => merged.get(key))
    .filter((entry): entry is UIProvisioningTranscriptEntry => Boolean(entry));
}

export function mergeProvisioningMetadata(
  existing: UIProvisioningMetadata | undefined,
  incoming: UIProvisioningMetadata | undefined,
): UIProvisioningMetadata | undefined {
  if (!incoming) {
    return existing ? { ...existing } : undefined;
  }
  if (!existing) {
    return {
      ...incoming,
      ...(incoming.setup ? { setup: { ...incoming.setup } } : {}),
      ...(incoming.transcript
        ? { transcript: mergeProvisioningTranscript(undefined, incoming.transcript) }
        : {}),
    };
  }

  const setup = mergeProvisioningSetup(existing.setup, incoming.setup);
  const transcript = mergeProvisioningTranscript(existing.transcript, incoming.transcript);
  return {
    attachedEnvironmentId:
      incoming.attachedEnvironmentId ?? existing.attachedEnvironmentId,
    workspaceRoot: incoming.workspaceRoot ?? existing.workspaceRoot,
    ...(setup ? { setup } : {}),
    ...(transcript ? { transcript } : {}),
  };
}

export function shouldNormalizeProvisioningLifecycleOperation(
  message: Extract<UIMessage, { kind: "operation" }>,
): boolean {
  return (
    message.opType === "provisioning-started" ||
    message.opType === "provisioning-progress" ||
    message.opType === "provisioning-env-setup" ||
    message.opType === "provisioning-completed"
  );
}

function isThreadInterruptedOperation(
  message: UIMessage,
): message is Extract<UIMessage, { kind: "operation" }> {
  return message.kind === "operation" && message.opType === "thread-interrupted";
}

export function mergeProvisioningOperations(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = [];
  let active: Array<Extract<UIMessage, { kind: "operation" }>> = [];
  let bufferedInterruptions: UIMessage[] = [];

  const flush = () => {
    if (active.length === 0) return;
    const single = active[0];
    if (active.length === 1 && single && !shouldNormalizeProvisioningLifecycleOperation(single)) {
      merged.push(single);
      active = [];
      return;
    }

    const first = active[0];
    const last = active[active.length - 1];
    if (!first || !last) {
      active = [];
      return;
    }

    const hasCompleted = active.some((message) => message.opType === "provisioning-completed");
    const hasLifecycleUpdate = active.some(
      (message) => message.opType !== "provisioning-env-setup",
    );
    const lastSetupUpdate = [...active]
      .reverse()
      .find((message) => message.opType === "provisioning-env-setup");
    const mergedStatus =
      active.some((message) => message.status === "error")
        ? "error"
        : hasCompleted
          ? "completed"
          : active.some((message) => message.status === "interrupted")
            ? "interrupted"
            : "pending";
    const details = active
      .map((message) => message.detail?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueDetailLines = [...new Set(details)];
    const provisioning = active.reduce<UIProvisioningMetadata | undefined>(
      (acc, message) => mergeProvisioningMetadata(acc, message.provisioning),
      undefined,
    );
    const title = (() => {
      if (mergedStatus === "interrupted") {
        if (!hasLifecycleUpdate && lastSetupUpdate) {
          return "Environment setup interrupted";
        }
        return "Provisioning environment interrupted";
      }
      if (mergedStatus === "error") {
        if (lastSetupUpdate) {
          return lastSetupUpdate.title === "Environment setup failed"
            ? "Environment setup failed"
            : lastSetupUpdate.title;
        }
        return "Provisioning environment failed";
      }
      if (!hasLifecycleUpdate && lastSetupUpdate) {
        switch (lastSetupUpdate.title) {
          case "Environment setup completed":
            return "Environment setup completed";
          case "Environment setup failed":
            return "Environment setup failed";
          default:
            return "Environment setup...";
        }
      }

      return hasCompleted ? "Provisioned environment" : "Provisioning environment";
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

    if (active.length === 0) {
      flushBufferedInterruptions();
      active = [message];
      continue;
    }

    if (message.opType === "provisioning-started") {
      flush();
      flushBufferedInterruptions();
      active = [message];
      continue;
    }

    active.push(message);
  }

  flush();
  flushBufferedInterruptions();
  return merged;
}
