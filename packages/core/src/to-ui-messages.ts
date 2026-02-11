import type { ThreadEvent } from "./types.js";
import type {
  ToUIMessagesOptions,
  UIAssistantReasoningMessage,
  UIAssistantTextMessage,
  UIDebugRawEventMessage,
  UIErrorMessage,
  UIFileEditChange,
  UIFileEditMessage,
  UIMessage,
  UIOperationMessage,
  UIToolCallMessage,
  UIUserMessage,
} from "./ui-message.js";

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeEventType(type: string): string {
  return type.toLowerCase().replaceAll(".", "/");
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function getStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getNumberField(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function collectTextFragments(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectTextFragments(entry, out);
    return;
  }

  const record = toRecord(value);
  if (!record) return;

  const candidates = [
    record.delta,
    record.text,
    record.content,
    record.value,
    record.message,
    record.summary,
    record.summary_text,
    record.stdout,
    record.stderr,
    record.aggregated_output,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    collectTextFragments(candidate, out);
  }
}

function extractText(value: unknown): string {
  const parts: string[] = [];
  collectTextFragments(value, parts);
  return parts.join("");
}

function getEventType(event: ThreadEvent): string {
  const normalizedType = normalizeEventType(event.type);
  if (normalizedType !== "provider/event") return normalizedType;

  const data = toRecord(event.data);
  const providerEventType = getStringField(data, "providerEventType");
  return providerEventType ? normalizeEventType(providerEventType) : normalizedType;
}

function getEventData(event: ThreadEvent): unknown {
  const data = toRecord(event.data);
  if (!data || !("providerEventType" in data)) return event.data;
  return data.payload;
}

function getMsgRecord(data: unknown): Record<string, unknown> | null {
  const params = toRecord(data);
  if (!params) return null;
  return toRecord(params.msg);
}

function getTurnId(data: unknown): string | undefined {
  const params = toRecord(data);
  if (!params) return undefined;

  if (typeof params.turnId === "string" && params.turnId.length > 0) {
    return params.turnId;
  }

  const turn = toRecord(params.turn);
  if (turn && typeof turn.id === "string" && turn.id.length > 0) {
    return turn.id;
  }

  const msg = toRecord(params.msg);
  if (msg && typeof msg.turn_id === "string" && msg.turn_id.length > 0) {
    return msg.turn_id;
  }

  if (typeof params.id === "string" && params.id.length > 0) {
    return params.id;
  }

  return undefined;
}

function getItemRecord(data: unknown): Record<string, unknown> | null {
  const params = toRecord(data);
  if (!params) return null;

  const directItem = toRecord(params.item);
  if (directItem) return directItem;

  const msg = toRecord(params.msg);
  if (!msg) return null;
  return toRecord(msg.item);
}

function getItemTypeToken(data: unknown): string {
  const item = getItemRecord(data);
  const type = getStringField(item, "type");
  return type ? normalizeToken(type) : "";
}

function getItemId(data: unknown): string | undefined {
  const item = getItemRecord(data);
  const itemId = getStringField(item, "id");
  if (itemId) return itemId;

  const params = toRecord(data);
  const paramsItemId = getStringField(params, "itemId");
  if (paramsItemId) return paramsItemId;

  const msg = toRecord(params?.msg);
  const msgItemId = getStringField(msg, "item_id");
  if (msgItemId) return msgItemId;

  return undefined;
}

function messageId(threadId: string, kind: string, key: string): string {
  return `${threadId}:${kind}:${key}`;
}

function parseUserFromCodexEvent(
  event: ThreadEvent,
  eventType: string,
): UIUserMessage | null {
  if (eventType !== "codex/event/user_message") return null;

  const payload = toRecord(event.data);
  const msg = toRecord(payload?.msg);
  const text = typeof msg?.message === "string" ? msg.message : "";
  const images = Array.isArray(msg?.images) ? msg.images.length : 0;
  const localImages = Array.isArray(msg?.local_images) ? msg.local_images.length : 0;
  if (!text && images === 0 && localImages === 0) return null;

  const turnId = getTurnId(event.data);
  return {
    kind: "user",
    id: messageId(event.threadId, "user", `${turnId ?? event.seq}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    ...(turnId ? { turnId } : {}),
    text,
    attachments: {
      webImages: images,
      localImages,
    },
  };
}

function parseUserFromItemEvent(
  event: ThreadEvent,
  eventType: string,
): UIUserMessage | null {
  if (eventType !== "item/started" && eventType !== "item/completed") return null;
  if (getItemTypeToken(event.data) !== "usermessage") return null;

  const item = getItemRecord(event.data);
  const content = Array.isArray(item?.content) ? item.content : [];
  const textParts: string[] = [];
  let webImages = 0;
  let localImages = 0;

  for (const entry of content) {
    const part = toRecord(entry);
    if (!part) continue;

    const typeToken =
      typeof part.type === "string" ? normalizeToken(part.type) : "";

    if (typeToken === "text") {
      if (typeof part.text === "string" && part.text.length > 0) {
        textParts.push(part.text);
      }
      continue;
    }

    if (typeToken === "image") {
      webImages += 1;
      continue;
    }

    if (typeToken === "localimage") {
      localImages += 1;
    }
  }

  const text = textParts.join("");
  if (!text && webImages === 0 && localImages === 0) return null;

  const turnId = getTurnId(event.data);
  const itemId = getItemId(event.data) ?? `${event.seq}`;

  return {
    kind: "user",
    id: messageId(event.threadId, "user", itemId),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    ...(turnId ? { turnId } : {}),
    text,
    attachments: {
      webImages,
      localImages,
    },
  };
}

function parseAssistantDeltaText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (
    eventType !== "item/agentmessage/delta" &&
    eventType !== "message/assistant/delta"
  ) {
    return null;
  }

  const params = toRecord(event.data);
  const text = extractText(params?.delta ?? params?.text ?? params?.content);
  return text.length > 0 ? text : null;
}

function parseAssistantFinalText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (eventType === "item/completed" && getItemTypeToken(event.data) === "agentmessage") {
    const item = getItemRecord(event.data);
    const text = extractText(item?.text ?? item?.content);
    return text.length > 0 ? text : null;
  }

  if (eventType === "message/assistant") {
    const params = toRecord(event.data);
    const text = extractText(params?.text ?? params?.content);
    return text.length > 0 ? text : null;
  }

  return null;
}

function parseReasoningDeltaText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (
    eventType !== "item/reasoning/summarytextdelta" &&
    eventType !== "item/reasoning/textdelta" &&
    eventType !== "message/reasoning/delta"
  ) {
    return null;
  }

  const params = toRecord(event.data);
  const text = extractText(params?.delta ?? params?.text ?? params?.content);
  return text.length > 0 ? text : null;
}

function parseReasoningFinalText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (eventType === "item/completed" && getItemTypeToken(event.data) === "reasoning") {
    const item = getItemRecord(event.data);
    const text = extractText(item?.summary ?? item?.summaryText ?? item?.text ?? item?.content);
    return text.length > 0 ? text : null;
  }

  if (eventType === "message/reasoning") {
    const params = toRecord(event.data);
    const text = extractText(params?.text ?? params?.content);
    return text.length > 0 ? text : null;
  }

  return null;
}

function toToolStatus(value: unknown): UIToolCallMessage["status"] | undefined {
  if (typeof value !== "string") return undefined;
  const token = normalizeToken(value);
  if (
    token.includes("declin") ||
    token.includes("cancel") ||
    token.includes("abort") ||
    token.includes("interrupt")
  ) {
    return "interrupted";
  }
  if (token.includes("error") || token.includes("fail")) return "error";
  if (token.includes("complete") || token.includes("success") || token === "done") {
    return "completed";
  }
  if (token.includes("progress") || token.includes("run") || token === "pending") {
    return "pending";
  }
  return undefined;
}

function extractShellCommand(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;

  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    if (parts.length === 0) return undefined;

    if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
      return parts[2] || undefined;
    }

    return parts.join(" ");
  }

  return undefined;
}

function extractParsedCommand(data: Record<string, unknown> | null): string | undefined {
  const parsed = data?.parsed_cmd;
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;

  const first = toRecord(parsed[0]);
  return getStringField(first, "cmd") ?? getStringField(first, "command");
}

interface ToolPartial extends Partial<UIToolCallMessage> {
  callId: string;
  appendOutput?: boolean;
}

function parseToolFromCanonicalEvent(
  event: ThreadEvent,
  eventType: string,
): ToolPartial | null {
  if (eventType !== "tool/call/started" && eventType !== "tool/call/completed") {
    return null;
  }

  const params = toRecord(event.data);
  const callId =
    getStringField(params, "callId") ??
    getStringField(params, "call_id") ??
    getStringField(params, "itemId");
  if (!callId) return null;

  const status =
    (eventType === "tool/call/completed" ? "completed" : "pending") as UIToolCallMessage["status"];
  const exitCode = getNumberField(params, "exitCode") ?? getNumberField(params, "exit_code");

  return {
    callId,
    toolName: getStringField(params, "toolName") ?? "exec_command",
    command: extractShellCommand(params?.command),
    cwd: getStringField(params, "cwd"),
    output:
      getStringField(params, "output") ??
      getStringField(params, "aggregatedOutput") ??
      getStringField(params, "aggregated_output"),
    exitCode,
    status:
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : (toToolStatus(getStringField(params, "status")) ?? status),
  };
}

function parseToolFromExecEvent(
  event: ThreadEvent,
  eventType: string,
): ToolPartial | null {
  if (
    eventType !== "codex/event/exec_command_begin" &&
    eventType !== "codex/event/exec_command_end" &&
    eventType !== "codex/event/exec_command_output_delta"
  ) {
    return null;
  }

  const msg = getMsgRecord(event.data);
  const callId = getStringField(msg, "call_id");
  if (!callId) return null;

  const exitCode = getNumberField(msg, "exit_code");
  const statusToken = toToolStatus(getStringField(msg, "status"));
  const command =
    extractParsedCommand(msg) ??
    extractShellCommand(msg?.command);

  if (eventType === "codex/event/exec_command_output_delta") {
    const delta = getStringField(msg, "delta") ?? "";
    return {
      callId,
      toolName: "exec_command",
      command,
      cwd: getStringField(msg, "cwd"),
      output: delta,
      appendOutput: true,
      status: "pending",
    };
  }

  if (eventType === "codex/event/exec_command_begin") {
    return {
      callId,
      toolName: "exec_command",
      command,
      cwd: getStringField(msg, "cwd"),
      status: "pending",
    };
  }

  return {
    callId,
    toolName: "exec_command",
    command,
    cwd: getStringField(msg, "cwd"),
    output:
      getStringField(msg, "aggregated_output") ??
      getStringField(msg, "formatted_output") ??
      getStringField(msg, "stdout"),
    exitCode,
    status:
      statusToken ??
      (exitCode !== undefined && exitCode !== 0
        ? "error"
        : "completed"),
  };
}

function parseToolFromItemEvent(
  event: ThreadEvent,
  eventType: string,
): ToolPartial | null {
  if (eventType !== "item/started" && eventType !== "item/completed") {
    if (eventType === "item/commandexecution/outputdelta") {
      const params = toRecord(event.data);
      const callId = getStringField(params, "itemId");
      if (!callId) return null;
      const delta = getStringField(params, "delta") ?? "";
      return {
        callId,
        toolName: "exec_command",
        output: delta,
        appendOutput: true,
        status: "pending",
      };
    }
    return null;
  }

  if (getItemTypeToken(event.data) !== "commandexecution") {
    return null;
  }

  const item = getItemRecord(event.data);
  const callId = getStringField(item, "id");
  if (!callId) return null;

  const exitCode = getNumberField(item, "exitCode") ?? getNumberField(item, "exit_code");
  const defaultStatus = eventType === "item/completed" ? "completed" : "pending";

  return {
    callId,
    toolName: "exec_command",
    command: extractShellCommand(item?.command),
    cwd: getStringField(item, "cwd"),
    output:
      getStringField(item, "aggregatedOutput") ??
      getStringField(item, "aggregated_output"),
    exitCode,
    status:
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : (toToolStatus(getStringField(item, "status")) ?? defaultStatus),
  };
}

function toFileEditStatus(value: unknown): UIFileEditMessage["status"] | undefined {
  if (typeof value !== "string") return undefined;
  const token = normalizeToken(value);
  if (
    token.includes("declin") ||
    token.includes("cancel") ||
    token.includes("abort") ||
    token.includes("interrupt")
  ) {
    return "interrupted";
  }
  if (token.includes("error") || token.includes("fail")) return "error";
  if (token.includes("complete") || token.includes("success")) return "completed";
  if (token.includes("progress") || token.includes("pending")) return "pending";
  return undefined;
}

function normalizeFileChangeKind(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = normalizeToken(value);
  if (token.includes("add") || token.includes("create") || token.includes("new")) {
    return "add";
  }
  if (token.includes("delete") || token.includes("remove")) {
    return "delete";
  }
  if (
    token.includes("update") ||
    token.includes("edit") ||
    token.includes("modify") ||
    token.includes("rename") ||
    token.includes("move")
  ) {
    return "update";
  }
  return undefined;
}

function parseFileChangesFromArray(changes: unknown): UIFileEditChange[] {
  if (!Array.isArray(changes)) return [];
  const parsed: UIFileEditChange[] = [];

  for (const entry of changes) {
    const change = toRecord(entry);
    if (!change) continue;
    const path = getStringField(change, "path");
    if (!path) continue;

    const kindRecord = toRecord(change.kind);
    const kind =
      normalizeFileChangeKind(getStringField(kindRecord, "type")) ??
      normalizeFileChangeKind(getStringField(change, "type"));
    parsed.push({
      path,
      kind,
      movePath:
        getStringField(kindRecord, "move_path") ??
        getStringField(kindRecord, "movePath") ??
        null,
      diff:
        getStringField(change, "diff") ??
        getStringField(change, "unified_diff") ??
        getStringField(change, "content"),
    });
  }

  return parsed;
}

function parseFileChangesFromMap(changes: unknown): UIFileEditChange[] {
  const record = toRecord(changes);
  if (!record) return [];

  const parsed: UIFileEditChange[] = [];
  for (const [path, value] of Object.entries(record)) {
    const change = toRecord(value);
    if (!change) continue;

    parsed.push({
      path,
      kind: normalizeFileChangeKind(getStringField(change, "type")),
      movePath:
        getStringField(change, "move_path") ??
        getStringField(change, "movePath") ??
        null,
      diff:
        getStringField(change, "unified_diff") ??
        getStringField(change, "content"),
    });
  }

  return parsed;
}

interface FileEditPartial extends Partial<UIFileEditMessage> {
  callId: string;
  appendStdout?: boolean;
}

function parseFileEditFromItemEvent(
  event: ThreadEvent,
  eventType: string,
): FileEditPartial | null {
  if (eventType === "item/filechange/outputdelta") {
    const params = toRecord(event.data);
    const callId = getStringField(params, "itemId");
    if (!callId) return null;

    const delta = getStringField(params, "delta") ?? "";
    return {
      callId,
      stdout: delta,
      appendStdout: true,
      status: "pending",
    };
  }

  if (eventType !== "item/started" && eventType !== "item/completed") return null;
  if (getItemTypeToken(event.data) !== "filechange") return null;

  const item = getItemRecord(event.data);
  const callId = getStringField(item, "id");
  if (!callId) return null;

  const defaultStatus = eventType === "item/completed" ? "completed" : "pending";
  return {
    callId,
    changes: parseFileChangesFromArray(item?.changes),
    status: toFileEditStatus(getStringField(item, "status")) ?? defaultStatus,
  };
}

function parseFileEditFromPatchEvent(
  event: ThreadEvent,
  eventType: string,
): FileEditPartial | null {
  if (
    eventType !== "codex/event/patch_apply_begin" &&
    eventType !== "codex/event/patch_apply_end"
  ) {
    return null;
  }

  const msg = getMsgRecord(event.data);
  const callId = getStringField(msg, "call_id");
  if (!callId) return null;

  const success = msg?.success;
  const statusToken = toFileEditStatus(getStringField(msg, "status"));
  const status: UIFileEditMessage["status"] = statusToken
    ? statusToken
    : eventType === "codex/event/patch_apply_end"
      ? success === false
        ? "error"
        : "completed"
      : "pending";

  return {
    callId,
    changes: parseFileChangesFromMap(msg?.changes),
    stdout: getStringField(msg, "stdout"),
    stderr: getStringField(msg, "stderr"),
    status,
  };
}

function parseOperationMessage(
  event: ThreadEvent,
  eventType: string,
  options?: { includeOptionalOperations?: boolean },
): UIOperationMessage | null {
  if (eventType === "turn/plan/updated") {
    const payload = toRecord(event.data);
    const plan = Array.isArray(payload?.plan) ? payload.plan : [];
    const explanation = getStringField(payload, "explanation");
    const steps = plan
      .map((entry) => {
        const step = toRecord(entry);
        if (!step) return null;
        const status = getStringField(step, "status");
        const text = getStringField(step, "step");
        if (!text) return null;
        return status ? `[${status}] ${text}` : text;
      })
      .filter((value): value is string => Boolean(value));

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `plan:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "plan-updated",
      title: "Plan updated",
      detail:
        explanation ??
        (steps.length > 0 ? steps.join(" • ") : undefined),
    };
  }

  if (eventType === "item/mcptoolcall/progress") {
    const payload = toRecord(event.data);
    const detail =
      getStringField(payload, "message") ??
      extractText(payload?.detail);
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `mcp-progress:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "mcp-progress",
      title: "MCP tool progress",
      detail: detail || undefined,
    };
  }

  if (
    eventType === "deprecationnotice" ||
    eventType === "codex/event/deprecation_notice"
  ) {
    const payload = toRecord(event.data);
    const detail =
      getStringField(payload, "summary") ??
      getStringField(payload, "details") ??
      extractText(payload);

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `deprecation:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "deprecation",
      title: "Deprecation notice",
      detail: detail || undefined,
    };
  }

  if (
    eventType === "configwarning" ||
    eventType === "windows/worldwritablewarning" ||
    eventType === "warning"
  ) {
    const payload = toRecord(event.data);
    const detail =
      getStringField(payload, "summary") ??
      getStringField(payload, "details") ??
      extractText(payload);

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `warning:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "warning",
      title: "Configuration warning",
      detail: detail || undefined,
    };
  }

  if (eventType.includes("compact")) {
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `compaction:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "compaction",
      title: "Context compacted",
      detail: extractText(event.data) || undefined,
    };
  }

  if (
    options?.includeOptionalOperations &&
    (eventType === "turn/diff/updated" || eventType === "codex/event/turn_diff")
  ) {
    const params = toRecord(event.data);
    const msg = toRecord(params?.msg);
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `turn-diff:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "turn-diff",
      title: "Turn diff updated",
      detail: getStringField(params, "diff") ?? getStringField(msg, "unified_diff"),
    };
  }

  return null;
}

function parseErrorMessage(event: ThreadEvent, eventType: string): UIErrorMessage | null {
  if (!eventType.includes("error")) return null;

  const message = extractText(event.data);
  return {
    kind: "error",
    id: messageId(event.threadId, "error", `${event.seq}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    turnId: getTurnId(event.data),
    rawType: eventType,
    message: message || "Error event",
  };
}

