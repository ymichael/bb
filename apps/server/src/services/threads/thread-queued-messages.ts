import { promptInputSchema, threadQueuedMessageSchema } from "@bb/domain";
import type {
  PermissionMode,
  PromptInput,
  ThreadQueuedMessage,
} from "@bb/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";

interface StoredQueuedThreadMessageRow {
  content: string;
  createdAt: number;
  id: string;
  model: string;
  reasoningLevel: string;
  permissionMode: PermissionMode;
  serviceTier: string;
  threadId: string;
  updatedAt: number;
}

function parseStoredQueuedThreadMessageContent(
  row: Pick<StoredQueuedThreadMessageRow, "content" | "id" | "threadId">,
): PromptInput[] {
  let content: unknown;
  try {
    content = JSON.parse(row.content);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const parsed = z.array(promptInputSchema).min(1).safeParse(content);
  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is malformed`,
    );
  }

  return parsed.data;
}

export function toThreadQueuedMessage(
  row: StoredQueuedThreadMessageRow,
): ThreadQueuedMessage {
  return threadQueuedMessageSchema.parse({
    id: row.id,
    content: parseStoredQueuedThreadMessageContent(row),
    model: row.model,
    reasoningLevel: row.reasoningLevel,
    permissionMode: row.permissionMode,
    serviceTier: row.serviceTier,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
