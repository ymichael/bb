import type { ThreadEvent } from "./types.js";
import { assertNever } from "./assert-never.js";
import { formatEnvironmentDisplayName } from "./environment-display-name.js";
import {
  normalizeThreadEventType,
  resolveProviderEventMethod,
  unwrapProviderEventPayload,
} from "./thread-event-normalization.js";
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
  UIPrimaryCheckoutAction,
  UIPrimaryCheckoutMetadata,
  UIPrimaryCheckoutPhase,
  UIProvisioningSetupStatus,
  UIToolCallMessage,
  UIToolCallSummary,
  UIToolExploringMessage,
  UIToolParsedIntent,
  UIThreadOperationIntentAction,
  UIThreadOperationIntentMetadata,
  UIThreadOperationIntentPhase,
  UIWebSearchMessage,
  UIUserMessage,
} from "./ui-message.js";

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toEventData(value: unknown): unknown {
  return unwrapProviderEventPayload(value);
}

function toEventRecord(value: unknown): Record<string, unknown> | null {
  return toRecord(toEventData(value));
}

const EVENT_TYPE_CANDIDATES_CACHE_LIMIT = 256;
const eventTypeCandidatesCache = new Map<string, Set<string>>();
const normalizedExpectedTypeCache = new Map<string, string>();

function getEventTypeCandidates(eventType: string): Set<string> {
  const cached = eventTypeCandidatesCache.get(eventType);
  if (cached) {
    return cached;
  }

  const normalized = normalizeThreadEventType(eventType);
  const candidates = new Set<string>([normalized]);

  candidates.add(normalized.replaceAll("_", "/"));
  candidates.add(normalized.replaceAll("/", "_"));

  if (eventTypeCandidatesCache.size >= EVENT_TYPE_CANDIDATES_CACHE_LIMIT) {
    eventTypeCandidatesCache.clear();
  }
  eventTypeCandidatesCache.set(eventType, candidates);
  return candidates;
}

function eventTypeMatches(eventType: string, expected: string): boolean {
  const candidates = getEventTypeCandidates(eventType);
  const normalizedExpected =
    normalizedExpectedTypeCache.get(expected) ?? normalizeThreadEventType(expected);
  if (!normalizedExpectedTypeCache.has(expected)) {
    normalizedExpectedTypeCache.set(expected, normalizedExpected);
  }
  return (
    candidates.has(normalizedExpected) ||
    candidates.has(normalizedExpected.replaceAll("_", "/")) ||
    candidates.has(normalizedExpected.replaceAll("/", "_"))
  );
}

