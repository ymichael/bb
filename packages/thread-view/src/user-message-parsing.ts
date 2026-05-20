import {
  requireThreadEventScopeTurnId,
  type PromptInput,
  type ThreadEvent,
  type ThreadType,
} from "@bb/domain";
import type { EventMeta } from "./event-decode.js";
import type {
  BuildEventProjectionMessagesOptions,
  EventProjectionAssistantTextMessage,
  EventProjectionTurnRequest,
  EventProjectionUserMessage,
} from "./event-projection-types.js";
import { messageId } from "./format-helpers.js";
import { assertNever } from "./assert-never.js";
import { eventProjectionMessageTurnScopeFields } from "./message-scope.js";

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
    if (part.visibility === "agent-only") {
      continue;
    }

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
  threadStatus: BuildEventProjectionMessagesOptions["threadStatus"] | undefined,
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
  threadStatus: BuildEventProjectionMessagesOptions["threadStatus"] | undefined,
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

function shouldRenderClientRequestInitiator(
  decoded: ClientTurnRequestedEvent,
  options: BuildEventProjectionMessagesOptions | undefined,
): boolean {
  if (options?.systemClientRequestVisibility === "visible") {
    return true;
  }

  const initiator = decoded.initiator ?? "user";
  switch (initiator) {
    case "user":
      return true;
    case "agent":
      return shouldRenderAgentClientRequest(options?.threadType);
    case "system":
      return false;
    default:
      return assertNever(initiator);
  }
}

function shouldRenderAgentClientRequest(
  threadType: ThreadType | undefined,
): boolean {
  const resolvedThreadType = threadType ?? "standard";
  switch (resolvedThreadType) {
    case "standard":
      return true;
    case "manager":
      return false;
    default:
      return assertNever(resolvedThreadType);
  }
}

function buildAttachments(
  parsed: NonNullable<ReturnType<typeof parsePromptInput>>,
): EventProjectionUserMessage["attachments"] {
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
  acceptedClientRequest?: AcceptedClientRequest;
  decoded: ThreadEvent;
  meta: EventMeta;
  options?: BuildEventProjectionMessagesOptions;
}

export interface ParseAcceptedSteerFromClientRequestArgs extends ParseUserFromClientRequestArgs {
  acceptedClientRequest: AcceptedClientRequest;
}

export interface ParsePendingSteerFromClientRequestArgs extends ParseUserFromClientRequestArgs {
  acceptedClientRequest: AcceptedClientRequest | undefined;
}

type ClientTurnRequestedEvent = Extract<
  ThreadEvent,
  { type: "client/turn/requested" }
>;

export interface AcceptedClientRequest {
  meta: EventMeta;
  turnId: string;
}

export interface ThreadEventWithMetaLike {
  event: ThreadEvent;
  meta: EventMeta;
}

export function buildAcceptedClientRequestById(
  events: readonly ThreadEventWithMetaLike[],
): Map<string, AcceptedClientRequest> {
  const acceptedById = new Map<string, AcceptedClientRequest>();
  for (const { event, meta } of events) {
    if (event.type !== "turn/input/accepted") {
      continue;
    }
    acceptedById.set(event.clientRequestId, {
      meta,
      turnId: requireThreadEventScopeTurnId({
        type: event.type,
        scope: event.scope,
      }),
    });
  }
  return acceptedById;
}

export function isSteerRequest(decoded: ClientTurnRequestedEvent): boolean {
  switch (decoded.target.kind) {
    case "auto":
      return decoded.target.expectedTurnId !== null;
    case "steer":
      return true;
    case "thread-start":
    case "new-turn":
      return false;
    default:
      return assertNever(decoded.target);
  }
}

function buildTurnRequest(
  decoded: ClientTurnRequestedEvent,
  status: EventProjectionTurnRequest["status"],
): EventProjectionTurnRequest {
  return {
    kind: isSteerRequest(decoded) ? "steer" : "message",
    status,
  };
}

function resolveClientUserMessageTurnId(
  decoded: ClientTurnRequestedEvent,
  acceptedClientRequest: AcceptedClientRequest | undefined,
): string | null {
  if (decoded.target.kind === "thread-start") {
    return null;
  }
  return (
    acceptedClientRequest?.turnId ??
    ("expectedTurnId" in decoded.target ? decoded.target.expectedTurnId : null)
  );
}

