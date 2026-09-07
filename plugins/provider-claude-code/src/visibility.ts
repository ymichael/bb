import {
  createProviderVisibilityMetadata,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
  isRecord,
  type JsonRpcMessage,
  type ProviderRawEventDescription,
  type ProviderVisibilityMetadata,
} from "@get-bb/plugin-sdk/provider-bridge";

function getMessageContentTypes(message: Record<string, unknown>): string[] {
  const messagePayload = getRecordProperty(message, "message");
  const content = messagePayload?.["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  const types = new Set<string>();
  for (const block of content) {
    if (!isRecord(block)) continue;
    const type = getStringProperty(block, "type");
    if (!type) continue;
    types.add(type);
  }
  return [...types];
}
const CLAUDE_NORMALIZED_ASSISTANT_CONTENT_TYPES = new Set([
  "fallback",
  "text",
  "thinking",
  "tool_use",
]);

type ClaudeMessageContentType =
  | "fallback"
  | "text"
  | "thinking"
  | "tool_result"
  | "tool_use"
  | "unknown";

type ClaudeSystemSubtype =
  | "background_tasks_changed"
  | "commands_changed"
  | "compact_boundary"
  | "elicitation_complete"
  | "files_persisted"
  | "hook_progress"
  | "hook_response"
  | "hook_started"
  | "init"
  | "local_command_output"
  | "memory_recall"
  | "mirror_error"
  | "model_fallback"
  | "model_refusal_fallback"
  | "model_refusal_no_fallback"
  | "notification"
  | "permission_denied"
  | "plugin_install"
  | "session_state_changed"
  | "status"
  | "task_notification"
  | "task_progress"
  | "task_started"
  | "task_updated"
  | "thinking_tokens"
  | "unknown";

type ClaudeStreamContentType = "text" | "thinking" | "tool_use" | "unknown";

type ClaudeStreamDeltaType =
  | "input_json_delta"
  | "signature_delta"
  | "text_delta"
  | "thinking_delta"
  | "unknown";

type ClaudeStreamEventType =
  | "content_block_delta"
  | "content_block_start"
  | "content_block_stop"
  | "message_delta"
  | "message_start"
  | "message_stop"
  | "ping"
  | "unknown";

interface ClaudeThreadIdentityRawEvent {
  kind: "thread/identity";
}

interface ClaudeThreadContextWindowUsageRawEvent {
  kind: "thread/contextWindowUsage/updated";
}

interface ClaudeErrorRawEvent {
  kind: "error";
}

interface ClaudeNonSdkRawEvent {
  kind: "non-sdk";
  method: string;
}

interface ClaudeUnknownSdkRawEvent {
  kind: "sdk/unknown";
  sdkType?: string;
}

interface ClaudeCommandLifecycleRawEvent {
  kind: "sdk/command_lifecycle";
}

interface ClaudeConversationResetRawEvent {
  kind: "sdk/conversation_reset";
}

interface ClaudeAssistantRawEvent {
  contentTypes: ClaudeMessageContentType[];
  kind: "sdk/assistant";
}

interface ClaudeUserRawEvent {
  contentTypes: ClaudeMessageContentType[];
  kind: "sdk/user";
}

interface ClaudeSystemRawEvent {
  kind: "sdk/system";
  subtype: ClaudeSystemSubtype;
}

interface ClaudeResultRawEvent {
  kind: "sdk/result";
}

interface ClaudeRateLimitRawEvent {
  kind: "sdk/rate_limit_event";
}

interface ClaudeToolProgressRawEvent {
  kind: "sdk/tool_progress";
}

interface ClaudeToolUseSummaryRawEvent {
  kind: "sdk/tool_use_summary";
}

interface ClaudeStreamStartRawEvent {
  contentType: ClaudeStreamContentType;
  eventType: "content_block_start";
  kind: "sdk/stream_event";
  text?: string;
  thinking?: string;
}

interface ClaudeStreamDeltaRawEvent {
  deltaType: ClaudeStreamDeltaType;
  eventType: "content_block_delta";
  kind: "sdk/stream_event";
  text?: string;
  thinking?: string;
}

interface ClaudeSimpleStreamRawEvent {
  eventType: Exclude<
    ClaudeStreamEventType,
    "content_block_delta" | "content_block_start"
  >;
  kind: "sdk/stream_event";
}

type ClaudeRawEvent =
  | ClaudeAssistantRawEvent
  | ClaudeCommandLifecycleRawEvent
  | ClaudeConversationResetRawEvent
  | ClaudeErrorRawEvent
  | ClaudeNonSdkRawEvent
  | ClaudeRateLimitRawEvent
  | ClaudeResultRawEvent
  | ClaudeToolProgressRawEvent
  | ClaudeToolUseSummaryRawEvent
  | ClaudeSimpleStreamRawEvent
  | ClaudeStreamDeltaRawEvent
  | ClaudeStreamStartRawEvent
  | ClaudeSystemRawEvent
  | ClaudeThreadContextWindowUsageRawEvent
  | ClaudeThreadIdentityRawEvent
  | ClaudeUnknownSdkRawEvent
  | ClaudeUserRawEvent;

function assertNever(value: never): never {
  throw new Error(`Unhandled Claude visibility value: ${String(value)}`);
}

function toClaudeMessageContentType(
  contentType: string,
): ClaudeMessageContentType {
  switch (contentType) {
    case "fallback":
    case "text":
    case "thinking":
    case "tool_result":
    case "tool_use":
      return contentType;
    default:
      return "unknown";
  }
}

function toClaudeSystemSubtype(
  subtype: string | undefined,
): ClaudeSystemSubtype {
  switch (subtype) {
    case "background_tasks_changed":
    case "commands_changed":
    case "compact_boundary":
    case "elicitation_complete":
    case "files_persisted":
    case "hook_progress":
    case "hook_response":
    case "hook_started":
    case "init":
    case "local_command_output":
    case "memory_recall":
    case "mirror_error":
    case "model_fallback":
    case "model_refusal_fallback":
    case "model_refusal_no_fallback":
    case "notification":
    case "permission_denied":
    case "plugin_install":
    case "session_state_changed":
    case "status":
    case "task_notification":
    case "task_progress":
    case "task_started":
    case "task_updated":
    case "thinking_tokens":
      return subtype;
    default:
      return "unknown";
  }
}

function toClaudeStreamEventType(
  eventType: string | undefined,
): ClaudeStreamEventType {
  switch (eventType) {
    case "content_block_delta":
    case "content_block_start":
    case "content_block_stop":
    case "message_delta":
    case "message_start":
    case "message_stop":
    case "ping":
      return eventType;
    default:
      return "unknown";
  }
}

function toClaudeStreamContentType(
  contentType: string | undefined,
): ClaudeStreamContentType {
  switch (contentType) {
    case "text":
    case "thinking":
    case "tool_use":
      return contentType;
    default:
      return "unknown";
  }
}

function toClaudeStreamDeltaType(
  deltaType: string | undefined,
): ClaudeStreamDeltaType {
  switch (deltaType) {
    case "input_json_delta":
    case "signature_delta":
    case "text_delta":
    case "thinking_delta":
      return deltaType;
    default:
      return "unknown";
  }
}

function parseClaudeRawEvent(event: JsonRpcMessage): ClaudeRawEvent {
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

  const type = getStringProperty(message, "type");
  switch (type) {
    case "assistant":
      return {
        kind: "sdk/assistant",
        contentTypes: getMessageContentTypes(message).map(
          toClaudeMessageContentType,
        ),
      };

    case "command_lifecycle":
      return { kind: "sdk/command_lifecycle" };

    case "conversation_reset":
      return { kind: "sdk/conversation_reset" };

    case "rate_limit_event":
      return { kind: "sdk/rate_limit_event" };

    case "result":
      return { kind: "sdk/result" };

    case "stream_event": {
      const streamEvent = getRecordProperty(message, "event");
      const eventType = toClaudeStreamEventType(
        streamEvent ? getStringProperty(streamEvent, "type") : undefined,
      );
      if (eventType === "content_block_start") {
        const contentBlock = streamEvent
          ? getRecordProperty(streamEvent, "content_block")
          : null;
        return {
          kind: "sdk/stream_event",
          eventType,
          contentType: toClaudeStreamContentType(
            contentBlock ? getStringProperty(contentBlock, "type") : undefined,
          ),
          text: contentBlock
            ? getStringProperty(contentBlock, "text")
            : undefined,
          thinking: contentBlock
            ? getStringProperty(contentBlock, "thinking")
            : undefined,
        };
      }
      if (eventType === "content_block_delta") {
        const delta = streamEvent
          ? getRecordProperty(streamEvent, "delta")
          : null;
        return {
          kind: "sdk/stream_event",
          eventType,
          deltaType: toClaudeStreamDeltaType(
            delta ? getStringProperty(delta, "type") : undefined,
          ),
          text: delta ? getStringProperty(delta, "text") : undefined,
          thinking: delta ? getStringProperty(delta, "thinking") : undefined,
        };
      }
      return {
        kind: "sdk/stream_event",
        eventType,
      };
    }

    case "system":
      return {
        kind: "sdk/system",
        subtype: toClaudeSystemSubtype(getStringProperty(message, "subtype")),
      };

    case "user":
      return {
        kind: "sdk/user",
        contentTypes: getMessageContentTypes(message).map(
          toClaudeMessageContentType,
        ),
      };

    case "tool_progress":
      return { kind: "sdk/tool_progress" };

    case "tool_use_summary":
      return { kind: "sdk/tool_use_summary" };

    default:
      return {
        kind: "sdk/unknown",
        ...(type ? { sdkType: type } : {}),
      };
  }
}

function toClaudeMessageKind(
  prefix: "sdk/assistant" | "sdk/user",
  contentTypes: ClaudeMessageContentType[],
): string {
  if (contentTypes.length === 0) {
    return prefix;
  }
  return `${prefix}:${[...contentTypes].sort().join("+")}`;
}

function describeParsedClaudeRawEvent(
  event: ClaudeRawEvent,
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
      return {
        kind: event.sdkType ? `sdk/${event.sdkType}` : "sdk/unknown",
        coverage: "unknown",
      };

    case "sdk/assistant": {
      const kind = toClaudeMessageKind("sdk/assistant", event.contentTypes);
      if (
        event.contentTypes.length > 0 &&
        event.contentTypes.every((contentType) =>
          CLAUDE_NORMALIZED_ASSISTANT_CONTENT_TYPES.has(contentType),
        )
      ) {
        return { kind, coverage: "normalized" };
      }
      return { kind, coverage: "unknown" };
    }

    case "sdk/command_lifecycle":
      return { kind: "sdk/command_lifecycle", coverage: "noise" };

    case "sdk/conversation_reset":
      return { kind: "sdk/conversation_reset", coverage: "normalized" };

    case "sdk/user": {
      const kind = toClaudeMessageKind("sdk/user", event.contentTypes);
      if (kind === "sdk/user:text") {
        return { kind, coverage: "noise" };
      }
      if (kind === "sdk/user:tool_result") {
        return { kind, coverage: "normalized" };
      }
      return { kind, coverage: "unknown" };
    }

    case "sdk/system":
      switch (event.subtype) {
        case "compact_boundary":
          return {
            kind: "sdk/system:compact_boundary",
            coverage: "normalized",
          };
        case "status":
          return { kind: "sdk/system:status", coverage: "normalized" };
        case "model_fallback":
        case "model_refusal_fallback":
        case "model_refusal_no_fallback":
          return {
            kind: `sdk/system:${event.subtype}`,
            coverage: "normalized",
          };
        case "task_notification":
        case "task_progress":
        case "task_started":
        case "task_updated":
        case "background_tasks_changed":
          return {
            kind: `sdk/system:${event.subtype}`,
            coverage: "normalized",
          };
        case "init":
        case "commands_changed":
        case "elicitation_complete":
        case "files_persisted":
        case "hook_progress":
        case "hook_response":
        case "hook_started":
        case "local_command_output":
        case "memory_recall":
        case "mirror_error":
        case "notification":
        case "plugin_install":
        case "session_state_changed":
        case "thinking_tokens":
          return { kind: `sdk/system:${event.subtype}`, coverage: "noise" };
        case "permission_denied":
          return {
            kind: "sdk/system:permission_denied",
            coverage: "normalized",
          };
        case "unknown":
          return { kind: "sdk/system", coverage: "unknown" };
        default:
          return assertNever(event.subtype);
      }

    case "sdk/result":
      return { kind: "sdk/result", coverage: "normalized" };

    case "sdk/rate_limit_event":
      return { kind: "sdk/rate_limit_event", coverage: "noise" };

    case "sdk/tool_progress":
      return { kind: "sdk/tool_progress", coverage: "noise" };

    case "sdk/tool_use_summary":
      return { kind: "sdk/tool_use_summary", coverage: "noise" };

    case "sdk/stream_event":
      switch (event.eventType) {
        case "message_start":
        case "content_block_stop":
        case "message_delta":
        case "message_stop":
        case "ping":
          return {
            kind: `sdk/stream_event:${event.eventType}`,
            coverage: "noise",
          };

        case "content_block_start":
          switch (event.contentType) {
            case "thinking":
              return {
                kind: "sdk/stream_event:content_block_start:thinking",
                coverage:
                  event.thinking && event.thinking.length > 0
                    ? "normalized"
                    : "noise",
              };
            case "text":
              return {
                kind: "sdk/stream_event:content_block_start:text",
                coverage: "noise",
              };
            case "tool_use":
              return {
                kind: "sdk/stream_event:content_block_start:tool_use",
                coverage: "noise",
              };
            case "unknown":
              return {
                kind: "sdk/stream_event:content_block_start",
                coverage: "unknown",
              };
            default:
              return assertNever(event.contentType);
          }

        case "content_block_delta":
          switch (event.deltaType) {
            case "text_delta":
              return {
                kind: "sdk/stream_event:content_block_delta:text_delta",
                coverage: "normalized",
              };
            case "thinking_delta":
              return {
                kind: "sdk/stream_event:content_block_delta:thinking_delta",
                coverage:
                  event.thinking && event.thinking.length > 0
                    ? "normalized"
                    : "noise",
              };
            case "input_json_delta":
            case "signature_delta":
              return {
                kind: `sdk/stream_event:content_block_delta:${event.deltaType}`,
                coverage: "noise",
              };
            case "unknown":
              return {
                kind: "sdk/stream_event:content_block_delta",
                coverage: "unknown",
              };
            default:
              return assertNever(event.deltaType);
          }

        case "unknown":
          return { kind: "sdk/stream_event", coverage: "unknown" };

        default:
          return assertNever(event);
      }

    default:
      return assertNever(event);
  }
}

export const claudeCodeVisibilityMetadata: ProviderVisibilityMetadata<ClaudeRawEvent> =
  createProviderVisibilityMetadata({
    parseRawEvent: parseClaudeRawEvent,
    describeParsedRawEvent: describeParsedClaudeRawEvent,
  });
