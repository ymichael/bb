import type { PromptInput, UploadedPromptAttachment } from "@bb/core";

export type PromptDraftAttachment = UploadedPromptAttachment;

export interface PromptDraftState {
  text: string;
  attachments: PromptDraftAttachment[];
}

export function emptyPromptDraftState(): PromptDraftState {
  return {
    text: "",
    attachments: [],
  };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromptDraftAttachment(value: unknown): value is PromptDraftAttachment {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (type !== "localImage" && type !== "localFile") return false;
  if (typeof value.path !== "string" || value.path.trim().length === 0) return false;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return false;
  if (typeof value.sizeBytes !== "number" || !Number.isFinite(value.sizeBytes)) return false;
  if (value.sizeBytes < 0) return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== "string") return false;
  return true;
}

export function parsePromptDraftStorage(rawValue: string | null): PromptDraftState {
  if (!rawValue) return emptyPromptDraftState();

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    if (isRecord(parsed)) {
      const text = typeof parsed.text === "string" ? parsed.text : "";
      const attachments = Array.isArray(parsed.attachments)
        ? parsed.attachments.filter(isPromptDraftAttachment)
        : [];
      return { text, attachments };
    }
  } catch {
    return emptyPromptDraftState();
  }

  return emptyPromptDraftState();
}

export function serializePromptDraftStorage(draft: PromptDraftState): string | null {
  const text = draft.text;
  const attachments = draft.attachments;
  if (isPromptDraftEmpty(draft)) {
    return null;
  }
  return JSON.stringify({
    text,
    attachments,
  });
}

export function promptDraftToInput(draft: PromptDraftState): PromptInput[] {
  const input: PromptInput[] = [];
  const text = draft.text.trim();
  if (text.length > 0) {
    input.push({ type: "text", text });
  }

  for (const attachment of draft.attachments) {
    if (attachment.type === "localImage") {
      input.push({
        type: "localImage",
        path: attachment.path,
      });
      continue;
    }

    input.push({
      type: "localFile",
      path: attachment.path,
      name: attachment.name,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    });
  }

  return input;
}