interface BuildClientUserMessageArgs {
  acceptedClientRequest?: AcceptedClientRequest;
  decoded: ClientTurnRequestedEvent;
  meta: EventMeta;
  parsedInput: NonNullable<ReturnType<typeof parsePromptInput>>;
  requestStatus: EventProjectionTurnRequest["status"];
}

function buildClientUserMessage({
  acceptedClientRequest,
  decoded,
  meta,
  parsedInput,
  requestStatus,
}: BuildClientUserMessageArgs): EventProjectionUserMessage {
  const targetTurnId = resolveClientUserMessageTurnId(
    decoded,
    acceptedClientRequest,
  );
  const rowMeta =
    isSteerRequest(decoded) && acceptedClientRequest
      ? acceptedClientRequest.meta
      : meta;

  return {
    kind: "user",
    id: messageId(decoded.threadId, "user-seed", `${meta.seq}`),
    threadId: decoded.threadId,
    sourceSeqStart: rowMeta.seq,
    sourceSeqEnd: rowMeta.seq,
    createdAt: rowMeta.createdAt,
    ...(targetTurnId
      ? eventProjectionMessageTurnScopeFields(targetTurnId)
      : { scope: decoded.scope }),
    initiator: decoded.initiator,
    senderThreadId: decoded.senderThreadId,
    turnRequest: buildTurnRequest(decoded, requestStatus),
    text: parsedInput.text,
    attachments: buildAttachments(parsedInput),
  };
}

export function parseUserFromClientRequest(
  args: ParseUserFromClientRequestArgs,
): EventProjectionUserMessage | null {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (decoded.type !== "client/turn/requested") {
    return null;
  }

  if (!shouldRenderClientRequestInitiator(decoded, options)) {
    return null;
  }
  const parsedInput = parsePromptInput(decoded.input);
  if (!parsedInput) return null;
  if (!shouldRenderClientRequestedInput(options?.threadStatus)) {
    return null;
  }

  // Steers flow through parsePendingSteer / parseAcceptedSteer regardless of
  // initiator — the steer-vs-message distinction is about turn shape, not who
  // initiated it.
  if (isSteerRequest(decoded)) {
    return null;
  }

  return buildClientUserMessage({
    acceptedClientRequest,
    decoded,
    meta,
    parsedInput,
    requestStatus: acceptedClientRequest ? "accepted" : "pending",
  });
}

export function parsePendingSteerFromClientRequest(
  args: ParsePendingSteerFromClientRequestArgs,
): EventProjectionUserMessage | null {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (acceptedClientRequest || decoded.type !== "client/turn/requested") {
    return null;
  }
  if (!isSteerRequest(decoded)) {
    return null;
  }
  if (!shouldRenderClientRequestInitiator(decoded, options)) {
    return null;
  }
  if (!shouldPreservePendingMessages(options?.threadStatus)) {
    return null;
  }
  const parsedInput = parsePromptInput(decoded.input);
  if (!parsedInput) {
    return null;
  }

  return buildClientUserMessage({
    decoded,
    meta,
    parsedInput,
    requestStatus: "pending",
  });
}

export function parseAcceptedSteerFromClientRequest(
  args: ParseAcceptedSteerFromClientRequestArgs,
): EventProjectionUserMessage | null {
  const { acceptedClientRequest, decoded, meta, options } = args;
  if (decoded.type !== "client/turn/requested") {
    return null;
  }
  if (!isSteerRequest(decoded)) {
    return null;
  }
  if (!shouldRenderClientRequestInitiator(decoded, options)) {
    return null;
  }
  const parsedInput = parsePromptInput(decoded.input);
  if (!parsedInput) {
    return null;
  }
  if (!shouldRenderClientRequestedInput(options?.threadStatus)) {
    return null;
  }

  return buildClientUserMessage({
    acceptedClientRequest,
    decoded,
    meta,
    parsedInput,
    requestStatus: "accepted",
  });
}

export function parseManagerUserMessage(
  decoded: ThreadEvent,
  meta: EventMeta,
): EventProjectionAssistantTextMessage | null {
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
