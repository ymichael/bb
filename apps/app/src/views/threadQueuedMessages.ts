import {
  type PromptInput,
  type ThreadQueuedMessage,
} from "@bb/domain";
import { toRecord } from "@bb/core-ui";
import { type PromptDraftState } from "@/lib/prompt-draft";

const QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS = 220;

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) return "Attachment";
  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

export function countQueuedMessageAttachments(input: PromptInput[]): number {
  let count = 0;
  for (const chunk of input) {
    if (chunk.type === "localImage" || chunk.type === "localFile") {
      count += 1;
    }
  }
  return count;
}

export function formatQueuedFollowUpPreview(input: PromptInput[]): string {
  const text = input
    .filter(
      (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
        chunk.type === "text",
    )
    .map((chunk) => chunk.text.trim())
    .filter((chunk) => chunk.length > 0)
    .join("\n\n");
  const trimmedText = text.trim();
  if (trimmedText.length > 0) {
    if (trimmedText.length <= QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS) {
      return trimmedText;
    }
    return `${trimmedText.slice(0, QUEUED_FOLLOW_UP_PREVIEW_MAX_CHARS - 1)}...`;
  }

  const attachmentCount = countQueuedMessageAttachments(input);
  if (attachmentCount === 1) {
    const firstAttachment = input.find(
      (chunk) => chunk.type === "localImage" || chunk.type === "localFile",
    );
    if (firstAttachment) {
      if (firstAttachment.type === "localFile" && firstAttachment.name) {
        return `Attachment only (${firstAttachment.name})`;
      }
      return `Attachment only (${getFileNameFromPath(firstAttachment.path)})`;
    }
    return "Attachment only (1 file)";
  }
  if (attachmentCount > 1) {
    return `Attachment only (${attachmentCount} files)`;
  }

  return "(empty message)";
}

export function queuedInputToDraft(input: PromptInput[]): PromptDraftState {
  const textSegments: string[] = [];
  const attachments: PromptDraftState["attachments"] = [];

  for (const chunk of input) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        textSegments.push(chunk.text);
      }
      continue;
    }

    if (chunk.type === "localImage") {
      attachments.push({
        type: "localImage",
        path: chunk.path,
        name: getFileNameFromPath(chunk.path),
        sizeBytes: 0,
      });
      continue;
    }

    if (chunk.type === "localFile") {
      attachments.push({
        type: "localFile",
        path: chunk.path,
        name: chunk.name ?? getFileNameFromPath(chunk.path),
        sizeBytes: chunk.sizeBytes ?? 0,
        ...(chunk.mimeType ? { mimeType: chunk.mimeType } : {}),
      });
      continue;
    }

    // Open provider/runtime input variant: URL images are intentionally ignored
    // by the prompt draft editor because we cannot map them to local attachments.
  }

  return {
    text: textSegments.join("\n\n"),
    attachments,
  };
}

function isPromptInputChunk(value: unknown): value is PromptInput {
  const record = toRecord(value);
  if (!record) return false;

  const type = record.type;
  if (typeof type !== "string") return false;
  if (type === "text") {
    return typeof record.text === "string";
  }
  if (type === "image") {
    return typeof record.url === "string";
  }
  if (type === "localImage" || type === "localFile") {
    return typeof record.path === "string";
  }
  return false;
}

function isThreadQueuedMessage(value: unknown): value is ThreadQueuedMessage {
  const record = toRecord(value);
  if (!record || typeof record.id !== "string") return false;
  if (!Array.isArray(record.input)) return false;
  return record.input.every(isPromptInputChunk);
}

export function extractThreadQueuedMessages(
  thread: unknown,
): ThreadQueuedMessage[] {
  const record = toRecord(thread);
  const queuedMessages = record?.queuedMessages;
  if (!Array.isArray(queuedMessages)) return [];
  return queuedMessages.filter(isThreadQueuedMessage);
}
