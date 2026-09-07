import {
  promptTextMentionSchema,
  type PromptInput,
  type PromptTextMention,
} from "@bb/domain";
import {
  uploadedPromptAttachmentSchema,
  type UploadedPromptAttachment,
} from "@bb/server-contract";
import { z } from "zod";
import {
  isAutomationPromptCommandResource,
  SUBMITTED_AUTOMATION_PROMPT_PREFIX,
} from "./automation-prompt.js";

export type PromptDraftAttachment = UploadedPromptAttachment;

export interface PromptDraftState {
  text: string;
  mentions: PromptTextMention[];
  attachments: PromptDraftAttachment[];
}

const promptDraftStorageSchema = z.object({
  text: z.string().default(""),
  mentions: z
    .array(z.unknown())
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const result = promptTextMentionSchema.safeParse(item);
        return result.success ? [result.data] : [];
      }),
    ),
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
    mentions: [],
    attachments: [],
  };
}

function normalizeQuotedSelectionText(text: string): string {
  const lines = text.replace(/\r\n|\r/gu, "\n").split("\n");
  const normalizedLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const previousLine = normalizedLines.at(-1);
    const nextLine = lines[index + 1];
    if (
      line.trim().length === 0 &&
      previousLine?.startsWith(">") === true &&
      nextLine?.startsWith(">") === true
    ) {
      continue;
    }
    normalizedLines.push(line);
  }

  return normalizedLines.join("\n").trim();
}

export function appendQuoteToDraftText(
  state: PromptDraftState,
  quotedText: string,
): PromptDraftState {
  const trimmed = normalizeQuotedSelectionText(quotedText);
  if (trimmed === "") return state;

  const block = trimmed
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");

  const text = state.text === "" ? `${block}\n` : `${state.text}\n${block}\n`;

  return { ...state, text };
}

export function appendQuoteAndAttachmentsToDraft(
  state: PromptDraftState,
  quotedText: string,
  attachments: readonly PromptDraftAttachment[],
): PromptDraftState {
  const quotedState = appendQuoteToDraftText(state, quotedText);
  if (attachments.length === 0) {
    return quotedState;
  }

  const existingAttachmentPaths = new Set(
    quotedState.attachments.map((attachment) => attachment.path),
  );
  const mergedAttachments = [...quotedState.attachments];
  for (const attachment of attachments) {
    if (existingAttachmentPaths.has(attachment.path)) {
      continue;
    }
    existingAttachmentPaths.add(attachment.path);
    mergedAttachments.push(attachment);
  }

  if (mergedAttachments.length === quotedState.attachments.length) {
    return quotedState;
  }

  return { ...quotedState, attachments: mergedAttachments };
}

export function isPromptDraftEmpty(draft: PromptDraftState): boolean {
  return (
    draft.text.length === 0 &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0
  );
}

export function parsePromptDraftStorage(
  rawValue: string | null,
): PromptDraftState {
  if (!rawValue) return emptyPromptDraftState();

  try {
    const parsed: unknown = JSON.parse(rawValue);
    const result = promptDraftStorageSchema.safeParse(parsed);
    return result.success ? result.data : emptyPromptDraftState();
  } catch {
    return emptyPromptDraftState();
  }
}

export function serializePromptDraftStorage(
  draft: PromptDraftState,
): string | null {
  const text = draft.text;
  const mentions = draft.mentions;
  const attachments = draft.attachments;
  if (isPromptDraftEmpty(draft)) {
    return null;
  }
  return JSON.stringify({
    text,
    ...(mentions.length > 0 ? { mentions } : {}),
    attachments,
  });
}

export function arePromptDraftStatesEqual(
  left: PromptDraftState,
  right: PromptDraftState,
): boolean {
  return (
    serializePromptDraftStorage(left) === serializePromptDraftStorage(right)
  );
}

function getFileNameFromPath(path: string): string {
  const trimmedPath = path.trim();
  if (trimmedPath.length === 0) {
    return "Attachment";
  }

  const segments = trimmedPath.split("/");
  const lastSegment = segments[segments.length - 1];
  return lastSegment && lastSegment.length > 0 ? lastSegment : trimmedPath;
}

