import { type PromptInput } from "@bb/domain";
import { fileNameFromPath } from "@bb/thread-view";
import { promptInputToDraft, type PromptDraftState } from "@/lib/prompt-draft";

const QUEUED_MESSAGE_PREVIEW_MAX_CHARS = 220;

function getAttachmentNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) return "Attachment";
  return fileNameFromPath(trimmedPath);
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

export function formatQueuedMessagePreview(input: PromptInput[]): string {
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
    if (trimmedText.length <= QUEUED_MESSAGE_PREVIEW_MAX_CHARS) {
      return trimmedText;
    }
    return `${trimmedText.slice(0, QUEUED_MESSAGE_PREVIEW_MAX_CHARS - 1)}...`;
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
      return `Attachment only (${getAttachmentNameFromPath(
        firstAttachment.path,
      )})`;
    }
    return "Attachment only (1 file)";
  }
  if (attachmentCount > 1) {
    return `Attachment only (${attachmentCount} files)`;
  }

  return "(empty message)";
}

export function queuedInputToDraft(input: PromptInput[]): PromptDraftState {
  return promptInputToDraft(input);
}
