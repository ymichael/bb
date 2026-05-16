import { z } from "zod";
import type { ThreadEventType } from "./provider-event.js";

export const threadEventScopeKindValues = ["thread", "turn"] as const;
export const threadEventScopeKindSchema = z.enum(threadEventScopeKindValues);
export type ThreadEventScopeKind = z.infer<typeof threadEventScopeKindSchema>;

export const threadEventScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }),
]);
export type ThreadEventScope = z.infer<typeof threadEventScopeSchema>;

export const threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn",
] as const;
export const threadEventScopePolicySchema = z.enum(
  threadEventScopePolicyValues,
);
export type ThreadEventScopePolicy = z.infer<
  typeof threadEventScopePolicySchema
>;

export interface ValidateThreadEventScopeArgs {
  scope: ThreadEventScope;
  type: ThreadEventType;
}

export interface ValidateThreadEventScopeResult {
  message?: string;
  valid: boolean;
}

export interface RequireThreadEventScopeTurnIdArgs {
  scope: ThreadEventScope;
  type: ThreadEventType;
}

interface TurnOnlyThreadEventScopePolicyDefinition {
  policy: "turn";
  rationale?: string;
}

interface ThreadScopedThreadEventScopePolicyDefinition {
  policy: "thread" | "thread-or-turn";
  rationale: string;
}

type ThreadEventScopePolicyDefinition =
  | TurnOnlyThreadEventScopePolicyDefinition
  | ThreadScopedThreadEventScopePolicyDefinition;

type ThreadEventScopePolicyDefinitionByType = Record<
  ThreadEventType,
  ThreadEventScopePolicyDefinition
>;

type ThreadEventScopePolicyByType = Record<
  ThreadEventType,
  ThreadEventScopePolicy
>;

type ThreadScopeRationaleByType = Partial<Record<ThreadEventType, string>>;

interface ThreadEventScopePolicyDefinitionEntry {
  definition: ThreadEventScopePolicyDefinition;
  type: ThreadEventType;
}

export const threadEventScopeDefinitionByType = {
  "thread/started": {
    policy: "thread",
    rationale: "Thread lifecycle event; it creates the thread timeline itself.",
  },
  "thread/identity": {
    policy: "thread",
    rationale:
      "Thread metadata event; it identifies the provider thread outside turn chronology.",
  },
  "turn/started": { policy: "turn" },
  "turn/completed": { policy: "turn" },
  "turn/input/accepted": { policy: "turn" },
  "thread/name/updated": {
    policy: "thread",
    rationale:
      "Thread metadata event; names are not part of a specific turn transcript.",
  },
  "thread/compacted": { policy: "turn" },
  "item/started": { policy: "turn" },
  "item/completed": { policy: "turn" },
  "item/agentMessage/delta": { policy: "turn" },
  "item/commandExecution/outputDelta": { policy: "turn" },
  "item/fileChange/outputDelta": { policy: "turn" },
  "item/reasoning/summaryTextDelta": { policy: "turn" },
  "item/reasoning/textDelta": { policy: "turn" },
  "item/plan/delta": { policy: "turn" },
  "item/mcpToolCall/progress": { policy: "turn" },
  "item/toolCall/progress": { policy: "turn" },
  "thread/tokenUsage/updated": { policy: "turn" },
  "thread/contextWindowUsage/updated": { policy: "turn" },
  "turn/plan/updated": { policy: "turn" },
  "turn/diff/updated": { policy: "turn" },
  "provider/error": {
    policy: "thread-or-turn",
    rationale:
      "Provider diagnostics use thread scope for provider setup/session failures; in-turn failures use turn scope.",
  },
  "provider/warning": {
    policy: "thread-or-turn",
    rationale:
      "Provider warnings use thread scope for config, deprecation, or global notices; turn-specific warnings use turn scope.",
  },
  "provider/unhandled": {
    policy: "thread-or-turn",
    rationale:
      "Unhandled provider events use thread scope only when no active turn context exists; in-turn unknown events use turn scope.",
  },
  "client/thread/start": {
    policy: "thread",
    rationale:
      "Outbound client lifecycle event; it requests thread creation before any turn exists.",
  },
  "client/turn/requested": {
    policy: "thread",
    rationale:
      "Outbound client lifecycle event; it records the request before provider turn acceptance.",
  },
  "client/turn/start": {
    policy: "thread",
    rationale:
      "Outbound client lifecycle event; it records the start request before provider turn acceptance.",
  },
  "system/error": {
    policy: "thread-or-turn",
    rationale:
      "System errors use thread scope for app, daemon, or session failures outside a turn; turn failures use turn scope.",
  },
  "system/manager/user_message": {
    policy: "thread-or-turn",
    rationale:
      "Manager messages can be thread-scoped for general manager updates or turn-scoped for in-turn updates.",
  },
  "system/thread/interrupted": {
    policy: "thread",
    rationale:
      "Thread stop lifecycle event; it represents interruption of the whole running thread by a bb lifecycle request or host/runtime recovery.",
  },
  "system/operation": {
    policy: "thread",
    rationale:
      "Thread-management operation event; ownership and lifecycle operations are not turn transcript content.",
  },
  "system/permissionGrant/lifecycle": { policy: "turn" },
  "system/thread-provisioning": {
    policy: "thread",
    rationale:
      "Workspace provisioning lifecycle event; environment setup belongs to the thread, not a turn.",
  },
} as const satisfies ThreadEventScopePolicyDefinitionByType;

