import { z } from "zod";
import type { ThreadEventType } from "./provider-event.js";

const threadEventScopeKindValues = ["thread", "turn"] as const;
const threadEventScopeKindSchema = z.enum(threadEventScopeKindValues);
export type ThreadEventScopeKind = z.infer<typeof threadEventScopeKindSchema>;

export const threadEventScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread") }),
  z.object({ kind: z.literal("turn"), turnId: z.string().min(1) }),
]);
export type ThreadEventScope = z.infer<typeof threadEventScopeSchema>;

const threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn",
] as const;
const threadEventScopePolicySchema = z.enum(threadEventScopePolicyValues);
type ThreadEventScopePolicy = z.infer<typeof threadEventScopePolicySchema>;

interface ValidateThreadEventScopeArgs {
  scope: ThreadEventScope;
  type: ThreadEventType;
}

interface ValidateThreadEventScopeResult {
  message?: string;
  valid: boolean;
}

interface RequireThreadEventScopeTurnIdArgs {
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

const threadEventScopeDefinitionByType = {
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
  "thread/context/cleared": { policy: "turn" },
  "thread/goal/updated": {
    policy: "thread",
    rationale:
      "Thread goal state is current thread metadata, not part of a specific turn transcript.",
  },
  "thread/goal/cleared": {
    policy: "thread",
    rationale:
      "Thread goal state is current thread metadata, not part of a specific turn transcript.",
  },
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
  "item/backgroundTask/progress": {
    policy: "thread",
    rationale:
      "Background tasks outlive their spawning turn; thread scope keeps turn windows sequence-contiguous (late progress must not interleave into later turns' ranges).",
  },
  "item/backgroundTask/completed": {
    policy: "thread",
    rationale:
      "Terminal task state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range.",
  },
  "item/delegation/progress": {
    policy: "thread",
    rationale:
      "Background delegations outlive their spawning turn exactly like background tasks; thread scope keeps turn windows sequence-contiguous.",
  },
  "item/delegation/completed": {
    policy: "thread",
    rationale:
      "A background delegation's terminal state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range.",
  },
  "thread/tokenUsage/updated": { policy: "turn" },
  "thread/contextWindowUsage/updated": {
    policy: "thread-or-turn",
    rationale:
      "Context usage is session state; providers can report it before, during, or after a turn.",
  },
  "turn/plan/updated": { policy: "turn" },
  "turn/diff/updated": { policy: "turn" },
  "provider/error": {
    policy: "thread-or-turn",
    rationale:
      "Provider diagnostics use thread scope for provider setup/session failures; in-turn failures use turn scope.",
  },
  "provider/rateLimits/updated": {
    policy: "thread",
    rationale:
      "Subscription usage is account-scoped state that can affect multiple turns and threads.",
  },
  "provider.env-resolved": {
    policy: "thread",
    rationale:
      "Resolved provider environment is session state and can change between turns.",
  },
  "thread/extensionState/updated": {
    policy: "thread",
    rationale:
      "Plugin-declared thread state is current thread metadata (like goals), not part of a specific turn transcript; latest snapshot per kind wins.",
  },
  "provider/warning": {
    policy: "thread-or-turn",
    rationale:
      "Provider warnings use thread scope for config, deprecation, or global notices; turn-specific warnings use turn scope.",
  },
  "provider/modelFallback": {
    policy: "thread-or-turn",
    rationale:
      "Provider model fallback signals can occur while a turn is active or at session scope before a turn is established.",
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
  "client/turn/rejected": {
    policy: "thread",
    rationale:
      "Client request rejection occurs before provider turn acceptance and identifies the request at thread scope.",
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
      "Legacy persisted user-visible system messages may be thread-scoped for general updates or turn-scoped for in-turn updates.",
  },
  "system/thread/interrupted": {
    policy: "thread",
    rationale:
      "Thread stop lifecycle event; it represents user interruption of the whole running thread.",
  },
  "system/operation": {
    policy: "thread-or-turn",
    rationale:
      "Thread-management operations use thread scope outside provider turns; tool-owned operations use turn scope so the operation stays with the tool call that caused it.",
  },
  "system/interaction/lifecycle": {
    policy: "thread-or-turn",
    rationale:
      "A provider interaction belongs to the turn that raised it; a plugin may raise one outside any turn.",
  },
  "system/permissionGrant/lifecycle": { policy: "turn" },
  "system/userQuestion/lifecycle": { policy: "turn" },
  "system/thread-provisioning": {
    policy: "thread",
    rationale:
      "Workspace provisioning lifecycle event; environment setup belongs to the thread, not a turn.",
  },
  "system/provider-turn-watchdog": {
    policy: "thread",
    rationale:
      "Legacy persisted watchdog diagnostics are decoded for old timelines only; there is no current producer.",
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
const threadEventScopePolicyByType = buildThreadEventScopePolicyByType();
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