export function normalizePromptTextMentions(
  mentions: readonly PromptTextMention[],
  textLength: number,
): PromptTextMention[] {
  return mentions
    .filter(
      (mention) =>
        mention.start >= 0 &&
        mention.end > mention.start &&
        mention.end <= textLength,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

interface ExpandedPromptText {
  text: string;
  mentions: PromptTextMention[];
}

function expandAutomationPromptCommandMentions(
  text: string,
  mentions: readonly PromptTextMention[],
): ExpandedPromptText {
  const automationMentions = mentions
    .filter((mention) => isAutomationPromptCommandResource(mention.resource))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (automationMentions.length === 0) {
    return { text, mentions: [...mentions] };
  }

  const replacements: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  let nextText = "";
  for (const mention of automationMentions) {
    if (mention.start < cursor) {
      continue;
    }
    replacements.push({ start: mention.start, end: mention.end });
    nextText += text.slice(cursor, mention.start);
    nextText += SUBMITTED_AUTOMATION_PROMPT_PREFIX;
    cursor = mention.end;
  }
  nextText += text.slice(cursor);

  const nextMentions = mentions.flatMap((mention) => {
    if (isAutomationPromptCommandResource(mention.resource)) {
      return [];
    }

    let offset = 0;
    for (const replacement of replacements) {
      if (mention.start < replacement.end && mention.end > replacement.start) {
        return [];
      }
      if (replacement.end <= mention.start) {
        offset +=
          SUBMITTED_AUTOMATION_PROMPT_PREFIX.length -
          (replacement.end - replacement.start);
      }
    }

    return [
      {
        ...mention,
        start: mention.start + offset,
        end: mention.end + offset,
      },
    ];
  });

  return {
    text: nextText,
    mentions: normalizePromptTextMentions(nextMentions, nextText.length),
  };
}

export function promptDraftToInput(draft: PromptDraftState): PromptInput[] {
  const input: PromptInput[] = [];

  const trimStartLength = draft.text.length - draft.text.trimStart().length;
  const trimEndIndex = draft.text.trimEnd().length;
  const text = draft.text.slice(trimStartLength, trimEndIndex);
  if (text.length > 0) {
    const mentions = normalizePromptTextMentions(
      draft.mentions.flatMap((mention) => {
        const visibleStart = Math.max(mention.start, trimStartLength);
        const visibleEnd = Math.min(mention.end, trimEndIndex);
        return visibleStart < visibleEnd
          ? [
              {
                ...mention,
                start: visibleStart - trimStartLength,
                end: visibleEnd - trimStartLength,
              },
            ]
          : [];
      }),
      text.length,
    );
    const expandedText = expandAutomationPromptCommandMentions(text, mentions);
    input.push({
      type: "text",
      text: expandedText.text,
      mentions: expandedText.mentions,
    });
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
      ...(attachment.sizeBytes > 0 ? { sizeBytes: attachment.sizeBytes } : {}),
      ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    });
  }

  return input;
}

export function promptInputToDraft(
  input: readonly PromptInput[],
): PromptDraftState {
  const textSegments: string[] = [];
  const mentions: PromptTextMention[] = [];
  const attachments: PromptDraftState["attachments"] = [];
  let textOffset = 0;

  for (const chunk of input) {
    if (chunk.type === "text") {
      if (chunk.text.trim().length > 0) {
        if (textSegments.length > 0) {
          textOffset += 2;
        }
        for (const mention of chunk.mentions) {
          if (
            mention.start >= 0 &&
            mention.end > mention.start &&
            mention.end <= chunk.text.length
          ) {
            mentions.push({
              ...mention,
              start: textOffset + mention.start,
              end: textOffset + mention.end,
            });
          }
        }
        textSegments.push(chunk.text);
        textOffset += chunk.text.length;
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
    }
  }

  return {
    text: textSegments.join("\n\n"),
    mentions,
    attachments,
  };
}

export function getProjectStoredPromptAttachmentPaths(
  attachments: readonly PromptDraftAttachment[],
): string[] {
  return [
    ...new Set(
      attachments.flatMap((attachment) => {
        const path = attachment.path;
        const isRuntimeReadable =
          /^[\\/]/u.test(path) ||
          /^[a-zA-Z]:[\\/]/u.test(path) ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(path);
        return isRuntimeReadable ? [] : [path];
      }),
    ),
  ];
}
