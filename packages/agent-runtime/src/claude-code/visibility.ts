import type {
  ProviderObservedToolCall,
  ProviderObservedToolCallCoverage,
  ProviderRawEventDescription,
  ProviderVisibilityMetadata,
} from "../provider-visibility.js";
import type { JsonRpcMessage } from "../provider-adapter.js";
import {
  getMessageContentTypes,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
  isRecord,
  type StringRecord,
} from "../shared/provider-visibility-helpers.js";

const CLAUDE_WELL_KNOWN_TOOL_NAMES = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "Read",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;
const CLAUDE_WELL_KNOWN_TOOL_NAME_SET = new Set<string>(CLAUDE_WELL_KNOWN_TOOL_NAMES);
const CLAUDE_NORMALIZED_ASSISTANT_CONTENT_TYPES = new Set([
  "text",
  "thinking",
  "tool_use",
]);

function hasClaudeParentToolUseId(message: StringRecord): boolean {
  return typeof message["parent_tool_use_id"] === "string";
}

function hasOnlyNormalizedClaudeAssistantContentTypes(
  message: StringRecord,
): boolean {
  const contentTypes = getMessageContentTypes(message);
  return contentTypes.length > 0
    && contentTypes.every((contentType) => CLAUDE_NORMALIZED_ASSISTANT_CONTENT_TYPES.has(contentType));
}

function hasClaudeThinkingStartContent(
  message: StringRecord | null,
): boolean {
  if (!message) {
    return false;
  }
  const streamEvent = getRecordProperty(message, "event");
  const contentBlock = streamEvent
    ? getRecordProperty(streamEvent, "content_block")
    : null;
  const thinking = contentBlock
    ? getStringProperty(contentBlock, "thinking")
    : undefined;
  return typeof thinking === "string" && thinking.length > 0;
}

function hasClaudeThinkingDeltaContent(
  message: StringRecord | null,
): boolean {
  if (!message) {
    return false;
  }
  const streamEvent = getRecordProperty(message, "event");
  const delta = streamEvent
    ? getRecordProperty(streamEvent, "delta")
    : null;
  const thinking = delta
    ? getStringProperty(delta, "thinking")
    : undefined;
  return typeof thinking === "string" && thinking.length > 0;
}

function toClaudeRawEventKind(event: JsonRpcMessage): string {
  if (event.method !== "sdk/message") {
    return event.method;
  }
  const message = getRawSdkMessage(event);
  if (!message) {
    return "sdk/unknown";
  }

  const type = getStringProperty(message, "type");
  if (type === "assistant" || type === "user") {
    const contentTypes = getMessageContentTypes(message);
    if (contentTypes.length === 0) {
      return `sdk/${type}`;
    }
    return `sdk/${type}:${contentTypes.sort().join("+")}`;
  }
  if (type === "system") {
    const subtype = getStringProperty(message, "subtype");
    return subtype ? `sdk/system:${subtype}` : "sdk/system";
  }
  if (type === "stream_event") {
    const streamEvent = getRecordProperty(message, "event");
    const eventType = streamEvent ? getStringProperty(streamEvent, "type") : undefined;
    if (!eventType) {
      return "sdk/stream_event";
    }
    if (eventType === "content_block_start") {
      const contentBlock = streamEvent
        ? getRecordProperty(streamEvent, "content_block")
        : null;
      const contentType = contentBlock
        ? getStringProperty(contentBlock, "type")
        : undefined;
      return contentType
        ? `sdk/stream_event:${eventType}:${contentType}`
        : `sdk/stream_event:${eventType}`;
    }
    if (eventType === "content_block_delta") {
      const delta = streamEvent ? getRecordProperty(streamEvent, "delta") : null;
      const deltaType = delta ? getStringProperty(delta, "type") : undefined;
      return deltaType
        ? `sdk/stream_event:${eventType}:${deltaType}`
        : `sdk/stream_event:${eventType}`;
    }
    return `sdk/stream_event:${eventType}`;
  }
  return type ? `sdk/${type}` : "sdk/unknown";
}

function toClaudeRawEventDescription(event: JsonRpcMessage): ProviderRawEventDescription {
  const kind = toClaudeRawEventKind(event);
  const message = getRawSdkMessage(event);

  if (
    message &&
    getStringProperty(message, "type") === "assistant" &&
    hasOnlyNormalizedClaudeAssistantContentTypes(message)
  ) {
    return { kind, coverage: "normalized" };
  }

  if (
    kind === "thread/identity" ||
    kind === "sdk/system:status" ||
    kind === "sdk/system:compact_boundary" ||
    kind === "sdk/user:tool_result" ||
    kind === "sdk/result" ||
    kind === "sdk/stream_event:content_block_delta:text_delta"
  ) {
    return { kind, coverage: "normalized" };
  }

  if (kind === "sdk/stream_event:content_block_start:thinking") {
    return {
      kind,
      coverage: hasClaudeThinkingStartContent(message) ? "normalized" : "noise",
    };
  }

  if (kind === "sdk/stream_event:content_block_delta:thinking_delta") {
    return {
      kind,
      coverage: hasClaudeThinkingDeltaContent(message) ? "normalized" : "noise",
    };
  }

  if (kind === "sdk/user:text" && message && hasClaudeParentToolUseId(message)) {
    return { kind, coverage: "noise" };
  }

  if (
    kind === "sdk/system:init" ||
    kind === "sdk/system:task_started" ||
    kind === "sdk/system:task_progress" ||
    kind === "sdk/system:task_notification" ||
    kind === "sdk/rate_limit_event" ||
    kind === "sdk/stream_event:message_start" ||
    kind === "sdk/stream_event:content_block_start:text" ||
    kind === "sdk/stream_event:content_block_start:tool_use" ||
    kind === "sdk/stream_event:content_block_stop" ||
    kind === "sdk/stream_event:message_delta" ||
    kind === "sdk/stream_event:message_stop" ||
    kind === "sdk/stream_event:content_block_delta:signature_delta" ||
    kind === "sdk/stream_event:content_block_delta:input_json_delta"
  ) {
    return { kind, coverage: "noise" };
  }

  return { kind, coverage: "unknown" };
}

function classifyClaudeToolCallCoverage(
  toolName: string,
): ProviderObservedToolCallCoverage {
  if (CLAUDE_WELL_KNOWN_TOOL_NAME_SET.has(toolName)) {
    return "well-known";
  }
  return "unknown";
}

function toClaudeObservedToolCalls(event: JsonRpcMessage): ProviderObservedToolCall[] {
  const message = getRawSdkMessage(event);
  if (!message || getStringProperty(message, "type") !== "assistant") {
    return [];
  }

  const messagePayload = getRecordProperty(message, "message");
  const content = messagePayload?.["content"];
  if (!Array.isArray(content)) {
    return [];
  }

  const observedToolCalls: ProviderObservedToolCall[] = [];
  for (const block of content) {
    if (!isRecord(block) || getStringProperty(block, "type") !== "tool_use") {
      continue;
    }
    const toolName = getStringProperty(block, "name");
    if (!toolName) {
      continue;
    }
    observedToolCalls.push({
      key: toolName,
      displayName: toolName,
      coverage: classifyClaudeToolCallCoverage(toolName),
    });
  }
  return observedToolCalls;
}

export const claudeCodeVisibilityMetadata: ProviderVisibilityMetadata = {
  providerId: "claude-code",
  wellKnownToolNames: CLAUDE_WELL_KNOWN_TOOL_NAMES,
  describeRawEvent: toClaudeRawEventDescription,
  extractObservedToolCalls: toClaudeObservedToolCalls,
};
