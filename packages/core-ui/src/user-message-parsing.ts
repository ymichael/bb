import type { PromptInput, ThreadEvent } from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type {
  ToViewMessagesOptions,
  ViewAssistantTextMessage,
  ViewUserMessage,
} from "@bb/domain";
import { messageId } from "./format-helpers.js";
import { assertNever } from "./assert-never.js";
import { viewMessageTurnScopeFields } from "./message-scope.js";

export function parsePromptInput(
  input: ReadonlyArray<PromptInput> | undefined,
): {
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

export function shouldRenderClientRequestedInput(
  threadStatus: ToViewMessagesOptions["threadStatus"] | undefined,
): boolean {
  if (!threadStatus) return false;
  switch (threadStatus) {
    case "created":
    case "provisioning":
    case "error":
    case "idle":
    case "active":
      return true;
    default:
      return assertNever(threadStatus);
  }
}

export function shouldPreservePendingMessages(
  threadStatus: ToViewMessagesOptions["threadStatus"] | undefined,
): boolean {
  if (!threadStatus) return false;
  switch (threadStatus) {
    case "provisioning":
    case "active":
      return true;
    case "created":
    case "error":
    case "idle":
      return false;
    default:
      return assertNever(threadStatus);
  }
}

function buildAttachments(
  parsed: NonNullable<ReturnType<typeof parsePromptInput>>,
): ViewUserMessage["attachments"] {
  return {
    webImages: parsed.webImages,
    localImages: parsed.localImages,
    localFiles: parsed.localFiles,
    ...(parsed.imageUrls.length > 0 ? { imageUrls: parsed.imageUrls } : {}),
    ...(parsed.localImagePaths.length > 0
      ? { localImagePaths: parsed.localImagePaths }
      : {}),
    ...(parsed.localFilePaths.length > 0
      ? { localFilePaths: parsed.localFilePaths }
      : {}),
  };
}

export interface ParseUserFromClientRequestArgs {
  decoded: ThreadEvent;
  meta: EventMeta;
  options?: ToViewMessagesOptions;
  resolvedTurnId?: string;
}

export function parseUserFromClientRequest(
  args: ParseUserFromClientRequestArgs,
): ViewUserMessage | null {
  const { decoded, meta, options, resolvedTurnId } = args;
  if (decoded.type !== "client/turn/requested") {
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
  if (!shouldRenderClientRequestedInput(options?.threadStatus)) {
    return null;
  }

  const targetTurnId =
    resolvedTurnId ??
    ("expectedTurnId" in decoded.target ? decoded.target.expectedTurnId : null);

  return {
    kind: "user",
    id: messageId(decoded.threadId, "user-seed", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: meta.seq,
    sourceSeqEnd: meta.seq,
    createdAt: meta.createdAt,
    ...(targetTurnId
      ? viewMessageTurnScopeFields(targetTurnId)
      : { scope: decoded.scope }),
    text: parsedInput.text,
    attachments: buildAttachments(parsedInput),
  };
}

export function parseManagerUserMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): ViewAssistantTextMessage | null {
  if (decoded.type !== "system/manager/user_message") {
    return null;
  }

  const { text } = decoded;
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
    scope: decoded.scope,
    text,
    status: "completed",
    isManagerUserMessage: true,
  };
}
