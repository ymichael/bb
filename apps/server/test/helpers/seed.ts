import {
  createEnvironment,
  createDraft,
  deriveStoredEventItemFields,
  insertEvents,
  createProject,
  createThread,
  openSession,
  upsertHost,
} from "@bb/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import {
  parseStoredThreadEvent,
} from "@bb/domain";
import type {
  EnvironmentStatus,
  PromptInput,
  StoredThreadEventDataForType,
  ThreadEventItemType,
  ThreadEventType,
} from "@bb/domain";
import type { AppDeps } from "../../src/types.js";

export interface SeedEventArgs<TType extends ThreadEventType> {
  data: StoredThreadEventDataForType<TType>;
  environmentId?: string | null;
  providerThreadId?: string | null;
  sequence: number;
  threadId: string;
  turnId?: string | null;
  type: TType;
}

export interface SeedStoredEventArgs {
  data: Record<string, unknown>;
  environmentId?: string | null;
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  providerThreadId?: string | null;
  sequence: number;
  threadId: string;
  turnId?: string | null;
  type: ThreadEventType;
}

export function seedHost(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { id?: string; name?: string; type?: "persistent" | "ephemeral" } = {},
) {
  return upsertHost(deps.db, deps.hub, {
    id: args.id,
    name: args.name ?? "Test Host",
    type: args.type ?? "persistent",
  });
}

export function seedHostSession(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { id?: string; name?: string; type?: "persistent" | "ephemeral" } = {},
) {
  const host = seedHost(deps, args);
  const session = seedSession(deps, host.id);
  return { host, session };
}

export function seedSession(
  deps: Pick<AppDeps, "db" | "hub">,
  hostId: string,
) {
  return openSession(deps.db, deps.hub, {
    hostId,
    instanceId: "instance-1",
    hostName: "Test Host",
    hostType: "persistent",
    dataDir: `/tmp/bb-host-data/${hostId}`,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
}

export function seedProjectWithSource(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { hostId: string; name?: string; path?: string },
) {
  const { project, source } = createProject(deps.db, deps.hub, {
    name: args.name ?? "Test Project",
    source: {
      type: "local_path",
      hostId: args.hostId,
      path: args.path ?? "/tmp/test-project",
    },
  });
  if (source.type !== "local_path") {
    throw new Error("seedProjectWithSource expected a local_path source");
  }
  return { project, source };
}

export function seedEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    hostId: string;
    projectId: string;
    path?: string;
    status?: EnvironmentStatus;
    managed?: boolean;
    workspaceProvisionType?: "unmanaged" | "managed-worktree" | "managed-clone";
    branchName?: string | null;
    defaultBranch?: string | null;
    mergeBaseBranch?: string | null;
  },
) {
  return createEnvironment(deps.db, deps.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path ?? "/tmp/test-environment",
    status: args.status ?? "ready",
    managed: args.managed ?? false,
    isGitRepo: true,
    isWorktree: args.workspaceProvisionType === "managed-worktree",
    workspaceProvisionType: args.workspaceProvisionType ?? "unmanaged",
    branchName: args.branchName !== undefined ? args.branchName : "bb/test",
    defaultBranch: args.defaultBranch !== undefined ? args.defaultBranch : "main",
    mergeBaseBranch: args.mergeBaseBranch ?? null,
  });
}

export function seedThread(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    projectId: string;
    environmentId?: string | null;
    providerId?: string;
    status?: "created" | "provisioning" | "idle" | "active" | "error";
    type?: "standard" | "manager";
    title?: string | null;
    parentThreadId?: string | null;
    titleFallback?: string | null;
  },
) {
  return createThread(deps.db, deps.hub, {
    projectId: args.projectId,
    environmentId: args.environmentId ?? null,
    providerId: args.providerId ?? "codex",
    status: args.status ?? "idle",
    type: args.type ?? "standard",
    title: args.title ?? "Test Thread",
    titleFallback: args.titleFallback ?? "Test Thread",
    parentThreadId: args.parentThreadId ?? null,
  });
}

export function seedDraft(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    content: PromptInput[];
    threadId: string;
    model?: string;
    reasoningLevel?: string;
    sandboxMode?: string;
    serviceTier?: string;
  },
) {
  return createDraft(deps.db, deps.hub, {
    threadId: args.threadId,
    content: args.content,
    model: args.model ?? "gpt-5",
    reasoningLevel: args.reasoningLevel ?? "medium",
    sandboxMode: args.sandboxMode ?? "danger-full-access",
    serviceTier: args.serviceTier ?? "default",
  });
}

export function seedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SeedEventArgs<ThreadEventType>,
): void;
export function seedEvent<TType extends ThreadEventType>(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SeedEventArgs<TType>,
): void {
  const event = parseStoredThreadEvent({
    data: args.data,
    providerThreadId: args.providerThreadId ?? null,
    threadId: args.threadId,
    turnId: args.turnId ?? null,
    type: args.type,
  });
  insertEvents(deps.db, deps.hub, [
    {
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
      providerThreadId: args.providerThreadId ?? null,
      sequence: args.sequence,
      turnId: args.turnId ?? null,
      type: args.type,
      ...deriveStoredEventItemFields(event),
      data: JSON.stringify(args.data),
    },
  ]);
}

export function seedThreadRuntimeState(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environmentId: string;
    inputText?: string;
    model?: string;
    providerThreadId: string;
    reasoningLevel?: string;
    sandboxMode?: string;
    sequenceStart?: number;
    serviceTier?: string;
    threadId: string;
  },
): void {
  const sequenceStart = args.sequenceStart ?? 1;
  seedEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence: sequenceStart,
    type: "thread/identity",
    data: {},
  });
  seedEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence: sequenceStart + 1,
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      input: [
        {
          type: "text",
          text: args.inputText ?? "Prior task",
        },
      ],
      execution: {
        model: args.model ?? "gpt-5",
        serviceTier: args.serviceTier ?? "default",
        reasoningLevel: args.reasoningLevel ?? "medium",
        sandboxMode: args.sandboxMode ?? "danger-full-access",
        source: "client/turn/requested",
      },
      initiator: "user",
      request: {
        method: "turn/start",
        params: {},
      },
      source: "tell",
    },
  });
}

export function seedStoredEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SeedStoredEventArgs,
): void {
  insertEvents(deps.db, deps.hub, [
    {
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
      providerThreadId: args.providerThreadId ?? null,
      sequence: args.sequence,
      turnId: args.turnId ?? null,
      type: args.type,
      itemId: args.itemId ?? null,
      itemKind: args.itemKind ?? null,
      data: JSON.stringify(args.data),
    },
  ]);
}
