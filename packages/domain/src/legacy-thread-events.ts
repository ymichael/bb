import type { ThreadEventItemPresentation } from "./item-presentation.js";
import type { ThreadEventType } from "./provider-event.js";

export const LEGACY_CODEX_GOAL_EXTENSION_KIND = "provider-codex/goal";

export const LEGACY_THREAD_EVENT_TYPES = [
  "thread/goal/updated",
  "thread/goal/cleared",
  "turn/plan/updated",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
] as const satisfies readonly ThreadEventType[];

export type LegacyThreadEventType = (typeof LEGACY_THREAD_EVENT_TYPES)[number];

const legacyThreadEventTypeSet: ReadonlySet<string> = new Set(
  LEGACY_THREAD_EVENT_TYPES,
);

export function isLegacyThreadEventType(
  type: string,
): type is LegacyThreadEventType {
  return legacyThreadEventTypeSet.has(type);
}

export interface StoredThreadEventShape {
  type: ThreadEventType;
  data: Record<string, unknown>;
}

function legacyItemId(
  prefix: string,
  turnId: string | null,
  payload: unknown,
): string {
  const text = JSON.stringify(payload);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return `${prefix}:${turnId ?? "thread"}:${(hash >>> 0).toString(36)}`;
}

export interface StoredThreadEventConversionScope {
  turnId: string | null;
}

const GOAL_FIELDS = [
  "objective",
  "status",
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
] as const;

export function convertLegacyStoredThreadEvent(
  stored: StoredThreadEventShape,
  scope: StoredThreadEventConversionScope = { turnId: null },
): StoredThreadEventShape {
  switch (stored.type) {
    case "item/started":
    case "item/completed": {
      const upgraded = upgradeLegacyToolItem(stored.data.item);
      return upgraded === stored.data.item
        ? stored
        : { type: stored.type, data: { ...stored.data, item: upgraded } };
    }
    case "turn/plan/updated": {
      const { plan, explanation, ...rest } = stored.data;
      const steps = Array.isArray(plan) ? plan : [];
      return {
        type: "item/completed",
        data: {
          ...rest,
          item: {
            type: "planSteps",
            id: legacyItemId("legacy-plan", scope.turnId, {
              steps,
              explanation,
            }),
            steps,
            ...(typeof explanation === "string" ? { explanation } : {}),
            status: "completed",
          },
        },
      };
    }
    case "thread/goal/updated": {
      const payload: Record<string, unknown> = {};
      for (const field of GOAL_FIELDS) {
        payload[field] = stored.data[field];
      }
      return {
        type: "thread/extensionState/updated",
        data: {
          ...withoutGoalFields(stored.data),
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          payload,
        },
      };
    }
    case "thread/goal/cleared":
      return {
        type: "thread/extensionState/updated",
        data: {
          ...stored.data,
          kind: LEGACY_CODEX_GOAL_EXTENSION_KIND,
          payload: null,
        },
      };
    case "system/permissionGrant/lifecycle": {
      const { subject, ...rest } = stored.data;
      return {
        type: "system/interaction/lifecycle",
        data: {
          interaction: legacyInteractionLifecycleRecord(rest, {
            kind: "approval",
            subject,
            reason: null,
          }),
        },
      };
    }
    case "system/userQuestion/lifecycle": {
      const { payload, ...rest } = stored.data;
      return {
        type: "system/interaction/lifecycle",
        data: { interaction: legacyInteractionLifecycleRecord(rest, payload) },
      };
    }
    default:
      return stored;
  }
}

function legacyInteractionLifecycleRecord(
  data: Record<string, unknown>,
  payload: unknown,
): Record<string, unknown> {
  return {
    id: data.interactionId,
    status: data.status,
    statusReason: data.statusReason ?? null,
    origin: {
      kind: "provider",
      providerId: data.providerId,
      providerRequestId: data.providerRequestId,
    },
    payload,
    resolution: data.resolution ?? null,
  };
}

function withoutGoalFields(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(GOAL_FIELDS as readonly string[]).includes(key)) {
      rest[key] = value;
    }
  }
  return rest;
}

export const LEGACY_TOOL_ITEM_BACKFILL_MIGRATION = "legacy-tool-item-backfill";

const LEGACY_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "read"]);
const LEGACY_CONTENT_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Grep",
  "grep",
]);
const LEGACY_PATH_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Glob",
  "glob",
  "find",
]);
const LEGACY_LIST_TOOL_NAMES: ReadonlySet<string> = new Set(["ls"]);
const LEGACY_SUPPRESSED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TodoRead",
  "TodoWrite",
  "ToolSearch",
  "AskUserQuestion",
]);
const LEGACY_AGENT_RESULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
]);
const LEGACY_DELEGATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "Task",
  "spawnAgent",
  "resumeAgent",
]);

