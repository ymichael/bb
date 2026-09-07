import { z } from "zod";
import {
  threadEventTypeSchema,
  threadEventTypeValues,
  type ThreadEventType,
} from "./provider-event.js";
import {
  threadActivityStateSchema,
  threadRuntimeStateSchema,
  threadStatusSchema,
} from "./thread.js";

export const THREAD_CHANGE_KINDS = [
  "thread-created",
  "thread-deleted",
  "events-appended",
  "history-rewritten",
  "interactions-changed",
  "status-changed",
  "title-changed",
  "queue-changed",
  "archived-changed",
  "pin-state-changed",
  "parent-changed",
  "environment-changed",
  "read-state-changed",
  "order-changed",
  "tabs-changed",
  "terminals-changed",
] as const;
export type ThreadChangeKind = (typeof THREAD_CHANGE_KINDS)[number];

export const PROJECT_CHANGE_KINDS = [
  "project-created",
  "project-updated",
  "project-deleted",
  "project-sources-changed",
  "threads-changed",
  "project-order-changed",
] as const;
export type ProjectChangeKind = (typeof PROJECT_CHANGE_KINDS)[number];

export const ENVIRONMENT_CHANGE_KINDS = [
  "environment-created",
  "environment-deleted",
  "metadata-changed",
  "status-changed",
  "work-status-changed",
  "git-refs-changed",
  "thread-storage-changed",
] as const;
export type EnvironmentChangeKind = (typeof ENVIRONMENT_CHANGE_KINDS)[number];

export const HOST_CHANGE_KINDS = [
  "host-connected",
  "host-disconnected",
] as const;
export type HostChangeKind = (typeof HOST_CHANGE_KINDS)[number];

export const SYSTEM_CHANGE_KINDS = [
  "config-changed",
  "plugins-changed",
  "provider-registrations-changed",
] as const;
export type SystemChangeKind = (typeof SYSTEM_CHANGE_KINDS)[number];

export const threadChangeKindSchema = z.enum(THREAD_CHANGE_KINDS);
export const projectChangeKindSchema = z.enum(PROJECT_CHANGE_KINDS);
export const environmentChangeKindSchema = z.enum(ENVIRONMENT_CHANGE_KINDS);
export const hostChangeKindSchema = z.enum(HOST_CHANGE_KINDS);
export const systemChangeKindSchema = z.enum(SYSTEM_CHANGE_KINDS);

export const realtimeSubscriptionTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread-detail"),
      threadId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread-list"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project-detail"),
      projectId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project-list"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment-detail"),
      environmentId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("environment-list"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("host-detail"),
      hostId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("host-list"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
    })
    .strict(),
]);
export type RealtimeSubscriptionTarget = z.infer<
  typeof realtimeSubscriptionTargetSchema
>;

const subscribeMessageSchema = z.object({
  type: z.literal("subscribe"),
  target: realtimeSubscriptionTargetSchema,
});
export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>;

const unsubscribeMessageSchema = z.object({
  type: z.literal("unsubscribe"),
  target: realtimeSubscriptionTargetSchema,
});
export type UnsubscribeMessage = z.infer<typeof unsubscribeMessageSchema>;

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
});
export type PingMessage = z.infer<typeof pingMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  subscribeMessageSchema,
  unsubscribeMessageSchema,
  pingMessageSchema,
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const pongMessageSchema = z
  .object({
    type: z.literal("pong"),
  })
  .strict();
export type PongMessage = z.infer<typeof pongMessageSchema>;

export const pongMessageLenientSchema = z.object({
  type: z.literal("pong"),
});

function assertUnhandledRealtimeSubscriptionTarget(target: never): never {
  throw new Error(`Unhandled realtime subscription target: ${target}`);
}

export function realtimeSubscriptionTargetKey(
  target: RealtimeSubscriptionTarget,
): string {
  switch (target.kind) {
    case "thread-detail":
      return `thread-detail:${target.threadId}`;
    case "thread-list":
      return "thread-list";
    case "project-detail":
      return `project-detail:${target.projectId}`;
    case "project-list":
      return "project-list";
    case "environment-detail":
      return `environment-detail:${target.environmentId}`;
    case "environment-list":
      return "environment-list";
    case "host-detail":
      return `host-detail:${target.hostId}`;
    case "host-list":
      return "host-list";
    case "system":
      return "system";
    default:
      return assertUnhandledRealtimeSubscriptionTarget(target);
  }
}

