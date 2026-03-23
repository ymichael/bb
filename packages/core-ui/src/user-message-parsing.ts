import type { PromptInput, ThreadEvent, ThreadEventUserContent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type { ToUIMessagesOptions, UIAssistantTextMessage, UIUserMessage } from "@bb/domain";
import { messageId } from "./format-helpers.js";
import { assertNever } from "./assert-never.js";

/** Accepts both PromptInput[] (from client start events) and ThreadEventUserContent[] (from item events). */
export function parsePromptInput(input: ReadonlyArray<PromptInput | ThreadEventUserContent> | undefined): {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
  imageUrls: string[];
  localImagePaths: string[];
  localFilePaths: string[];
} | null {
  if (!Array.isArray(input) || input.length === 0) return null;

  const textParts: string[] = [];
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

  for (const part of input) {
    switch (part.type) {
      case "text":
        if (part.text.length > 0) {
          textParts.push(part.text);
        }
        break;
      case "image":
        webImages += 1;
        if (part.url.length > 0) {
          imageUrls.push(part.url);
        }
        break;
      case "localImage":
        localImages += 1;
        if (part.path.length > 0) {
          localImagePaths.push(part.path);
        }
        break;
      case "localFile":
        localFiles += 1;
        if (part.path.length > 0) {
          localFilePaths.push(part.path);
        }
        break;
    }
  }

  const text = textParts.join("");
  if (!text && webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }

  return {
    text,
    webImages,
    localImages,
    localFiles,
    imageUrls,
    localImagePaths,
    localFilePaths,
  };
}

export function userMessageSignature(value: {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
}): string {
  const totalImages = value.webImages + value.localImages;
  return `${value.text}\u0000${totalImages}\u0000${value.localFiles}`;
}

export function shouldRenderThreadStartInput(
  threadStatus: ToUIMessagesOptions["threadStatus"] | undefined,
): boolean {
  if (!threadStatus) return false;
  switch (threadStatus) {
    case "created":
    case "provisioning":
    case "provisioned":
    case "provisioning_failed":
    case "error":
    case "idle":
    case "active":
      return true;
    default:
      return assertNever(threadStatus);
  }
}

export function shouldPreservePendingMessages(
  threadStatus: ToUIMessagesOptions["threadStatus"] | undefined,
): boolean {
  if (!threadStatus) return false;
  switch (threadStatus) {
    case "provisioning":
    case "provisioned":
    case "active":
      return true;
    case "created":
    case "provisioning_failed":
    case "error":
    case "idle":
      return false;
    default:
      return assertNever(threadStatus);
  }
}

function buildAttachments(parsed: NonNullable<ReturnType<typeof parsePromptInput>>): UIUserMessage["attachments"] {
  return {
    webImages: parsed.webImages,
    localImages: parsed.localImages,
    localFiles: parsed.localFiles,
    ...(parsed.imageUrls.length > 0 ? { imageUrls: parsed.imageUrls } : {}),
    ...(parsed.localImagePaths.length > 0 ? { localImagePaths: parsed.localImagePaths } : {}),
    ...(parsed.localFilePaths.length > 0 ? { localFilePaths: parsed.localFilePaths } : {}),
  };
}

export function parseUserFromItemEvent(
  decoded: ThreadEvent,
  meta: EventMeta,
): UIUserMessage | null {
  if (decoded.type !== "item/started" && decoded.type !== "item/completed") {
    return null;
  }
  if (decoded.item.type !== "userMessage") return null;

  const parsedContent = parsePromptInput(decoded.item.content);
  if (!parsedContent) return null;

  const { turnId } = decoded;
  const itemId = decoded.item.id ?? `${meta.seq}`;

  return {
    kind: "user",
    id: messageId(decoded.threadId, "user", itemId),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    text: parsedContent.text,
    attachments: buildAttachments(parsedContent),
  };
}

export function parseUserFromClientStart(
  decoded: ThreadEvent,
  meta: EventMeta,
  options?: ToUIMessagesOptions,
): UIUserMessage | null {
  if (
    decoded.type !== "client/thread/start" &&
    decoded.type !== "client/turn/requested" &&
    decoded.type !== "client/turn/start"
  ) {
    return null;
  }

  if (
    decoded.initiator === "system" &&
    !options?.includeInternalSystemMessages
  ) {
    return null;
  }
  const parsedInput = parsePromptInput(decoded.input);
  if (!parsedInput) return null;
  if (!shouldRenderThreadStartInput(options?.threadStatus)) {
    return null;
  }

  return {
    kind: "user",
    id: messageId(decoded.threadId, "user-seed", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    text: parsedInput.text,
    attachments: buildAttachments(parsedInput),
  };
}

export function parseManagerUserMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): UIAssistantTextMessage | null {
  if (decoded.type !== "system/manager/user_message") {
    return null;
  }

  const { text, turnId } = decoded;
  if (!text) {
    return null;
  }

  return {
    kind: "assistant-text",
    id: messageId(decoded.threadId, "assistant", `manager:${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    ...(turnId ? { turnId } : {}),
    text,
    status: "completed",
  };
}