function legacyBaseToolName(tool: string): string {
  const segments = tool.split(":");
  return segments[segments.length - 1] ?? tool;
}

function firstStringField(
  args: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function legacyToolCallCommand(
  tool: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return tool;
  const entries = Object.entries(args).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return tool;
  const compact = entries
    .map(([k, v]) => {
      const vs = typeof v === "string" ? v.trim() : JSON.stringify(v);
      const display = vs.length > 40 ? `${vs.slice(0, 37)}...` : vs;
      return `${k}: ${display}`;
    })
    .join(", ");
  return `${tool} { ${compact} }`;
}

function stripLegacyAgentResultMetadata(result: string): string {
  return result
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(
      (line) => !line.startsWith("agentId:") && !line.startsWith("<usage>"),
    )
    .join("\n")
    .trim();
}

interface LegacyToolItem {
  type: "toolCall";
  id: string;
  tool: string;
  arguments?: Record<string, unknown>;
  status: "pending" | "completed" | "failed" | "interrupted";
  result?: unknown;
  parentToolCallId?: string;
  [key: string]: unknown;
}

function isLegacyToolItem(item: unknown): item is LegacyToolItem {
  if (item === null || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return (
    record.type === "toolCall" &&
    typeof record.id === "string" &&
    typeof record.tool === "string" &&
    typeof record.status === "string" &&
    record.presentation === undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sharedLegacyItemFields(item: LegacyToolItem): Record<string, unknown> {
  return {
    id: item.id,
    status: item.status,
    ...(item.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: item.parentToolCallId }),
  };
}

export function isLegacyDelegationToolCall(call: {
  tool: string;
  presentation?: ThreadEventItemPresentation | undefined;
}): boolean {
  return (
    call.presentation === undefined &&
    LEGACY_DELEGATION_TOOL_NAMES.has(legacyBaseToolName(call.tool))
  );
}

export function upgradeLegacyToolItem(item: unknown): unknown {
  if (!isLegacyToolItem(item)) return item;
  const tool = legacyBaseToolName(item.tool);
  const args = isRecord(item.arguments) ? item.arguments : undefined;

  if (LEGACY_READ_TOOL_NAMES.has(tool)) {
    const path = firstStringField(args, ["file_path", "file", "path"]);
    if (path === undefined) return item;
    return {
      type: "fileRead",
      ...sharedLegacyItemFields(item),
      path,
      cmd: legacyToolCallCommand(item.tool, args),
    };
  }
  if (LEGACY_CONTENT_SEARCH_TOOL_NAMES.has(tool)) {
    const query = firstStringField(args, ["pattern", "query"]);
    if (query === undefined) return item;
    const path = firstStringField(args, ["path"]);
    return {
      type: "search",
      ...sharedLegacyItemFields(item),
      mode: "content",
      query,
      ...(path === undefined ? {} : { path }),
      cmd: legacyToolCallCommand(item.tool, args),
    };
  }
  if (LEGACY_PATH_SEARCH_TOOL_NAMES.has(tool)) {
    const query = firstStringField(args, ["pattern"]);
    const path = firstStringField(args, ["path"]);
    if (query === undefined && path === undefined) return item;
    return {
      type: "search",
      ...sharedLegacyItemFields(item),
      mode: "path",
      query: query ?? "",
      ...(path === undefined ? {} : { path }),
      cmd: legacyToolCallCommand(item.tool, args),
    };
  }
  if (LEGACY_LIST_TOOL_NAMES.has(tool)) {
    const path = firstStringField(args, ["path"]);
    if (path === undefined) return item;
    return {
      type: "search",
      ...sharedLegacyItemFields(item),
      mode: "list",
      query: "",
      path,
      cmd: legacyToolCallCommand(item.tool, args),
    };
  }
  if (LEGACY_SUPPRESSED_TOOL_NAMES.has(tool)) {
    if (item.status !== "pending" && item.status !== "completed") return item;
    const presentation: ThreadEventItemPresentation = {
      label: { pending: `Running ${tool}`, completed: `Ran ${tool}` },
      icon: { glyph: "Toolbox" },
      suppress: true,
    };
    return { ...item, presentation };
  }
  if (
    LEGACY_AGENT_RESULT_TOOL_NAMES.has(tool) &&
    typeof item.result === "string"
  ) {
    const stripped = stripLegacyAgentResultMetadata(item.result);
    return stripped === item.result ? item : { ...item, result: stripped };
  }
  return item;
}
