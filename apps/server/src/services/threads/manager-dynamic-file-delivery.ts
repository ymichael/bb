import { createHash } from "node:crypto";
import path from "node:path";
import {
  getThreadDynamicContextFileState,
  upsertThreadDynamicContextFileState,
  upsertThreadDynamicContextFileStateInTransaction,
} from "@bb/db";
import type { DbTransaction } from "@bb/db";
import type {
  PromptInput,
  Thread,
  ThreadDynamicContextFileStatus,
} from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { requireThreadStoragePath } from "./thread-storage.js";

export const MANAGER_PREFERENCES_FILE_KEY = "manager-preferences";
export const MANAGER_PREFERENCES_FILE_NAME = "PREFERENCES.md";
export const MANAGER_PREFERENCES_INLINE_LIMIT_BYTES = 256 * 1024;

type ManagerPreferencesDeliveryMode = "change-detection" | "first-boot";

interface PrepareManagerPreferencesSystemMessageArgs {
  hostId: string;
  input: PromptInput[];
  mode: ManagerPreferencesDeliveryMode;
  thread: Thread;
}

export interface ManagerDynamicFileDeliveryStateUpdate {
  contentHash: string;
  contentStatus: ThreadDynamicContextFileStatus;
  fileKey: string;
  shownAt: number;
  threadId: string;
}

interface PreparedManagerPreferencesSystemMessage {
  input: PromptInput[];
  stateUpdate: ManagerDynamicFileDeliveryStateUpdate | null;
}

interface DynamicFileSnapshot {
  content: string;
  contentHash: string;
  contentStatus: ThreadDynamicContextFileStatus;
  warningReason: string | null;
}

interface LocalFileMetadata {
  modifiedAtMs: number;
  sizeBytes: number;
}

interface ManagerPreferencesDeliveryLockArgs {
  thread: Pick<Thread, "id" | "type">;
}

interface ManagerPreferencesDeliveryThreadIdLockArgs {
  threadId: string;
}

interface ReadManagerPreferencesFileArgs {
  hostId: string;
  threadStoragePath: string;
}

interface BuildPreferencesSystemMessageArgs {
  mode: ManagerPreferencesDeliveryMode;
  previousStatus: ThreadDynamicContextFileStatus | null;
  snapshot: DynamicFileSnapshot;
}

interface HashPartsArgs {
  parts: readonly string[];
}

type AsyncOperation<TValue> = () => Promise<TValue>;
type LockRelease = () => void;

const deliveryLockTailByKey = new Map<string, Promise<void>>();

