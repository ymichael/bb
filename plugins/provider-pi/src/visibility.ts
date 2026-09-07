import {
  createProviderVisibilityMetadata,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
  isRecord,
} from "@get-bb/plugin-sdk/provider-bridge";
import type {
  JsonRpcMessage,
  ProviderRawEventDescription,
  ProviderVisibilityMetadata,
} from "@get-bb/plugin-sdk/provider-bridge";
type PiAssistantEventType =
  | "text_delta"
  | "text_end"
  | "text_start"
  | "thinking_delta"
  | "thinking_end"
  | "thinking_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "toolcall_start"
  | "unknown";

type PiMessageBoundaryRole =
  | "assistant"
  | "custom"
  | "toolResult"
  | "user"
  | "unknown";

type PiSdkEventType =
  | "agent_end"
  | "agent_start"
  | "auto_retry_end"
  | "auto_retry_start"
  | "compaction_end"
  | "compaction_start"
  | "message_end"
  | "message_start"
  | "message_update"
  | "tool_execution_end"
  | "tool_execution_start"
  | "tool_execution_update"
  | "turn_end"
  | "turn_start"
  | "unknown";

interface PiThreadIdentityRawEvent {
  kind: "thread/identity";
}

interface PiThreadContextWindowUsageRawEvent {
  kind: "thread/contextWindowUsage/updated";
}

interface PiErrorRawEvent {
  kind: "error";
}

interface PiNonSdkRawEvent {
  kind: "non-sdk";
  method: string;
}

interface PiUnknownSdkRawEvent {
  kind: "sdk/unknown";
}

interface PiSimpleSdkRawEvent {
  kind: "sdk/simple";
  sdkType: Exclude<
    PiSdkEventType,
    | "message_end"
    | "message_start"
    | "message_update"
    | "tool_execution_start"
    | "unknown"
  >;
}

interface PiMessageBoundaryRawEvent {
  kind: "sdk/message-boundary";
  role: PiMessageBoundaryRole;
  sdkType: "message_end" | "message_start";
}

interface PiMessageUpdateRawEvent {
  assistantEventType: PiAssistantEventType;
  content?: string;
  delta?: string;
  hasThinkingStartContent: boolean;
  kind: "sdk/message_update";
}

interface PiToolExecutionStartRawEvent {
  kind: "sdk/tool_execution_start";
}

type PiRawEvent =
  | PiErrorRawEvent
  | PiMessageBoundaryRawEvent
  | PiMessageUpdateRawEvent
  | PiNonSdkRawEvent
  | PiSimpleSdkRawEvent
  | PiThreadContextWindowUsageRawEvent
  | PiThreadIdentityRawEvent
  | PiToolExecutionStartRawEvent
  | PiUnknownSdkRawEvent;

function assertNever(value: never): never {
  throw new Error(`Unhandled Pi visibility value: ${String(value)}`);
}

function toPiSdkEventType(type: string | undefined): PiSdkEventType {
  switch (type) {
    case "agent_end":
    case "agent_start":
    case "auto_retry_end":
    case "auto_retry_start":
    case "compaction_end":
    case "compaction_start":
    case "message_end":
    case "message_start":
    case "message_update":
    case "tool_execution_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "turn_end":
    case "turn_start":
      return type;
    default:
      return "unknown";
  }
}

function toPiMessageBoundaryRole(
  role: string | undefined,
): PiMessageBoundaryRole {
  switch (role) {
    case "assistant":
    case "custom":
    case "toolResult":
    case "user":
      return role;
    default:
      return "unknown";
  }
}

function toPiAssistantEventType(
  type: string | undefined,
): PiAssistantEventType {
  switch (type) {
    case "text_delta":
    case "text_end":
    case "text_start":
    case "thinking_delta":
    case "thinking_end":
    case "thinking_start":
    case "toolcall_delta":
    case "toolcall_end":
    case "toolcall_start":
      return type;
    default:
      return "unknown";
  }
}

function hasPiThinkingStartContent(rawMessage: JsonRpcMessage): boolean {
  const sdkMessage = getRawSdkMessage(rawMessage);
  if (!sdkMessage) {
    return false;
  }
  const assistantMessage = getRecordProperty(sdkMessage, "message");
  const content = assistantMessage?.["content"];
  if (!Array.isArray(content)) {
    return false;
  }
  for (const block of content) {
    if (!isRecord(block) || getStringProperty(block, "type") !== "thinking") {
      continue;
    }
    const thinking = getStringProperty(block, "thinking");
    if (thinking && thinking.length > 0) {
      return true;
    }
  }
  return false;
}