function isIgnoredNoiseType(eventType: string): boolean {
  const ignored = new Set([
    "provider/event",
    "thread/started",
    "thread/title/updated",
    "thread/name/updated",
    "codex/event/thread_name_updated",
    "codex/event/mcp_startup_complete",
    "codex/event/token_count",
    "account/ratelimits/updated",
    "thread/tokenusage/updated",
    "codex/event/agent_reasoning_section_break",
    "item/reasoning/summarypartadded",
  ]);

  return ignored.has(eventType);
}

function isDuplicateEventType(eventType: string): boolean {
  const duplicates = new Set([
    "turn/started",
    "turn/completed",
    "codex/event/task_started",
    "codex/event/task_complete",
    "codex/event/item_started",
    "codex/event/item_completed",
    "codex/event/agent_message_content_delta",
    "codex/event/agent_message_delta",
    "codex/event/agent_message",
    "codex/event/reasoning_content_delta",
    "codex/event/agent_reasoning_delta",
    "codex/event/agent_reasoning",
    "codex/event/exec_command_output_delta",
    "item/commandexecution/outputdelta",
    "item/filechange/outputdelta",
    "codex/event/turn_diff",
    "turn/diff/updated",
  ]);

  return duplicates.has(eventType);
}

function isIgnoredItemStartEvent(event: ThreadEvent, eventType: string): boolean {
  if (eventType !== "item/started") return false;

  const itemTypeToken = getItemTypeToken(event.data);
  return itemTypeToken === "reasoning" || itemTypeToken === "agentmessage";
}