function hashParts(args: HashPartsArgs): string {
  const hash = createHash("sha256");
  for (const part of args.parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildFence(content: string): string {
  const matches = content.match(/`+/gu) ?? [];
  const longestRun = matches.reduce(
    (longest, match) => Math.max(longest, match.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

async function withDeliveryLock<TValue>(
  key: string,
  operation: AsyncOperation<TValue>,
): Promise<TValue> {
  const previousTail = deliveryLockTailByKey.get(key) ?? Promise.resolve();
  let releaseLock: LockRelease = () => undefined;
  const currentLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const currentTail = previousTail
    .catch(() => undefined)
    .then(() => currentLock);
  deliveryLockTailByKey.set(key, currentTail);

  await previousTail.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseLock();
    if (deliveryLockTailByKey.get(key) === currentTail) {
      deliveryLockTailByKey.delete(key);
    }
  }
}

async function readHostFileMetadata(
  deps: LoggedWorkSessionDeps,
  args: ReadManagerPreferencesFileArgs & { filePath: string },
): Promise<LocalFileMetadata> {
  const result = await queueCommandAndWait(deps, {
    hostId: args.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "host.file_metadata",
      path: args.filePath,
      rootPath: args.threadStoragePath,
    },
  });
  return {
    modifiedAtMs: result.modifiedAtMs,
    sizeBytes: result.sizeBytes,
  };
}

async function readManagerPreferencesFile(
  deps: LoggedWorkSessionDeps,
  args: ReadManagerPreferencesFileArgs,
): Promise<DynamicFileSnapshot> {
  const filePath = path.join(
    args.threadStoragePath,
    MANAGER_PREFERENCES_FILE_NAME,
  );
  try {
    const result = await queueCommandAndWait(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: filePath,
        rootPath: args.threadStoragePath,
      },
    });
    if (result.contentEncoding !== "utf8") {
      return {
        content: "",
        contentHash: hashParts({
          parts: ["non_utf8", String(result.sizeBytes), result.content],
        }),
        contentStatus: "non_utf8",
        warningReason:
          "The file is not UTF-8 text. Save it as UTF-8 Markdown before relying on it as manager memory.",
      };
    }
    if (result.sizeBytes > MANAGER_PREFERENCES_INLINE_LIMIT_BYTES) {
      return {
        content: "",
        contentHash: hashParts({
          parts: ["too_large", String(result.sizeBytes), result.content],
        }),
        contentStatus: "too_large",
        warningReason:
          "The file is larger than the 256 KiB inline limit. Edit it down before relying on it as manager memory.",
      };
    }
    return {
      content: result.content,
      contentHash: hashParts({ parts: ["present", result.content] }),
      contentStatus: "present",
      warningReason: null,
    };
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "ENOENT") {
      return {
        content: "",
        contentHash: hashParts({ parts: ["missing"] }),
        contentStatus: "missing",
        warningReason: null,
      };
    }
    if (error instanceof ApiError && error.body.code === "file_too_large") {
      let metadata: LocalFileMetadata;
      try {
        metadata = await readHostFileMetadata(deps, {
          filePath,
          hostId: args.hostId,
          threadStoragePath: args.threadStoragePath,
        });
      } catch (metadataError) {
        if (
          metadataError instanceof ApiError &&
          metadataError.body.code === "ENOENT"
        ) {
          return {
            content: "",
            contentHash: hashParts({ parts: ["missing"] }),
            contentStatus: "missing",
            warningReason: null,
          };
        }
        throw metadataError;
      }
      return {
        content: "",
        contentHash: hashParts({
          parts: [
            "too_large",
            String(metadata.sizeBytes),
            String(metadata.modifiedAtMs),
          ],
        }),
        contentStatus: "too_large",
        warningReason:
          "The file is larger than the 256 KiB inline limit. Edit it down before relying on it as manager memory.",
      };
    }
    throw error;
  }
}

function buildPreferencesSystemMessage(
  args: BuildPreferencesSystemMessageArgs,
): string {
  if (args.snapshot.contentStatus === "missing") {
    return renderTemplate("systemMessageManagerPreferencesRemoved", {});
  }
  if (args.snapshot.warningReason !== null) {
    return renderTemplate("systemMessageManagerPreferencesWarning", {
      reason: args.snapshot.warningReason,
    });
  }
  const templateId =
    args.mode === "first-boot" || args.previousStatus === null
      ? "systemMessageManagerPreferencesCurrent"
      : "systemMessageManagerPreferencesUpdated";
  return renderTemplate(templateId, {
    fence: buildFence(args.snapshot.content),
    preferencesContent: args.snapshot.content,
  });
}

export async function withManagerPreferencesDeliveryLock<TValue>(
  args: ManagerPreferencesDeliveryLockArgs,
  operation: AsyncOperation<TValue>,
): Promise<TValue> {
  if (args.thread.type !== "manager") {
    return operation();
  }
  return withDeliveryLock(
    `${args.thread.id}:${MANAGER_PREFERENCES_FILE_KEY}`,
    operation,
  );
}

export async function withManagerPreferencesDeliveryThreadIdLock<TValue>(
  args: ManagerPreferencesDeliveryThreadIdLockArgs,
  operation: AsyncOperation<TValue>,
): Promise<TValue> {
  return withDeliveryLock(
    `${args.threadId}:${MANAGER_PREFERENCES_FILE_KEY}`,
    operation,
  );
}

export async function prependManagerPreferencesSystemMessageIfChanged(
  deps: LoggedWorkSessionDeps,
  args: PrepareManagerPreferencesSystemMessageArgs,
): Promise<PreparedManagerPreferencesSystemMessage> {
  if (args.thread.type !== "manager") {
    return { input: args.input, stateUpdate: null };
  }

  const previous = getThreadDynamicContextFileState(deps.db, {
    fileKey: MANAGER_PREFERENCES_FILE_KEY,
    threadId: args.thread.id,
  });
  const threadStoragePath = await requireThreadStoragePath(deps, {
    hostId: args.hostId,
    threadId: args.thread.id,
  });
  const snapshot = await readManagerPreferencesFile(deps, {
    hostId: args.hostId,
    threadStoragePath,
  });

  if (previous === null && snapshot.contentStatus === "missing") {
    return { input: args.input, stateUpdate: null };
  }
  if (
    previous !== null &&
    previous.contentHash === snapshot.contentHash &&
    previous.contentStatus === snapshot.contentStatus
  ) {
    return { input: args.input, stateUpdate: null };
  }

  const message = buildPreferencesSystemMessage({
    mode: args.mode,
    previousStatus: previous?.contentStatus ?? null,
    snapshot,
  });
  const shownAt = Date.now();
  return {
    input: [
      { type: "text", text: message, visibility: "agent-only" },
      ...args.input,
    ],
    stateUpdate: {
      contentHash: snapshot.contentHash,
      contentStatus: snapshot.contentStatus,
      fileKey: MANAGER_PREFERENCES_FILE_KEY,
      shownAt,
      threadId: args.thread.id,
    },
  };
}

export function recordManagerDynamicFileDelivery(
  deps: Pick<LoggedWorkSessionDeps, "db">,
  stateUpdate: ManagerDynamicFileDeliveryStateUpdate | null,
): void {
  if (stateUpdate === null) {
    return;
  }
  upsertThreadDynamicContextFileState(deps.db, stateUpdate);
}

export function recordManagerDynamicFileDeliveryInTransaction(
  db: DbTransaction,
  stateUpdate: ManagerDynamicFileDeliveryStateUpdate | null,
): void {
  if (stateUpdate === null) {
    return;
  }
  upsertThreadDynamicContextFileStateInTransaction(db, stateUpdate);
}
