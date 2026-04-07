import type { PromptInput } from "@bb/domain";
import { uploadedPromptAttachmentSchema, type UploadedPromptAttachment } from "@bb/server-contract";
import { z } from "zod";

export type PromptDraftAttachment = UploadedPromptAttachment;

export interface PromptDraftState {
  text: string;
  attachments: PromptDraftAttachment[];
}

const promptDraftStorageSchema = z.object({
  text: z.string().default(""),
  attachments: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = uploadedPromptAttachmentSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    ),
});

export function emptyPromptDraftState(): PromptDraftState {
  return {
    text: "",
    attachments: [],
  };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}

export function parsePromptDraftStorage(rawValue: string | null): PromptDraftState {
  if (!rawValue) return emptyPromptDraftState();

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const result = promptDraftStorageSchema.safeParse(parsed);
    return result.success ? result.data : emptyPromptDraftState();
  } catch {
    return emptyPromptDraftState();
  }
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

export function arePromptDraftStatesEqual(
  left: PromptDraftState,
  right: PromptDraftState,
): boolean {
  return serializePromptDraftStorage(left) === serializePromptDraftStorage(right);
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