export const threadStatusChangeMetadataSchema = z
  .object({
    status: threadStatusSchema,
    runtime: threadRuntimeStateSchema,
    activity: threadActivityStateSchema,
    latestAttentionAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type ThreadStatusChangeMetadata = z.infer<
  typeof threadStatusChangeMetadataSchema
>;

export const threadChangeMetadataSchema = z
  .object({
    backgroundActivityChanged: z.boolean().optional(),
    eventTypes: z.array(threadEventTypeSchema).readonly().optional(),
    hasPendingInteraction: z.boolean().optional(),
    projectId: z.string().optional(),
    statusChange: threadStatusChangeMetadataSchema.optional(),
  })
  .strict();
export type ThreadChangeMetadata = z.infer<typeof threadChangeMetadataSchema>;

export const threadChangedMessageSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("thread"),
    id: z.string().optional(),
    metadata: threadChangeMetadataSchema.optional(),
    changes: z.array(threadChangeKindSchema).readonly(),
  })
  .strict();
export type ThreadChangedMessage = z.infer<typeof threadChangedMessageSchema>;

export const projectChangedMessageSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("project"),
    id: z.string().optional(),
    changes: z.array(projectChangeKindSchema).readonly(),
  })
  .strict();
export type ProjectChangedMessage = z.infer<typeof projectChangedMessageSchema>;

export const environmentChangedMessageSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("environment"),
    id: z.string().optional(),
    changes: z.array(environmentChangeKindSchema).readonly(),
  })
  .strict();
export type EnvironmentChangedMessage = z.infer<
  typeof environmentChangedMessageSchema
>;

export const hostChangedMessageSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("host"),
    id: z.string().optional(),
    changes: z.array(hostChangeKindSchema).readonly(),
  })
  .strict();
export type HostChangedMessage = z.infer<typeof hostChangedMessageSchema>;

export const systemChangedMessageSchema = z
  .object({
    type: z.literal("changed"),
    entity: z.literal("system"),
    changes: z.array(systemChangeKindSchema).readonly(),
  })
  .strict();
export type SystemChangedMessage = z.infer<typeof systemChangedMessageSchema>;

export const changedMessageSchema = z.discriminatedUnion("entity", [
  threadChangedMessageSchema,
  projectChangedMessageSchema,
  environmentChangedMessageSchema,
  hostChangedMessageSchema,
  systemChangedMessageSchema,
]);
export type ChangedMessage = z.infer<typeof changedMessageSchema>;

function lenientKinds<TKind extends string>(kinds: readonly TKind[]) {
  const known: ReadonlySet<string> = new Set(kinds);
  return z
    .array(z.string())
    .transform((values) =>
      values.filter((value): value is TKind => known.has(value)),
    );
}

const knownThreadEventTypes: ReadonlySet<string> = new Set(
  threadEventTypeValues,
);

const threadChangeMetadataLenientSchema = z.object({
  backgroundActivityChanged: z.boolean().optional(),
  eventTypes: z
    .array(z.string())
    .transform((values) =>
      values.filter((value): value is ThreadEventType =>
        knownThreadEventTypes.has(value),
      ),
    )
    .optional(),
  hasPendingInteraction: z.boolean().optional(),
  projectId: z.string().optional(),
  statusChange: threadStatusChangeMetadataSchema.optional().catch(undefined),
});

const threadChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("thread"),
  id: z.string().optional(),
  metadata: threadChangeMetadataLenientSchema.optional(),
  changes: lenientKinds(THREAD_CHANGE_KINDS),
});

const projectChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("project"),
  id: z.string().optional(),
  changes: lenientKinds(PROJECT_CHANGE_KINDS),
});

const environmentChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("environment"),
  id: z.string().optional(),
  changes: lenientKinds(ENVIRONMENT_CHANGE_KINDS),
});

const hostChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("host"),
  id: z.string().optional(),
  changes: lenientKinds(HOST_CHANGE_KINDS),
});

const systemChangedMessageLenientSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("system"),
  changes: lenientKinds(SYSTEM_CHANGE_KINDS),
});

export const changedMessageLenientSchema = z.discriminatedUnion("entity", [
  threadChangedMessageLenientSchema,
  projectChangedMessageLenientSchema,
  environmentChangedMessageLenientSchema,
  hostChangedMessageLenientSchema,
  systemChangedMessageLenientSchema,
]);