function eventTypeMatchesAny(eventType: string, expected: string[]): boolean {
  return expected.some((candidate) => eventTypeMatches(eventType, candidate));
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

function getNullableStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null | undefined {
  const value = record?.[key];
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
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

function getFirstStringField(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = getStringField(record, key);
    if (value) return value;
  }
  return undefined;
}

function getFirstNumberField(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = getNumberField(record, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getStringArrayField(
  record: Record<string, unknown> | null,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => {
    return typeof entry === "string" && entry.length > 0;
  });
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
  const providerMethod = resolveProviderEventMethod(event.type, event.data);
  return normalizeThreadEventType(providerMethod);
}

function getTurnId(data: unknown): string | undefined {
  const params = toEventRecord(data);
  if (!params) return undefined;

  if (typeof params.turnId === "string" && params.turnId.length > 0) {
    return params.turnId;
  }
  if (typeof params.turn_id === "string" && params.turn_id.length > 0) {
    return params.turn_id;
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
  const params = toEventRecord(data);
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

  const params = toEventRecord(data);
  const paramsItemId = getStringField(params, "itemId");
  if (paramsItemId) return paramsItemId;

  const msg = toRecord(params?.msg);
  const msgItemId = getStringField(msg, "item_id");
  if (msgItemId) return msgItemId;

  return undefined;
}

function getEventPayloadRecord(data: unknown): Record<string, unknown> | null {
  const params = toEventRecord(data);
  if (!params) return null;
  const msg = toRecord(params.msg);
  return msg ?? params;
}

function parsePromptInput(input: unknown): {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
  imageUrls: string[];
  localImagePaths: string[];
  localFilePaths: string[];
} | null {
  if (!Array.isArray(input)) return null;

  const textParts: string[] = [];
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

  for (const entry of input) {
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
      if (typeof part.url === "string" && part.url.length > 0) {
        imageUrls.push(part.url);
      }
      continue;
    }
    if (typeToken === "localimage") {
      localImages += 1;
      if (typeof part.path === "string" && part.path.length > 0) {
        localImagePaths.push(part.path);
      }
      continue;
    }
    if (typeToken === "localfile") {
      localFiles += 1;
      if (typeof part.path === "string" && part.path.length > 0) {
        localFilePaths.push(part.path);
      }
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

function parseThreadOperationIntentAction(
  operation: string | undefined,
): UIThreadOperationIntentAction | null {
  switch (operation) {
    case "commit":
      return "commit";
    case "squash_merge":
      return "squash_merge";
    default:
      return null;
  }
}

function parsePrimaryCheckoutAction(action: string | undefined): UIPrimaryCheckoutAction | null {
  switch (action) {
    case "promote":
      return "promote";
    case "demote":
      return "demote";
    default:
      return null;
  }
}

function parsePrimaryCheckoutPhase(status: string | undefined): UIPrimaryCheckoutPhase {
  switch (status) {
    case "started":
      return "started";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "noop":
      return "noop";
    default:
      // Persisted event payloads are open_external at read-time; unknown statuses map to generic updates.
      return "update";
  }
}

function toPrimaryCheckoutMetadata(
  payload: Record<string, unknown> | null,
): UIPrimaryCheckoutMetadata | null {
  const action = parsePrimaryCheckoutAction(getStringField(payload, "action"));
  if (!action) return null;
  return {
    action,
    phase: parsePrimaryCheckoutPhase(getStringField(payload, "status")),
  };
}

function primaryCheckoutTitle(metadata: UIPrimaryCheckoutMetadata | null): string {
  if (!metadata) {
    return "Primary checkout update";
  }

  switch (metadata.action) {
    case "promote":
      switch (metadata.phase) {
        case "started":
          return "Promoting primary checkout";
        case "completed":
          return "Promoted to primary checkout";
        case "failed":
          return "Primary checkout promotion failed";
        case "noop":
          return "Primary checkout already promoted";
        case "update":
          return "Primary checkout promotion update";
        default:
          return assertNever(metadata.phase);
      }
    case "demote":
      switch (metadata.phase) {
        case "started":
          return "Demoting primary checkout";
        case "completed":
          return "Demoted from primary checkout";
        case "failed":
          return "Primary checkout demotion failed";
        case "noop":
          return "Primary checkout already demoted";
        case "update":
          return "Primary checkout demotion update";
        default:
          return assertNever(metadata.phase);
      }
    default:
      return assertNever(metadata.action);
  }
}

function parseThreadOperationIntentPhase(
  status: string | undefined,
): UIThreadOperationIntentPhase {
  switch (status) {
    case "requested":
      return "requested";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      // Persisted event payloads are open_external at read-time; unknown statuses map to generic updates.
      return "update";
  }
}

function toThreadOperationIntentMetadata(
  payload: Record<string, unknown> | null,
): UIThreadOperationIntentMetadata | null {
  const action = parseThreadOperationIntentAction(getStringField(payload, "operation"));
  if (!action) return null;

  const phase = parseThreadOperationIntentPhase(getStringField(payload, "status"));
  const operationId = getStringField(payload, "operationId");
  return {
    action,
    phase,
    ...(operationId ? { operationId } : {}),
  };
}

function threadOperationIntentTitle(metadata: UIThreadOperationIntentMetadata | null): string {
  if (!metadata) {
    return "Thread operation update";
  }

  switch (metadata.action) {
    case "commit":
      switch (metadata.phase) {
        case "requested":
          return "Commit requested";
        case "queued":
          return "Commit queued";
        case "running":
          return "Committing changes";
        case "completed":
          return "Commit completed";
        case "failed":
          return "Commit failed";
        case "update":
          return "Commit operation update";
        default:
          return assertNever(metadata.phase);
      }
    case "squash_merge":
      switch (metadata.phase) {
        case "requested":
          return "Squash merge requested";
        case "queued":
          return "Squash merge queued";
        case "running":
          return "Squash merging changes";
        case "completed":
          return "Squash merge completed";
        case "failed":
          return "Squash merge failed";
        case "update":
          return "Squash merge operation update";
        default:
          return assertNever(metadata.phase);
      }
    default:
      return assertNever(metadata.action);
  }
}

function userMessageSignature(value: {
  text: string;
  webImages: number;
  localImages: number;
  localFiles: number;
}): string {
  const totalImages = value.webImages + value.localImages;
  return `${value.text}\u0000${totalImages}\u0000${value.localFiles}`;
}

function shouldRenderThreadStartInput(
  threadStatus: ToUIMessagesOptions["threadStatus"] | undefined,
): boolean {
  if (!threadStatus) return false;
  switch (threadStatus) {
    case "created":
    case "provisioning":
    case "provisioning_failed":
    case "idle":
    case "active":
      return true;
    default:
      return assertNever(threadStatus);
  }
}

function messageId(threadId: string, kind: string, key: string): string {
  return `${threadId}:${kind}:${key}`;
}

function parseUserFromItemEvent(
  event: ThreadEvent,
  eventType: string,
): UIUserMessage | null {
  if (!eventTypeMatchesAny(eventType, ["item/started", "item/completed"])) {
    return null;
  }
  if (getItemTypeToken(event.data) !== "usermessage") return null;

  const item = getItemRecord(event.data);
  const content = Array.isArray(item?.content) ? item.content : [];
  const textParts: string[] = [];
  let webImages = 0;
  let localImages = 0;
  let localFiles = 0;
  const imageUrls: string[] = [];
  const localImagePaths: string[] = [];
  const localFilePaths: string[] = [];

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
      const imageUrl =
        getStringField(part, "image_url") ??
        getStringField(part, "url") ??
        getStringField(toRecord(part.data), "image_url") ??
        getStringField(toRecord(part.data), "url");
      if (imageUrl) {
        imageUrls.push(imageUrl);
      }
      continue;
    }

    if (typeToken === "localimage") {
      localImages += 1;
      const imagePath =
        getStringField(part, "path") ??
        getStringField(toRecord(part.data), "path");
      if (imagePath) {
        localImagePaths.push(imagePath);
      }
      continue;
    }

    if (typeToken === "localfile") {
      localFiles += 1;
      const filePath =
        getStringField(part, "path") ??
        getStringField(toRecord(part.data), "path");
      if (filePath) {
        localFilePaths.push(filePath);
      }
    }
  }

  const text = textParts.join("");
  if (!text && webImages === 0 && localImages === 0 && localFiles === 0) {
    return null;
  }

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
      localFiles,
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
      ...(localImagePaths.length > 0 ? { localImagePaths } : {}),
      ...(localFilePaths.length > 0 ? { localFilePaths } : {}),
    },
  };
}

function parseUserFromClientStart(
  event: ThreadEvent,
  eventType: string,
  options?: ToUIMessagesOptions,
): UIUserMessage | null {
  if (
    !eventTypeMatchesAny(eventType, [
      "client/thread/start",
      "client/turn/start",
    ])
  ) {
    return null;
  }

  const payload = toEventRecord(event.data);
  const parsedInput = parsePromptInput(payload?.input);
  if (!parsedInput) return null;
  if (!shouldRenderThreadStartInput(options?.threadStatus)) {
    return null;
  }

  return {
    kind: "user",
    id: messageId(event.threadId, "user-seed", `${event.seq}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    text: parsedInput.text,
    attachments: {
      webImages: parsedInput.webImages,
      localImages: parsedInput.localImages,
      localFiles: parsedInput.localFiles,
      ...(parsedInput.imageUrls.length > 0
        ? { imageUrls: parsedInput.imageUrls }
        : {}),
      ...(parsedInput.localImagePaths.length > 0
        ? { localImagePaths: parsedInput.localImagePaths }
        : {}),
      ...(parsedInput.localFilePaths.length > 0
        ? { localFilePaths: parsedInput.localFilePaths }
        : {}),
    },
  };
}

function parseAssistantDeltaText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (!eventTypeMatches(eventType, "item/agentmessage/delta")) {
    return null;
  }

  const params = toEventRecord(event.data);
  const text = extractText(params?.delta ?? params?.text ?? params?.content);
  return text.length > 0 ? text : null;
}

function parseAssistantFinalText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (
    eventTypeMatches(eventType, "item/completed") &&
    getItemTypeToken(event.data) === "agentmessage"
  ) {
    const item = getItemRecord(event.data);
    const text = extractText(item?.text ?? item?.content);
    return text.length > 0 ? text : null;
  }

  return null;
}

function parseReasoningDeltaText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (!eventTypeMatchesAny(eventType, [
    "item/reasoning/summarytextdelta",
    "item/reasoning/textdelta",
  ])) {
    return null;
  }

  const params = toEventRecord(event.data);
  const text = extractText(params?.delta ?? params?.text ?? params?.content);
  return text.length > 0 ? text : null;
}

function parseReasoningFinalText(
  event: ThreadEvent,
  eventType: string,
): string | null {
  if (
    eventTypeMatches(eventType, "item/completed") &&
    getItemTypeToken(event.data) === "reasoning"
  ) {
    const item = getItemRecord(event.data);
    const text = extractText(item?.summary ?? item?.summaryText ?? item?.text ?? item?.content);
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

const SHELL_WRAPPER_NAMES = new Set(["sh", "bash", "zsh"]);

function unwrapQuotedShellArg(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "'" && quote !== '"') || value[value.length - 1] !== quote) {
    return value;
  }
  return value.slice(1, -1);
}

function isKnownShellWrapper(value: string): boolean {
  const shellName = value.split("/").pop() ?? value;
  // Shell wrapper names are open_external runtime values; unknown shells intentionally
  // preserve the original command payload for display.
  return SHELL_WRAPPER_NAMES.has(shellName);
}

function extractShellCommandFromString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const match = /^(\S+)\s+(-lc|-c)\s+([\s\S]+)$/.exec(trimmed);
  if (!match) return trimmed;

  const shellProgram = match[1];
  const commandArg = match[3];
  if (!shellProgram || !commandArg || !isKnownShellWrapper(shellProgram)) {
    return trimmed;
  }

  return unwrapQuotedShellArg(commandArg.trim());
}

function toProvisioningSetupStatus(
  value: unknown,
): UIProvisioningSetupStatus | undefined {
  if (typeof value !== "string") return undefined;
  const token = normalizeToken(value);
  switch (token) {
    case "started":
      return "started";
    case "running":
    case "progress":
    case "inprogress":
      return "running";
    case "completed":
    case "complete":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

function extractShellCommand(value: unknown): string | undefined {
  if (typeof value === "string") return extractShellCommandFromString(value);

  if (Array.isArray(value)) {
    const parts = value.filter((entry): entry is string => typeof entry === "string");
    if (parts.length === 0) return undefined;

    if (
      parts.length >= 3 &&
      (parts[1] === "-lc" || parts[1] === "-c") &&
      parts[0] &&
      isKnownShellWrapper(parts[0])
    ) {
      return parts[2] || undefined;
    }

    return parts.join(" ");
  }

  return undefined;
}

function normalizeParsedIntentType(value: string | undefined): UIToolParsedIntent["type"] {
  const token = normalizeToken(value ?? "");
  if (token === "read") return "read";
  if (token === "search") return "search";
  if (token === "listfiles" || token === "listfile" || token === "ls") {
    return "list_files";
  }
  return "unknown";
}

function toParsedIntent(
  intent: Record<string, unknown>,
  commandField: "cmd" | "command",
): UIToolParsedIntent | null {
  const type = normalizeParsedIntentType(getStringField(intent, "type"));
  const command = getStringField(intent, commandField);
  if (!command) return null;

  if (type === "read") {
    const name = getStringField(intent, "name");
    if (!name) return null;
    return {
      type: "read",
      cmd: command,
      name,
      path: getNullableStringField(intent, "path") ?? null,
    };
  }

  if (type === "list_files") {
    return {
      type: "list_files",
      cmd: command,
      path: getNullableStringField(intent, "path") ?? null,
    };
  }

  if (type === "search") {
    return {
      type: "search",
      cmd: command,
      query: getNullableStringField(intent, "query") ?? null,
      path: getNullableStringField(intent, "path") ?? null,
    };
  }

  return {
    type: "unknown",
    cmd: command,
  };
}

function parseParsedIntentArray(
  value: unknown,
  commandField: "cmd" | "command",
): UIToolParsedIntent[] {
  if (!Array.isArray(value)) return [];

  const intents: UIToolParsedIntent[] = [];
  for (const entry of value) {
    const record = toRecord(entry);
    if (!record) continue;
    const parsed = toParsedIntent(record, commandField);
    if (parsed) intents.push(parsed);
  }
  return intents;
}

function parseParsedIntentsFromRecord(
  record: Record<string, unknown> | null,
): UIToolParsedIntent[] {
  if (!record) return [];

  const modernSnake = parseParsedIntentArray(record.parsed_cmd, "cmd");
  if (modernSnake.length > 0) return modernSnake;

  const modernCamel = parseParsedIntentArray(record.parsedCmd, "cmd");
  if (modernCamel.length > 0) return modernCamel;

  const legacyCamel = parseParsedIntentArray(record.commandActions, "command");
  if (legacyCamel.length > 0) return legacyCamel;

  const legacySnake = parseParsedIntentArray(record.command_actions, "command");
  if (legacySnake.length > 0) return legacySnake;

  return [];
}

function durationToString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${Math.round(value)}ms`;
  }
  return undefined;
}

interface ExecCallPartial extends Partial<UIToolCallSummary> {
  callId: string;
  parsedCmd: UIToolParsedIntent[];
}

interface ExecLifecycleEvent {
  kind: "begin" | "end" | "output";
  call: ExecCallPartial;
  appendOutput?: boolean;
}

function toExecDefaultStatus(kind: "begin" | "end"): UIToolCallMessage["status"] {
  if (kind === "begin") return "pending";
  return "completed";
}

function parseExecLifecycleEvent(
  event: ThreadEvent,
  eventType: string,
): ExecLifecycleEvent | null {
  if (eventTypeMatches(eventType, "item/commandexecution/outputdelta")) {
    const payload = getEventPayloadRecord(event.data);
    const callId = getFirstStringField(payload, ["itemId", "item_id", "call_id"]);
    if (!callId) return null;
    const delta = getFirstStringField(payload, ["delta"]);
    return {
      kind: "output",
      call: {
        callId,
        parsedCmd: [],
        output: delta,
        status: "pending",
      },
      appendOutput: true,
    };
  }

  if (eventTypeMatches(eventType, "exec_command_output_delta")) {
    const payload = getEventPayloadRecord(event.data);
    const callId = getFirstStringField(payload, ["call_id"]);
    if (!callId) return null;
    const delta = getFirstStringField(payload, ["delta"]);
    return {
      kind: "output",
      call: {
        callId,
        parsedCmd: [],
        output: delta,
        status: "pending",
      },
      appendOutput: true,
    };
  }

  if (
    eventTypeMatchesAny(eventType, ["item/started", "item/completed"]) &&
    getItemTypeToken(event.data) === "commandexecution"
  ) {
    const item = getItemRecord(event.data);
    const callId = getFirstStringField(item, ["id"]);
    if (!callId) return null;

    const kind = eventTypeMatches(eventType, "item/started") ? "begin" : "end";
    const exitCode = getFirstNumberField(item, ["exitCode", "exit_code"]);
    const status =
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : (toToolStatus(getFirstStringField(item, ["status"])) ??
            toExecDefaultStatus(kind));

    return {
      kind,
      call: {
        callId,
        command: extractShellCommand(item?.command),
        cwd: getFirstStringField(item, ["cwd"]),
        parsedCmd: parseParsedIntentsFromRecord(item),
        source: getFirstStringField(item, ["source"]),
        output: getFirstStringField(item, ["aggregatedOutput", "aggregated_output"]),
        exitCode,
        duration: durationToString(
          getFirstStringField(item, ["duration"]) ??
            getFirstNumberField(item, ["durationMs"]),
        ),
        status,
      },
    };
  }

  if (
    eventTypeMatchesAny(eventType, ["exec_command_begin", "exec_command_end"])
  ) {
    const payload = getEventPayloadRecord(event.data);
    const callId = getFirstStringField(payload, ["call_id"]);
    if (!callId) return null;

    const kind = eventTypeMatches(eventType, "exec_command_begin") ? "begin" : "end";
    const exitCode = getFirstNumberField(payload, ["exit_code"]);
    const status =
      exitCode !== undefined && exitCode !== 0
        ? "error"
        : (toToolStatus(getFirstStringField(payload, ["status"])) ??
            toExecDefaultStatus(kind));

    return {
      kind,
      call: {
        callId,
        command: extractShellCommand(payload?.command),
        cwd: getFirstStringField(payload, ["cwd"]),
        parsedCmd: parseParsedIntentsFromRecord(payload),
        source: getFirstStringField(payload, ["source"]),
        output: getFirstStringField(payload, [
          "formatted_output",
          "aggregated_output",
        ]),
        exitCode,
        duration: durationToString(
          getFirstStringField(payload, ["duration"]) ??
            getFirstNumberField(payload, ["duration_ms"]),
        ),
        status,
      },
    };
  }

  return null;
}

interface WebSearchLifecycleEvent {
  kind: "begin" | "end";
  callId: string;
  query?: string;
  action?: string;
}

function parseWebSearchAction(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  const record = toRecord(value);
  // Open provider/runtime set: preserve provider-defined action types.
  return getStringField(record, "type");
}

function parseWebSearchLifecycleEvent(
  event: ThreadEvent,
  eventType: string,
): WebSearchLifecycleEvent | null {
  if (
    eventTypeMatchesAny(eventType, ["item/started", "item/completed"]) &&
    getItemTypeToken(event.data) === "websearch"
  ) {
    const item = getItemRecord(event.data);
    const callId = getFirstStringField(item, ["id"]);
    if (!callId) return null;

    return {
      kind: eventTypeMatches(eventType, "item/started") ? "begin" : "end",
      callId,
      query: getFirstStringField(item, ["query"]),
      action: parseWebSearchAction(item?.action),
    };
  }

  return null;
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

interface FileEditPartial extends Partial<UIFileEditMessage> {
  callId: string;
  appendStdout?: boolean;
}

function parseFileEditFromItemEvent(
  event: ThreadEvent,
  eventType: string,
): FileEditPartial | null {
  if (eventTypeMatches(eventType, "item/filechange/outputdelta")) {
    const payload = getEventPayloadRecord(event.data);
    const callId = getFirstStringField(payload, ["itemId", "item_id"]);
    if (!callId) return null;

    const delta = getFirstStringField(payload, ["delta"]) ?? "";
    return {
      callId,
      stdout: delta,
      appendStdout: true,
      status: "pending",
    };
  }

  if (!eventTypeMatchesAny(eventType, ["item/started", "item/completed"])) {
    return null;
  }
  if (getItemTypeToken(event.data) !== "filechange") return null;

  const item = getItemRecord(event.data);
  const callId = getFirstStringField(item, ["id"]);
  if (!callId) return null;

  const defaultStatus = eventType === "item/completed" ? "completed" : "pending";
  return {
    callId,
    changes: parseFileChangesFromArray(item?.changes),
    stdout: getFirstStringField(item, [
      "stdout",
      "aggregatedOutput",
      "aggregated_output",
    ]),
    stderr: getFirstStringField(item, ["stderr"]),
    status: toFileEditStatus(getFirstStringField(item, ["status"])) ?? defaultStatus,
  };
}

function parseOperationMessage(
  event: ThreadEvent,
  eventType: string,
  options?: { includeOptionalOperations?: boolean },
): UIOperationMessage | null {
  function formatPlanStepStatus(status: string): string {
    switch (normalizeToken(status)) {
      case "inprogress":
        return "In progress";
      case "pending":
        return "Pending";
      case "completed":
        return "Completed";
      default:
        // Open provider/runtime values: keep unknown statuses readable without dropping them.
        return status;
    }
  }

  if (eventTypeMatches(eventType, "turn/plan/updated")) {
    const payload = toEventRecord(event.data);
    const plan = Array.isArray(payload?.plan) ? payload.plan : [];
    const explanation = getStringField(payload, "explanation");
    const steps = plan
      .map((entry) => {
        const step = toRecord(entry);
        if (!step) return null;
        const status = getStringField(step, "status");
        const text = getStringField(step, "step");
        if (!text) return null;
        return status
          ? `• [${formatPlanStepStatus(status)}] ${text}`
          : `• ${text}`;
      })
      .filter((value): value is string => Boolean(value));

    const detail =
      explanation && steps.length > 0
        ? `${explanation}\n${steps.join("\n")}`
        : explanation ?? (steps.length > 0 ? steps.join("\n") : undefined);

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
      detail,
    };
  }

  if (eventTypeMatches(eventType, "item/mcptoolcall/progress")) {
    const payload = toEventRecord(event.data);
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

  if (eventTypeMatchesAny(eventType, ["deprecationnotice", "deprecation_notice"])) {
    const payload = toEventRecord(event.data);
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
    eventTypeMatchesAny(eventType, ["configwarning", "config_warning"]) ||
    eventTypeMatchesAny(eventType, [
      "windows/worldwritablewarning",
      "windows_worldwritable_warning",
    ])
  ) {
    const payload = toEventRecord(event.data);
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

  if (eventTypeMatches(eventType, "system/provisioning/started")) {
    const payload = toEventRecord(event.data);
    const environmentDisplayName = formatEnvironmentDisplayName({
      id: getStringField(payload, "environmentId"),
      displayName: getStringField(payload, "environmentDisplayName"),
    });
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `provisioning-started:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "provisioning-started",
      title: "Provisioning started",
      detail: environmentDisplayName
        ? `Environment: ${environmentDisplayName}`
        : undefined,
    };
  }

  if (eventTypeMatches(eventType, "system/provisioning/env_setup")) {
    const payload = toEventRecord(event.data);
    const rawStatus = getStringField(payload, "status");
    const status = toProvisioningSetupStatus(rawStatus);
    const title = (() => {
      switch (status) {
        case "started":
          return "Environment setup started";
        case "running":
          return "Environment setup running";
        case "completed":
          return "Environment setup completed";
        case "failed":
          return "Environment setup failed";
        default:
          // Persisted payloads are open_external at read-time; tolerate unknown statuses.
          return "Environment setup update";
      }
    })();

    const scriptPath = getStringField(payload, "scriptPath");
    const timeoutMs = getNumberField(payload, "timeoutMs");
    const durationMs = getNumberField(payload, "durationMs");
    const output = getStringField(payload, "detail");
    const detailParts = [
      scriptPath,
      timeoutMs !== undefined ? `Timeout ${Math.round(timeoutMs / 1000)}s` : undefined,
      durationMs !== undefined ? `Duration ${durationMs}ms` : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `provisioning-env-setup:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "provisioning-env-setup",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      ...(status
        ? {
            provisioning: {
              setup: {
                status,
                ...(scriptPath ? { scriptPath } : {}),
                ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
                ...(output ? { output } : {}),
              },
            },
          }
        : {}),
    };
  }

  if (eventTypeMatches(eventType, "system/thread-title/updated")) {
    const payload = toEventRecord(event.data);
    // Avoid duplicate rows when the underlying provider thread/name/updated
    // event is also present in the timeline.
    if (eventTypeMatches(getStringField(payload, "providerMethod") ?? "", "thread/name/updated")) {
      return null;
    }
    const title = getStringField(payload, "title");
    if (!title) return null;
    const previousTitle = getStringField(payload, "previousTitle");
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `thread-title-updated:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "thread-title-updated",
      title: "Title updated",
      detail: previousTitle
        ? `${previousTitle} → ${title}`
        : title,
    };
  }

  if (eventTypeMatches(eventType, "thread/name/updated")) {
    const payload = toEventRecord(event.data);
    const title = getFirstStringField(payload, ["threadName", "thread_name"]);
    if (!title) return null;
    const previousTitle = getFirstStringField(payload, [
      "previousThreadName",
      "previous_thread_name",
    ]);
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `thread-title-updated:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "thread-title-updated",
      title: "Title updated",
      detail: previousTitle ? `${previousTitle} → ${title}` : title,
    };
  }

  if (eventTypeMatches(eventType, "system/primary_checkout/updated")) {
    const payload = toEventRecord(event.data);
    const primaryCheckout = toPrimaryCheckoutMetadata(payload);
    const message = getStringField(payload, "message");
    const branch = getStringField(payload, "branch");
    const detailParts = [
      message,
      branch ? `Branch: ${branch}` : undefined,
    ].filter((value): value is string => Boolean(value));
    const title = primaryCheckoutTitle(primaryCheckout);

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `primary-checkout-updated:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "primary-checkout",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      ...(primaryCheckout ? { primaryCheckout } : {}),
    };
  }

  if (eventTypeMatches(eventType, "system/thread_operation")) {
    const payload = toEventRecord(event.data);
    const threadOperation = toThreadOperationIntentMetadata(payload);
    // Keep lifecycle naming aligned with thread-detail-rows collapsing so operation timelines
    // remain familiar and mergeable across projections (requested → queued → running → terminal).
    const title = threadOperationIntentTitle(threadOperation);

    const detailParts = [
      getStringField(payload, "message"),
    ].filter((value): value is string => Boolean(value));

    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `thread-operation:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "thread-operation-intent",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
      ...(threadOperation ? { threadOperation } : {}),
    };
  }

  if (eventTypeMatches(eventType, "system/worktree/commit")) {
    const payload = toEventRecord(event.data);
    const status = getStringField(payload, "status");
    const title = status === "committed" ? "Committed changes" : "No commit created";
    const detailParts = [
      getStringField(payload, "message"),
      getStringField(payload, "commitSha"),
    ].filter((value): value is string => Boolean(value));
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `worktree-commit:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "worktree-commit",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
    };
  }

  if (eventTypeMatches(eventType, "system/worktree/squash_merge")) {
    const payload = toEventRecord(event.data);
    const status = getStringField(payload, "status");
    const title = status === "merged"
      ? "Squash merged"
      : status === "conflict"
        ? "Squash merge has conflicts"
        : "No squash merge performed";
    const detailParts = [
      getStringField(payload, "message"),
      ...((() => {
        const conflictFiles = payload?.conflictFiles;
        if (!Array.isArray(conflictFiles)) return [];
        const normalized = conflictFiles
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(0, 8);
        return normalized.length > 0 ? [`Conflicts: ${normalized.join(", ")}`] : [];
      })()),
    ].filter((value): value is string => Boolean(value));
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `worktree-squash-merge:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "worktree-squash-merge",
      title,
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
    };
  }

  if (eventTypeMatches(eventType, "system/provisioning/fallback")) {
    const payload = toEventRecord(event.data);
    const requestedEnvironmentId = getStringField(payload, "requestedEnvironmentId");
    const fallbackEnvironmentId = getStringField(payload, "fallbackEnvironmentId");
    const reason = getStringField(payload, "reason");
    const requestedEnvironmentLabel = formatEnvironmentDisplayName({
      id: requestedEnvironmentId,
      displayName: requestedEnvironmentId,
    });
    const fallbackEnvironmentLabel = formatEnvironmentDisplayName({
      id: fallbackEnvironmentId,
      displayName: fallbackEnvironmentId,
    });
    const detailParts = [
      requestedEnvironmentLabel && fallbackEnvironmentLabel
        ? `Requested ${requestedEnvironmentLabel}, using ${fallbackEnvironmentLabel}`
        : undefined,
      reason ? `Reason: ${reason}` : undefined,
      getStringField(payload, "detail"),
    ].filter((value): value is string => Boolean(value));
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `provisioning-fallback:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "provisioning-fallback",
      title: "Provisioning fallback",
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
    };
  }

  if (eventTypeMatches(eventType, "system/provisioning/completed")) {
    const payload = toEventRecord(event.data);
    const environmentDisplayName = formatEnvironmentDisplayName({
      id: getStringField(payload, "environmentId"),
      displayName: getStringField(payload, "environmentDisplayName"),
    });
    const detailParts = [
      environmentDisplayName,
      getStringField(payload, "fallbackReason"),
    ].filter((value): value is string => Boolean(value));
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `provisioning-completed:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "provisioning-completed",
      title: "Provisioning ready",
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
    };
  }

  if (eventTypeMatches(eventType, "system/provisioning/cleanup_failed")) {
    const payload = toEventRecord(event.data);
    const environmentDisplayName = formatEnvironmentDisplayName({
      id: getStringField(payload, "environmentId"),
      displayName: getStringField(payload, "environmentDisplayName"),
    });
    const detailParts = [
      environmentDisplayName,
      getStringField(payload, "message"),
      getStringField(payload, "detail"),
    ].filter((value): value is string => Boolean(value));
    return {
      kind: "operation",
      id: messageId(event.threadId, "op", `provisioning-cleanup-failed:${event.seq}`),
      threadId: event.threadId,
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
      turnId: getTurnId(event.data),
      opType: "provisioning-cleanup-failed",
      title: "Provisioning cleanup failed",
      detail: detailParts.length > 0 ? detailParts.join(" • ") : undefined,
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
    eventTypeMatches(eventType, "turn/diff/updated")
  ) {
    const params = toEventRecord(event.data);
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
      detail: getStringField(params, "diff") ?? getStringField(params, "unifiedDiff"),
    };
  }

  return null;
}