function getThreadEventScopePolicyDefinitionEntries(): ThreadEventScopePolicyDefinitionEntry[] {
  return Object.entries(threadEventScopeDefinitionByType).map(
    ([type, definition]) => ({
      type: type as ThreadEventType,
      definition,
    }),
  );
}

function getThreadEventTypesForScopePolicy(
  policy: ThreadEventScopePolicy,
): ThreadEventType[] {
  return getThreadEventScopePolicyDefinitionEntries()
    .filter((entry) => entry.definition.policy === policy)
    .map((entry) => entry.type);
}

function buildThreadEventScopePolicyByType(): ThreadEventScopePolicyByType {
  const policies: Partial<ThreadEventScopePolicyByType> = {};
  for (const entry of getThreadEventScopePolicyDefinitionEntries()) {
    policies[entry.type] = entry.definition.policy;
  }
  return policies as ThreadEventScopePolicyByType;
}

function buildThreadScopeRationaleByType(): ThreadScopeRationaleByType {
  const rationales: ThreadScopeRationaleByType = {};
  for (const entry of getThreadEventScopePolicyDefinitionEntries()) {
    if (entry.definition.rationale) {
      rationales[entry.type] = entry.definition.rationale;
    }
  }
  return rationales;
}

export const turnOnlyThreadEventTypes =
  getThreadEventTypesForScopePolicy("turn");
export const threadOnlyThreadEventTypes =
  getThreadEventTypesForScopePolicy("thread");
export const threadOrTurnThreadEventTypes =
  getThreadEventTypesForScopePolicy("thread-or-turn");
export const threadEventScopePolicyByType = buildThreadEventScopePolicyByType();
export const threadScopeRationaleByType = buildThreadScopeRationaleByType();

export function threadScope(): ThreadEventScope {
  return { kind: "thread" };
}

export function turnScope(turnId: string): ThreadEventScope {
  return { kind: "turn", turnId };
}

export function getThreadEventScopeTurnId(
  scope: ThreadEventScope,
): string | undefined {
  return scope.kind === "turn" ? scope.turnId : undefined;
}

export function requireThreadEventScopeTurnId(
  args: RequireThreadEventScopeTurnIdArgs,
): string {
  if (args.scope.kind !== "turn") {
    throw new Error(
      `${args.type} requires turn scope but received ${args.scope.kind} scope`,
    );
  }
  return args.scope.turnId;
}

export function validateThreadEventScope(
  args: ValidateThreadEventScopeArgs,
): ValidateThreadEventScopeResult {
  const policy = threadEventScopePolicyByType[args.type];

  if (policy === "thread-or-turn") {
    return { valid: true };
  }

  if (policy !== args.scope.kind) {
    return {
      valid: false,
      message: `${args.type} requires ${policy} scope but received ${args.scope.kind} scope`,
    };
  }

  return { valid: true };
}

export function assertThreadEventScope(
  args: ValidateThreadEventScopeArgs,
): void {
  const result = validateThreadEventScope(args);
  if (!result.valid) {
    throw new Error(result.message ?? "Invalid thread event scope");
  }
}