function parsePiRawEvent(event: JsonRpcMessage): PiRawEvent {
  if (event.method === "thread/identity") {
    return { kind: "thread/identity" };
  }

  if (event.method === "thread/contextWindowUsage/updated") {
    return { kind: "thread/contextWindowUsage/updated" };
  }

  if (event.method === "error") {
    return { kind: "error" };
  }

  if (event.method !== "sdk/message") {
    return {
      kind: "non-sdk",
      method: event.method,
    };
  }

  const message = getRawSdkMessage(event);
  if (!message) {
    return { kind: "sdk/unknown" };
  }

  const sdkType = toPiSdkEventType(getStringProperty(message, "type"));
  switch (sdkType) {
    case "message_start":
    case "message_end": {
      const payload = getRecordProperty(message, "message");
      return {
        kind: "sdk/message-boundary",
        sdkType,
        role: toPiMessageBoundaryRole(
          payload ? getStringProperty(payload, "role") : undefined,
        ),
      };
    }

    case "message_update": {
      const assistantMessageEvent = getRecordProperty(
        message,
        "assistantMessageEvent",
      );
      return {
        kind: "sdk/message_update",
        assistantEventType: toPiAssistantEventType(
          assistantMessageEvent
            ? getStringProperty(assistantMessageEvent, "type")
            : undefined,
        ),
        content: assistantMessageEvent
          ? getStringProperty(assistantMessageEvent, "content")
          : undefined,
        delta: assistantMessageEvent
          ? getStringProperty(assistantMessageEvent, "delta")
          : undefined,
        hasThinkingStartContent: hasPiThinkingStartContent(event),
      };
    }

    case "tool_execution_start":
      return { kind: "sdk/tool_execution_start" };

    case "agent_end":
    case "agent_start":
    case "auto_retry_end":
    case "auto_retry_start":
    case "compaction_end":
    case "compaction_start":
    case "tool_execution_end":
    case "tool_execution_update":
    case "turn_end":
    case "turn_start":
      return {
        kind: "sdk/simple",
        sdkType,
      };

    case "unknown":
      return { kind: "sdk/unknown" };

    default:
      return assertNever(sdkType);
  }
}

function describeParsedPiRawEvent(
  event: PiRawEvent,
): ProviderRawEventDescription {
  switch (event.kind) {
    case "thread/identity":
      return { kind: "thread/identity", coverage: "normalized" };

    case "thread/contextWindowUsage/updated":
      return {
        kind: "thread/contextWindowUsage/updated",
        coverage: "normalized",
      };

    case "error":
      return { kind: "error", coverage: "normalized" };

    case "non-sdk":
      return { kind: event.method, coverage: "unknown" };

    case "sdk/unknown":
      return { kind: "sdk/unknown", coverage: "unknown" };

    case "sdk/simple":
      switch (event.sdkType) {
        case "agent_end":
        case "agent_start":
        case "compaction_end":
        case "compaction_start":
        case "tool_execution_end":
        case "tool_execution_update":
          return { kind: `sdk/${event.sdkType}`, coverage: "normalized" };
        case "auto_retry_end":
        case "auto_retry_start":
        case "turn_end":
        case "turn_start":
          return { kind: `sdk/${event.sdkType}`, coverage: "noise" };
        default:
          return assertNever(event);
      }

    case "sdk/message-boundary": {
      const kind =
        `sdk/${event.sdkType}:${event.role === "unknown" ? "" : event.role}`.replace(
          /:$/u,
          "",
        );
      return event.role === "unknown"
        ? { kind: `sdk/${event.sdkType}`, coverage: "unknown" }
        : { kind, coverage: "noise" };
    }

    case "sdk/message_update":
      switch (event.assistantEventType) {
        case "text_delta":
          return {
            kind: "sdk/message_update:text_delta",
            coverage: "normalized",
          };
        case "thinking_start":
          return {
            kind: "sdk/message_update:thinking_start",
            coverage: event.hasThinkingStartContent ? "normalized" : "noise",
          };
        case "thinking_delta":
          return {
            kind: "sdk/message_update:thinking_delta",
            coverage:
              event.delta && event.delta.length > 0 ? "normalized" : "noise",
          };
        case "thinking_end":
          return {
            kind: "sdk/message_update:thinking_end",
            coverage:
              event.content && event.content.length > 0
                ? "normalized"
                : "noise",
          };
        case "text_end":
        case "text_start":
        case "toolcall_delta":
        case "toolcall_end":
        case "toolcall_start":
          return {
            kind: `sdk/message_update:${event.assistantEventType}`,
            coverage: "noise",
          };
        case "unknown":
          return { kind: "sdk/message_update", coverage: "unknown" };
        default:
          return assertNever(event.assistantEventType);
      }

    case "sdk/tool_execution_start":
      return { kind: "sdk/tool_execution_start", coverage: "normalized" };

    default:
      return assertNever(event);
  }
}

export const piVisibilityMetadata: ProviderVisibilityMetadata<PiRawEvent> =
  createProviderVisibilityMetadata({
    parseRawEvent: parsePiRawEvent,
    describeParsedRawEvent: describeParsedPiRawEvent,
  });