function parseErrorMessage(event: ThreadEvent, eventType: string): UIErrorMessage | null {
  if (!eventType.includes("error")) return null;

  const payload = toEventRecord(event.data);
  const error = toRecord(payload?.error);
  const message =
    getStringField(payload, "message") ??
    getStringField(error, "message") ??
    extractText(event.data);
  const detail =
    getStringField(payload, "detail") ??
    getStringField(payload, "hint") ??
    getStringField(error, "detail");
  const formattedMessage =
    detail && detail !== message ? `${message} - ${detail}` : message;

  return {
    kind: "error",
    id: messageId(event.threadId, "error", `${event.seq}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    turnId: getTurnId(event.data),
    rawType: eventType,
    message: formattedMessage || "Error event",
  };
}

function isIgnoredNoiseType(eventType: string): boolean {
  const ignored = [
    "thread/started",
    "account/ratelimits/updated",
    "thread/tokenusage/updated",
    "item/reasoning/summarypartadded",
  ];

  return ignored.some((type) => eventTypeMatches(eventType, type));
}

function isDuplicateEventType(eventType: string): boolean {
  const duplicates = [
    "turn/started",
    "turn/completed",
    "item/commandexecution/outputdelta",
    "item/filechange/outputdelta",
    "turn/diff/updated",
  ];

  return duplicates.some((type) => eventTypeMatches(eventType, type));
}

function isIgnoredItemStartEvent(event: ThreadEvent, eventType: string): boolean {
  if (!eventTypeMatches(eventType, "item/started")) return false;

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
    turnId: getTurnId(event.data),
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
  fileEditsByCallId: Map<string, UIFileEditMessage>;
  toolActivity: ToolActivityState;
}

function createProjectionState(): ProjectionState {
  return {
    messages: [],
    seenUserKeys: new Set(),
    openAssistantByTurn: new Map(),
    openReasoningByTurn: new Map(),
    fileEditsByCallId: new Map(),
    toolActivity: {
      runningCallsById: new Map(),
      activeCell: null,
      historyCells: [],
      finalizedExecCallIds: new Set(),
      finalizedWebSearchCallIds: new Set(),
    },
  };
}

interface RunningExecCall extends UIToolCallSummary {
  threadId: string;
  turnId?: string;
  sourceSeqStart: number;
  sourceSeqEnd: number;
  createdAt: number;
}

interface ToolActivityState {
  runningCallsById: Map<string, RunningExecCall>;
  activeCell: UIToolExploringMessage | UIToolCallMessage | UIWebSearchMessage | null;
  historyCells: Array<UIToolExploringMessage | UIToolCallMessage | UIWebSearchMessage>;
  finalizedExecCallIds: Set<string>;
  finalizedWebSearchCallIds: Set<string>;
}

function getCallStatusRank(
  status: UIToolCallMessage["status"] | undefined,
): number {
  if (!status) return 0;
  if (status === "pending") return 1;
  if (status === "interrupted") return 2;
  if (status === "completed") return 3;
  if (status === "error") return 4;
  return 0;
}

function mergeCallStatus(
  current: UIToolCallMessage["status"] | undefined,
  incoming: UIToolCallMessage["status"] | undefined,
): UIToolCallMessage["status"] | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  return getCallStatusRank(incoming) >= getCallStatusRank(current)
    ? incoming
    : current;
}

function hasSemanticIntent(intents: UIToolParsedIntent[]): boolean {
  return intents.some((intent) => intent.type !== "unknown");
}

function chooseParsedIntents(
  existing: UIToolParsedIntent[],
  incoming: UIToolParsedIntent[],
): UIToolParsedIntent[] {
  if (incoming.length === 0) return existing;
  if (existing.length === 0) return incoming;
  if (!hasSemanticIntent(existing) && hasSemanticIntent(incoming)) {
    return incoming;
  }
  if (incoming.length > existing.length) return incoming;
  return existing;
}

function upsertRunningExecCall(
  existing: RunningExecCall | undefined,
  incoming: ExecCallPartial,
  event: ThreadEvent,
): RunningExecCall {
  if (!existing) {
    return {
      callId: incoming.callId,
      threadId: event.threadId,
      command: incoming.command,
      cwd: incoming.cwd,
      parsedCmd: incoming.parsedCmd,
      source: incoming.source,
      output: incoming.output,
      exitCode: incoming.exitCode,
      duration: incoming.duration,
      status: incoming.status ?? "pending",
      turnId: getTurnId(event.data),
      sourceSeqStart: event.seq,
      sourceSeqEnd: event.seq,
      createdAt: event.createdAt,
    };
  }

  existing.command =
    incoming.command &&
    (!existing.command || incoming.command.length > existing.command.length)
      ? incoming.command
      : existing.command;
  existing.threadId = event.threadId;
  if (incoming.cwd && !existing.cwd) existing.cwd = incoming.cwd;
  existing.parsedCmd = chooseParsedIntents(existing.parsedCmd, incoming.parsedCmd);
  if (incoming.source && !existing.source) existing.source = incoming.source;
  if (incoming.output && incoming.output.length > 0) {
    existing.output =
      !existing.output || incoming.output.length >= existing.output.length
        ? incoming.output
        : existing.output;
  }
  if (incoming.exitCode !== undefined) existing.exitCode = incoming.exitCode;
  if (incoming.duration && !existing.duration) existing.duration = incoming.duration;
  existing.status = mergeCallStatus(existing.status, incoming.status) ?? "pending";
  existing.sourceSeqEnd = Math.max(existing.sourceSeqEnd, event.seq);
  existing.createdAt = Math.max(existing.createdAt, event.createdAt);
  if (!existing.turnId) {
    const turnId = getTurnId(event.data);
    if (turnId) existing.turnId = turnId;
  }

  return existing;
}

function appendExecOutputDelta(
  call: RunningExecCall,
  delta: string | undefined,
): void {
  if (!delta || delta.length === 0) return;
  call.output = `${call.output ?? ""}${delta}`;
}

function isExploringIntent(intent: UIToolParsedIntent): boolean {
  return (
    intent.type === "read" ||
    intent.type === "list_files" ||
    intent.type === "search"
  );
}

function isExploringCall(call: Pick<UIToolCallSummary, "parsedCmd">): boolean {
  if (call.parsedCmd.length === 0) return false;
  return call.parsedCmd.every((intent) => isExploringIntent(intent));
}

function areExploringCallsCompatible(
  a: Pick<RunningExecCall, "turnId" | "source">,
  b: Pick<RunningExecCall, "turnId" | "source">,
): boolean {
  const sameTurn = a.turnId === b.turnId;
  const sameSource = (a.source ?? "agent") === (b.source ?? "agent");
  return sameTurn && sameSource;
}

function syncExploringStatus(cell: UIToolExploringMessage): void {
  cell.status = cell.calls.some((call) => call.status === "pending")
    ? "pending"
    : "completed";
}

function findCallInActiveCell(
  activeCell: ToolActivityState["activeCell"],
  callId: string,
): UIToolCallSummary | UIToolCallMessage | null {
  if (!activeCell) return null;
  if (activeCell.kind === "tool-call" && activeCell.callId === callId) {
    return activeCell;
  }
  if (activeCell.kind !== "tool-exploring") return null;
  return activeCell.calls.find((call) => call.callId === callId) ?? null;
}

function findCallInHistoryCells(
  state: ProjectionState,
  callId: string,
):
  | {
      cell: UIToolExploringMessage | UIToolCallMessage;
      call: UIToolCallSummary | UIToolCallMessage;
    }
  | null {
  for (let index = state.toolActivity.historyCells.length - 1; index >= 0; index -= 1) {
    const cell = state.toolActivity.historyCells[index];
    if (!cell || cell.kind === "web-search") continue;

    const call = findCallInActiveCell(cell, callId);
    if (!call) continue;

    return {
      cell,
      call,
    };
  }

  return null;
}

function mergeCallSummary(
  target: UIToolCallSummary | UIToolCallMessage,
  incoming: ExecCallPartial,
  {
    appendOutput,
  }: {
    appendOutput?: boolean;
  } = {},
): void {
  if (incoming.command && (!target.command || incoming.command.length > target.command.length)) {
    target.command = incoming.command;
  }
  if (incoming.cwd && !target.cwd) target.cwd = incoming.cwd;
  target.parsedCmd = chooseParsedIntents(target.parsedCmd ?? [], incoming.parsedCmd);
  if (incoming.source && !target.source) target.source = incoming.source;
  if (incoming.output && incoming.output.length > 0) {
    if (appendOutput) {
      target.output = `${target.output ?? ""}${incoming.output}`;
    } else if (!target.output || incoming.output.length >= target.output.length) {
      target.output = incoming.output;
    }
  }
  if (incoming.exitCode !== undefined) target.exitCode = incoming.exitCode;
  if (incoming.duration && !target.duration) target.duration = incoming.duration;
  target.status = mergeCallStatus(target.status, incoming.status) ?? target.status;
}

function flushActiveToolCell(state: ProjectionState): void {
  const active = state.toolActivity.activeCell;
  if (!active) return;

  if (active.kind === "tool-exploring") {
    syncExploringStatus(active);
    for (const call of active.calls) {
      if (call.status !== "pending") {
        state.toolActivity.finalizedExecCallIds.add(call.callId);
      }
    }
  } else if (active.kind === "tool-call" && active.status !== "pending") {
    state.toolActivity.finalizedExecCallIds.add(active.callId);
  }

  state.toolActivity.historyCells.push(active);
  state.messages.push(active);
  state.toolActivity.activeCell = null;
}

function flushToolActivityBeforeNonToolMessage(state: ProjectionState): void {
  flushActiveToolCell(state);
}

function createToolCallMessage(
  call: RunningExecCall,
): UIToolCallMessage {
  return {
    kind: "tool-call",
    id: messageId(call.threadId, "tool", call.callId),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    toolName: "exec_command",
    callId: call.callId,
    command: call.command,
    cwd: call.cwd,
    parsedCmd: call.parsedCmd,
    source: call.source,
    output: call.output,
    exitCode: call.exitCode,
    duration: call.duration,
    status: call.status,
  };
}

function createExploringMessage(
  call: RunningExecCall,
): UIToolExploringMessage {
  return {
    kind: "tool-exploring",
    id: messageId(
      call.threadId,
      "tool-exploring",
      `${call.callId}:${call.sourceSeqStart}`,
    ),
    threadId: call.threadId,
    sourceSeqStart: call.sourceSeqStart,
    sourceSeqEnd: call.sourceSeqEnd,
    createdAt: call.createdAt,
    ...(call.turnId ? { turnId: call.turnId } : {}),
    status: call.status === "pending" ? "pending" : "completed",
    calls: [call],
  };
}

function onExecBegin(
  state: ProjectionState,
  event: ThreadEvent,
  incoming: ExecCallPartial,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(incoming.callId);
  const call = upsertRunningExecCall(existingRunning, incoming, event);
  state.toolActivity.runningCallsById.set(call.callId, call);

  const existingInActive = findCallInActiveCell(state.toolActivity.activeCell, call.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, call);
    if (state.toolActivity.activeCell?.kind === "tool-exploring") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        call.sourceSeqEnd,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        call.createdAt,
      );
      syncExploringStatus(state.toolActivity.activeCell);
    }
    return;
  }

  const exploring = isExploringCall(call);
  const active = state.toolActivity.activeCell;

  if (exploring && active?.kind === "tool-exploring") {
    const lastCall = active.calls[active.calls.length - 1];
    if (lastCall && areExploringCallsCompatible(lastCall as RunningExecCall, call)) {
      active.calls.push(call);
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, call.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, call.createdAt);
      syncExploringStatus(active);
      return;
    }
  }

  flushActiveToolCell(state);

  if (exploring) {
    state.toolActivity.activeCell = createExploringMessage(call);
    return;
  }

  state.toolActivity.activeCell = createToolCallMessage(call);
}

function onExecOutput(
  state: ProjectionState,
  event: ThreadEvent,
  incoming: ExecCallPartial,
  appendOutput?: boolean,
): void {
  const existingRunning = state.toolActivity.runningCallsById.get(incoming.callId);
  if (existingRunning) {
    if (appendOutput) {
      appendExecOutputDelta(existingRunning, incoming.output);
    } else {
      mergeCallSummary(existingRunning, incoming, { appendOutput });
    }
    existingRunning.sourceSeqEnd = Math.max(existingRunning.sourceSeqEnd, event.seq);
    existingRunning.createdAt = Math.max(existingRunning.createdAt, event.createdAt);
  }

  const activeCall = findCallInActiveCell(state.toolActivity.activeCell, incoming.callId);
  if (activeCall) {
    mergeCallSummary(activeCall, incoming, { appendOutput });
    if (state.toolActivity.activeCell?.kind === "tool-exploring") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        event.seq,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        event.createdAt,
      );
    } else if (state.toolActivity.activeCell?.kind === "tool-call") {
      state.toolActivity.activeCell.sourceSeqEnd = Math.max(
        state.toolActivity.activeCell.sourceSeqEnd,
        event.seq,
      );
      state.toolActivity.activeCell.createdAt = Math.max(
        state.toolActivity.activeCell.createdAt,
        event.createdAt,
      );
    }
  }

  const historyMatch = findCallInHistoryCells(state, incoming.callId);
  if (!historyMatch) return;

  mergeCallSummary(historyMatch.call, incoming, { appendOutput });
  historyMatch.cell.sourceSeqEnd = Math.max(historyMatch.cell.sourceSeqEnd, event.seq);
  historyMatch.cell.createdAt = Math.max(historyMatch.cell.createdAt, event.createdAt);

  if (historyMatch.cell.kind === "tool-exploring") {
    syncExploringStatus(historyMatch.cell);
  } else if (historyMatch.cell.kind === "tool-call") {
    historyMatch.cell.status =
      mergeCallStatus(historyMatch.cell.status, incoming.status) ??
      historyMatch.cell.status;
  }
}

function onExecEnd(
  state: ProjectionState,
  event: ThreadEvent,
  incoming: ExecCallPartial,
): void {
  const running = state.toolActivity.runningCallsById.get(incoming.callId);
  const merged = upsertRunningExecCall(running, incoming, event);
  state.toolActivity.runningCallsById.delete(incoming.callId);

  const active = state.toolActivity.activeCell;
  const existingInActive = findCallInActiveCell(active, incoming.callId);
  if (existingInActive) {
    mergeCallSummary(existingInActive, merged);
    if (active?.kind === "tool-exploring") {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      syncExploringStatus(active);
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      return;
    }

    if (active?.kind === "tool-call") {
      active.sourceSeqEnd = Math.max(active.sourceSeqEnd, merged.sourceSeqEnd);
      active.createdAt = Math.max(active.createdAt, merged.createdAt);
      active.status = mergeCallStatus(active.status, merged.status) ?? active.status;
      active.output = merged.output ?? active.output;
      active.exitCode = merged.exitCode ?? active.exitCode;
      active.duration = merged.duration ?? active.duration;
      state.toolActivity.finalizedExecCallIds.add(incoming.callId);
      flushActiveToolCell(state);
      return;
    }
  }

  if (state.toolActivity.finalizedExecCallIds.has(incoming.callId)) {
    return;
  }

  const historyMatch = findCallInHistoryCells(state, incoming.callId);
  if (historyMatch) {
    mergeCallSummary(historyMatch.call, merged);
    historyMatch.cell.sourceSeqEnd = Math.max(
      historyMatch.cell.sourceSeqEnd,
      merged.sourceSeqEnd,
    );
    historyMatch.cell.createdAt = Math.max(
      historyMatch.cell.createdAt,
      merged.createdAt,
    );

    if (historyMatch.cell.kind === "tool-exploring") {
      syncExploringStatus(historyMatch.cell);
    } else {
      historyMatch.cell.status =
        mergeCallStatus(historyMatch.cell.status, merged.status) ??
        historyMatch.cell.status;
      historyMatch.cell.output = merged.output ?? historyMatch.cell.output;
      historyMatch.cell.exitCode = merged.exitCode ?? historyMatch.cell.exitCode;
      historyMatch.cell.duration = merged.duration ?? historyMatch.cell.duration;
    }

    state.toolActivity.finalizedExecCallIds.add(incoming.callId);
    return;
  }

  if (isExploringCall(merged)) {
    const exploringMessage = createExploringMessage(merged);
    syncExploringStatus(exploringMessage);
    state.toolActivity.activeCell = exploringMessage;
    flushActiveToolCell(state);
    return;
  }

  const toolCall = createToolCallMessage(merged);
  toolCall.status = mergeCallStatus(toolCall.status, incoming.status) ?? toolCall.status;
  state.toolActivity.activeCell = toolCall;
  flushActiveToolCell(state);
}

function onWebSearchBegin(
  state: ProjectionState,
  event: ThreadEvent,
  payload: WebSearchLifecycleEvent,
): void {
  if (state.toolActivity.finalizedWebSearchCallIds.has(payload.callId)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (active?.kind === "web-search" && active.callId === payload.callId) {
    active.sourceSeqEnd = Math.max(active.sourceSeqEnd, event.seq);
    active.createdAt = Math.max(active.createdAt, event.createdAt);
    if (payload.query) active.query = payload.query;
    if (payload.action) active.action = payload.action;
    return;
  }

  flushActiveToolCell(state);
  const turnId = getTurnId(event.data);
  state.toolActivity.activeCell = {
    kind: "web-search",
    id: messageId(event.threadId, "web-search", payload.callId),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    ...(turnId ? { turnId } : {}),
    callId: payload.callId,
    query: payload.query,
    action: payload.action,
    status: "pending",
  };
}

function onWebSearchEnd(
  state: ProjectionState,
  event: ThreadEvent,
  payload: WebSearchLifecycleEvent,
): void {
  if (state.toolActivity.finalizedWebSearchCallIds.has(payload.callId)) {
    return;
  }

  const active = state.toolActivity.activeCell;
  if (active?.kind === "web-search" && active.callId === payload.callId) {
    active.sourceSeqEnd = Math.max(active.sourceSeqEnd, event.seq);
    active.createdAt = Math.max(active.createdAt, event.createdAt);
    if (payload.query) active.query = payload.query;
    if (payload.action) active.action = payload.action;
    active.status = "completed";
    flushActiveToolCell(state);
    state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
    return;
  }

  flushActiveToolCell(state);

  const turnId = getTurnId(event.data);
  state.messages.push({
    kind: "web-search",
    id: messageId(event.threadId, "web-search", `${payload.callId}:${event.seq}`),
    threadId: event.threadId,
    sourceSeqStart: event.seq,
    sourceSeqEnd: event.seq,
    createdAt: event.createdAt,
    ...(turnId ? { turnId } : {}),
    callId: payload.callId,
    query: payload.query,
    action: payload.action,
    status: "completed",
  });
  state.toolActivity.finalizedWebSearchCallIds.add(payload.callId);
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
  const isActiveThread = options?.threadStatus === "active";
  if (isActiveThread) {
    flushActiveToolCell(state);
    return;
  }

  for (const call of state.toolActivity.runningCallsById.values()) {
    call.status = mergeCallStatus(call.status, "interrupted") ?? "interrupted";
    if (!call.output) {
      call.output = "Tool execution interrupted";
    }

    const activeCall = findCallInActiveCell(state.toolActivity.activeCell, call.callId);
    if (activeCall) {
      mergeCallSummary(activeCall, {
        ...call,
        parsedCmd: call.parsedCmd,
      });
      continue;
    }

    const historyMatch = findCallInHistoryCells(state, call.callId);
    if (historyMatch) {
      mergeCallSummary(historyMatch.call, {
        ...call,
        parsedCmd: call.parsedCmd,
      });
      if (historyMatch.cell.kind === "tool-exploring") {
        syncExploringStatus(historyMatch.cell);
      }
      continue;
    }

    state.messages.push(createToolCallMessage(call));
  }
  state.toolActivity.runningCallsById.clear();

  if (state.toolActivity.activeCell?.kind === "tool-call") {
    if (state.toolActivity.activeCell.status === "pending") {
      state.toolActivity.activeCell.status = "interrupted";
      if (!state.toolActivity.activeCell.output) {
        state.toolActivity.activeCell.output = "Tool execution interrupted";
      }
    }
  } else if (state.toolActivity.activeCell?.kind === "tool-exploring") {
    for (const call of state.toolActivity.activeCell.calls) {
      if (call.status === "pending") {
        call.status = "interrupted";
        if (!call.output) {
          call.output = "Tool execution interrupted";
        }
      }
    }
    syncExploringStatus(state.toolActivity.activeCell);
  } else if (state.toolActivity.activeCell?.kind === "web-search") {
    state.toolActivity.activeCell.status = "completed";
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

  flushActiveToolCell(state);
}

export function toUIMessages(
  events: ThreadEvent[] | undefined,
  options?: ToUIMessagesOptions,
): UIMessage[] {
  if (!events || events.length === 0) return [];

  const state = createProjectionState();
  const includeDebugRawEvents = options?.includeDebugRawEvents ?? false;

  let areEventsOrdered = true;
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1].seq > events[index].seq) {
      areEventsOrdered = false;
      break;
    }
  }
  const orderedEvents = areEventsOrdered ? events : [...events].sort((a, b) => a.seq - b.seq);
  const pendingClientStartUserSignatureCounts = new Map<string, number>();
  const pendingClientThreadStartUserSignatureCounts = new Map<string, number>();

  for (const originalEvent of orderedEvents) {
    const eventType = getEventType(originalEvent);
    const event = originalEvent;

    const eventTurnId = getTurnId(event.data);

    const userFromClientThreadStart = parseUserFromClientStart(
      event,
      eventType,
      options,
    );
    if (userFromClientThreadStart) {
      const signature = userMessageSignature({
        text: userFromClientThreadStart.text,
        webImages: userFromClientThreadStart.attachments?.webImages ?? 0,
        localImages: userFromClientThreadStart.attachments?.localImages ?? 0,
        localFiles: userFromClientThreadStart.attachments?.localFiles ?? 0,
      });
      const startPayload = toEventRecord(event.data);
      const startSource = getStringField(startPayload, "source");
      const isClientThreadStart = eventTypeMatches(eventType, "client/thread/start");
      const isClientTurnStart = eventTypeMatches(eventType, "client/turn/start");
      const pendingThreadStartCount =
        pendingClientThreadStartUserSignatureCounts.get(signature) ?? 0;
      if (isClientTurnStart && startSource === "spawn" && pendingThreadStartCount > 0) {
        continue;
      }

      const key = `${userFromClientThreadStart.id}:${userFromClientThreadStart.text}`;
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        pendingClientStartUserSignatureCounts.set(
          signature,
          (pendingClientStartUserSignatureCounts.get(signature) ?? 0) + 1,
        );
        if (isClientThreadStart) {
          pendingClientThreadStartUserSignatureCounts.set(
            signature,
            pendingThreadStartCount + 1,
          );
        }
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(userFromClientThreadStart);
      }
      continue;
    }

    const userMessage = parseUserFromItemEvent(event, eventType);
    if (userMessage) {
      const signature = userMessageSignature({
        text: userMessage.text,
        webImages: userMessage.attachments?.webImages ?? 0,
        localImages: userMessage.attachments?.localImages ?? 0,
        localFiles: userMessage.attachments?.localFiles ?? 0,
      });
      const pendingClientStartCount =
        pendingClientStartUserSignatureCounts.get(signature) ?? 0;
      if (pendingClientStartCount > 0) {
        if (pendingClientStartCount === 1) {
          pendingClientStartUserSignatureCounts.delete(signature);
        } else {
          pendingClientStartUserSignatureCounts.set(
            signature,
            pendingClientStartCount - 1,
          );
        }
        const pendingThreadStartCount =
          pendingClientThreadStartUserSignatureCounts.get(signature) ?? 0;
        if (pendingThreadStartCount === 1) {
          pendingClientThreadStartUserSignatureCounts.delete(signature);
        } else if (pendingThreadStartCount > 1) {
          pendingClientThreadStartUserSignatureCounts.set(
            signature,
            pendingThreadStartCount - 1,
          );
        }
        const dedupeKey = `${userMessage.turnId ?? userMessage.id}:${userMessage.text}`;
        state.seenUserKeys.add(dedupeKey);
        continue;
      }
      const key = `${userMessage.turnId ?? userMessage.id}:${userMessage.text}`;
      if (!state.seenUserKeys.has(key)) {
        state.seenUserKeys.add(key);
        flushToolActivityBeforeNonToolMessage(state);
        state.messages.push(userMessage);
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
        flushToolActivityBeforeNonToolMessage(state);
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
        flushToolActivityBeforeNonToolMessage(state);
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
        flushToolActivityBeforeNonToolMessage(state);
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
        flushToolActivityBeforeNonToolMessage(state);
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

    const execEvent = parseExecLifecycleEvent(event, eventType);
    if (execEvent) {
      if (execEvent.kind === "begin") {
        onExecBegin(state, event, execEvent.call);
      } else if (execEvent.kind === "output") {
        onExecOutput(state, event, execEvent.call, execEvent.appendOutput);
      } else {
        onExecEnd(state, event, execEvent.call);
      }
      continue;
    }

    const webSearchEvent = parseWebSearchLifecycleEvent(event, eventType);
    if (webSearchEvent) {
      if (webSearchEvent.kind === "begin") {
        onWebSearchBegin(state, event, webSearchEvent);
      } else {
        onWebSearchEnd(state, event, webSearchEvent);
      }
      continue;
    }

    const fileEdit = parseFileEditFromItemEvent(event, eventType);
    if (fileEdit) {
      flushToolActivityBeforeNonToolMessage(state);
      upsertFileEdit(state, event, fileEdit);
      continue;
    }

    const operation = parseOperationMessage(event, eventType, {
      includeOptionalOperations: options?.includeOptionalOperations,
    });
    if (operation) {
      flushToolActivityBeforeNonToolMessage(state);
      state.messages.push(operation);
      continue;
    }

    const error = parseErrorMessage(event, eventType);
    if (error) {
      flushToolActivityBeforeNonToolMessage(state);
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

      flushToolActivityBeforeNonToolMessage(state);
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