function appendDebugEvent(
  out: UIMessage[],
  event: ThreadEvent,
  eventType: string,
  reason: UIDebugRawEventMessage["reason"],
): void {
  out.push({
    kind: "debug/raw-event",
    id: messageId(event.threadId, "debug", `${event.seq}:${eventType}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    turnId: getTurnId(getEventData(event)),
    rawType: eventType,
    rawEvent: event,
    reason,
  });
}

interface ProjectionState {
  messages: UIMessage[];
  seenUserKeys: Set<string>;
  openAssistantByTurn: Map<string, UIAssistantTextMessage>;
  openReasoningByTurn: Map<string, UIAssistantReasoningMessage>;
  toolsByCallId: Map<string, UIToolCallMessage>;
  fileEditsByCallId: Map<string, UIFileEditMessage>;
}

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    seenUserKeys: new Set(),
    openAssistantByTurn: new Map(),
    openReasoningByTurn: new Map(),
    toolsByCallId: new Map(),
    fileEditsByCallId: new Map(),
  };
}

function upsertTool(
  state: ProjectionState,
  event: ThreadEvent,
  partial: ToolPartial,
): void {
  const existing = state.toolsByCallId.get(partial.callId);
  const turnId = getTurnId(event.data);

  if (!existing) {
    const message: UIToolCallMessage = {
      kind: "tool-call",
      id: messageId(event.threadId, "tool", partial.callId),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      ...(turnId ? { turnId } : {}),
      toolName: partial.toolName ?? "exec_command",
      callId: partial.callId,
      command: partial.command,
      cwd: partial.cwd,
      output: partial.output,
      exitCode: partial.exitCode,
      status: partial.status ?? "pending",
    };
    state.toolsByCallId.set(partial.callId, message);
    state.messages.push(message);
    return;
  }

  existing.sourceSeqEnd = event.seq;
  existing.createdAt = event.createdAt;

  if (!existing.turnId && turnId) existing.turnId = turnId;

  if (partial.command) {
    if (!existing.command || partial.command.length > existing.command.length) {
      existing.command = partial.command;
    }
  }

  if (partial.cwd && !existing.cwd) {
    existing.cwd = partial.cwd;
  }

  if (partial.output && partial.output.length > 0) {
    if (partial.appendOutput) {
      existing.output = `${existing.output ?? ""}${partial.output}`;
    } else if (!existing.output || partial.output.length >= existing.output.length) {
      existing.output = partial.output;
    }
  }

  if (partial.exitCode !== undefined) existing.exitCode = partial.exitCode;
  if (partial.toolName) existing.toolName = partial.toolName;

  if (partial.status) {
    if (partial.status === "error") {
      existing.status = "error";
    } else if (existing.status === "pending" || existing.status === "interrupted") {
      existing.status = partial.status;
    } else if (existing.status !== "error" && partial.status === "completed") {
      existing.status = "completed";
    }
  }
}

function mergeFileChanges(
  existing: UIFileEditChange[],
  incoming: UIFileEditChange[],
): UIFileEditChange[] {
  const byPath = new Map<string, UIFileEditChange>();

  for (const change of existing) {
    byPath.set(change.path, { ...change });
  }

  for (const change of incoming) {
    const prev = byPath.get(change.path);
    if (!prev) {
      byPath.set(change.path, { ...change });
      continue;
    }

    byPath.set(change.path, {
      path: change.path,
      kind: change.kind ?? prev.kind,
      movePath: change.movePath ?? prev.movePath,
      diff: change.diff ?? prev.diff,
    });
  }

  return [...byPath.values()];
}

function upsertFileEdit(
  state: ProjectionState,
  event: ThreadEvent,
  partial: FileEditPartial,
): void {
  const existing = state.fileEditsByCallId.get(partial.callId);
  const turnId = getTurnId(event.data);

  if (!existing) {
    const message: UIFileEditMessage = {
      kind: "file-edit",
      id: messageId(event.threadId, "file-edit", partial.callId),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      ...(turnId ? { turnId } : {}),
      callId: partial.callId,
      changes: partial.changes ?? [],
      stdout: partial.stdout,
      stderr: partial.stderr,
      status: partial.status ?? "pending",
    };
    state.fileEditsByCallId.set(partial.callId, message);
    state.messages.push(message);
    return;
  }

  existing.sourceSeqEnd = event.seq;
  existing.createdAt = event.createdAt;

  if (!existing.turnId && turnId) existing.turnId = turnId;

  if (partial.changes && partial.changes.length > 0) {
    existing.changes = mergeFileChanges(existing.changes, partial.changes);
  }

  if (partial.stdout) {
    if (partial.appendStdout) {
      existing.stdout = `${existing.stdout ?? ""}${partial.stdout}`;
    } else {
      existing.stdout = partial.stdout;
    }
  }

  if (partial.stderr) {
    existing.stderr = partial.stderr;
  }

  if (partial.status) {
    if (partial.status === "error") {
      existing.status = "error";
    } else if (existing.status === "pending" || existing.status === "interrupted") {
      existing.status = partial.status;
    } else if (existing.status !== "error" && partial.status === "completed") {
      existing.status = "completed";
    }
  }
}

function finalizePendingMessages(
  state: ProjectionState,
  options: ToUIMessagesOptions | undefined,
): void {
  if (options?.threadStatus === "active") return;

  for (const tool of state.toolsByCallId.values()) {
    if (tool.status === "pending") {
      tool.status = "interrupted";
      if (!tool.output) {
        tool.output = "Tool execution interrupted";
      }
    }
  }

  for (const fileEdit of state.fileEditsByCallId.values()) {
    if (fileEdit.status === "pending") {
      fileEdit.status = "interrupted";
    }
  }

  for (const assistant of state.openAssistantByTurn.values()) {
    if (assistant.status === "streaming") {
      assistant.status = "completed";
    }
  }
  state.openAssistantByTurn.clear();

  for (const reasoning of state.openReasoningByTurn.values()) {
    if (reasoning.status === "streaming") {
      reasoning.status = "completed";
    }
  }
  state.openReasoningByTurn.clear();
}

export function toUIMessages(
  events: ThreadEvent[] | undefined,
  options?: ToUIMessagesOptions,
): UIMessage[] {
  if (!events || events.length === 0) return [];

  const state = createProjectionState();
  const includeDebugRawEvents = options?.includeDebugRawEvents ?? false;

  const orderedEvents = [...events].sort((a, b) => a.seq - b.seq);

  for (const originalEvent of orderedEvents) {
    const eventType = getEventType(originalEvent);
    const eventData = getEventData(originalEvent);
    const event =
      eventData === originalEvent.data
        ? originalEvent
        : { ...originalEvent, data: eventData };

    const eventTurnId = getTurnId(event.data);

    const userFromItem = parseUserFromItemEvent(event, eventType);
    if (userFromItem) {
      const key = `${userFromItem.turnId ?? userFromItem.id}:${userFromItem.text}`;
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        state.messages.push(userFromItem);
      }
      continue;
    }

    const userFromCodex = parseUserFromCodexEvent(event, eventType);
    if (userFromCodex) {
      const key = `${userFromCodex.turnId ?? userFromCodex.id}:${userFromCodex.text}`;
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        state.messages.push(userFromCodex);
      }
      continue;
    }

    const assistantDelta = parseAssistantDeltaText(event, eventType);
    if (assistantDelta) {
      const itemId = getItemId(event.data);
      const turnKey = itemId ?? eventTurnId ?? `seq-${event.seq}`;

      let existing = state.openAssistantByTurn.get(turnKey);
      if (!existing) {
        existing = {
          kind: "assistant-text",
          id: messageId(event.threadId, "assistant", turnKey),
          threadId: event.threadId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          createdAt: event.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          text: assistantDelta,
          status: "streaming",
        };
        state.openAssistantByTurn.set(turnKey, existing);
        state.messages.push(existing);
      } else {
        existing.sourceSeqEnd = event.seq;
        existing.createdAt = event.createdAt;
        existing.text += assistantDelta;
      }
      continue;
    }

    const assistantFinal = parseAssistantFinalText(event, eventType);
    if (assistantFinal) {
      const itemId = getItemId(event.data);
      const turnKey = itemId ?? eventTurnId ?? `seq-${event.seq}`;
      const existing = state.openAssistantByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = event.seq;
        existing.createdAt = event.createdAt;
        existing.text = assistantFinal;
        existing.status = "completed";
        state.openAssistantByTurn.delete(turnKey);
      } else {
        state.messages.push({
          kind: "assistant-text",
          id: messageId(event.threadId, "assistant", `${turnKey}:${event.seq}`),
          threadId: event.threadId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          createdAt: event.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          text: assistantFinal,
          status: "completed",
        });
      }
      continue;
    }

    const reasoningDelta = parseReasoningDeltaText(event, eventType);
    if (reasoningDelta) {
      const itemId = getItemId(event.data);
      const turnKey = itemId ?? eventTurnId ?? `seq-${event.seq}`;

      let existing = state.openReasoningByTurn.get(turnKey);
      if (!existing) {
        existing = {
          kind: "assistant-reasoning",
          id: messageId(event.threadId, "reasoning", turnKey),
          threadId: event.threadId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          createdAt: event.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          text: reasoningDelta,
          status: "streaming",
        };
        state.openReasoningByTurn.set(turnKey, existing);
        state.messages.push(existing);
      } else {
        existing.sourceSeqEnd = event.seq;
        existing.createdAt = event.createdAt;
        existing.text += reasoningDelta;
      }
      continue;
    }

    const reasoningFinal = parseReasoningFinalText(event, eventType);
    if (reasoningFinal) {
      const itemId = getItemId(event.data);
      const turnKey = itemId ?? eventTurnId ?? `seq-${event.seq}`;
      const existing = state.openReasoningByTurn.get(turnKey);

      if (existing) {
        existing.sourceSeqEnd = event.seq;
        existing.createdAt = event.createdAt;
        existing.text = reasoningFinal;
        existing.status = "completed";
        state.openReasoningByTurn.delete(turnKey);
      } else {
        state.messages.push({
          kind: "assistant-reasoning",
          id: messageId(event.threadId, "reasoning", `${turnKey}:${event.seq}`),
          threadId: event.threadId,
          sourceSeqStart: event.seq,
          sourceSeqEnd: event.seq,
          createdAt: event.createdAt,
          ...(eventTurnId ? { turnId: eventTurnId } : {}),
          text: reasoningFinal,
          status: "completed",
        });
      }
      continue;
    }

    const tool =
      parseToolFromItemEvent(event, eventType) ??
      parseToolFromExecEvent(event, eventType) ??
      parseToolFromCanonicalEvent(event, eventType);
    if (tool) {
      upsertTool(state, event, tool);
      continue;
    }

    const fileEdit =
      parseFileEditFromItemEvent(event, eventType) ??
      parseFileEditFromPatchEvent(event, eventType);
    if (fileEdit) {
      upsertFileEdit(state, event, fileEdit);
      continue;
    }

    const operation = parseOperationMessage(event, eventType, {
      includeOptionalOperations: options?.includeOptionalOperations,
    });
    if (operation) {
      state.messages.push(operation);
      continue;
    }

    const error = parseErrorMessage(event, eventType);
    if (error) {
      state.messages.push(error);
      continue;
    }

    if (includeDebugRawEvents) {
      const debugReason = isDuplicateEventType(eventType)
        ? "duplicate-event"
        : (isIgnoredNoiseType(eventType) || isIgnoredItemStartEvent(event, eventType))
          ? "ignored-noise"
          : "unhandled";

      if (debugReason !== "unhandled") {
        continue;
      }

      appendDebugEvent(
        state.messages,
        originalEvent,
        eventType,
        debugReason,
      );
    }
  }

  finalizePendingMessages(state, options);
  return state.messages;
}
