import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createEnvironment,
  createQueuedThreadMessage,
  deriveStoredEventItemFields,
  getLatestThreadSequence,
  hasStoredTurnStarted,
  insertEvents,
  createProject,
  createThread,
  openSession,
  upsertHost,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  HOST_ID_FILE_NAME,
} from "@bb/host-daemon-contract";
import {
  encodeClientTurnRequestIdNumber,
  parseStoredThreadEvent,
  threadScope,
  turnScope,
} from "@bb/domain";
import type {
  EnvironmentStatus,
  PermissionMode,
  PromptInput,
  QueuedMessageWaitingOn,
  RecordedPermissionMode,
  StoredThreadEventDataForType,
  ThreadEventScope,
  ThreadEventItemType,
  ThreadEventType,
  ThreadOriginKind,
  ThreadStatus,
  ThreadVisibility,
  WorkspaceProvisionType,
} from "@bb/domain";
import type { AppDeps } from "../../src/types.js";
import { registerTestHostRpcCapture } from "./commands.js";

interface SeedEventArgs<TType extends ThreadEventType> {
  createdAt?: number;
  data: StoredThreadEventDataForType<TType>;
  environmentId?: string | null;
  providerThreadId?: string | null;
  scope: ThreadEventScope;
  sequence: number;
  threadId: string;
  type: TType;
}

interface SeedStoredEventArgs {
  createdAt?: number;
  data: Record<string, unknown>;
  environmentId?: string | null;
  itemId?: string | null;
  itemKind?: ThreadEventItemType | null;
  parentToolCallId?: string | null;
  providerThreadId?: string | null;
  scope: ThreadEventScope;
  sequence: number;
  threadId: string;
  type: ThreadEventType;
}

interface SeedTurnStartedArgs {
  environmentId?: string | null;
  providerThreadId?: string;
  sequence?: number;
  threadId: string;
  turnId: string;
}

export function seedHost(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    connectMachineId?: string;
    id?: string;
    name?: string;
    type?: "persistent";
  } = {},
) {
  return upsertHost(deps.db, deps.hub, {
    ...(args.connectMachineId !== undefined
      ? { connectMachineId: args.connectMachineId }
      : {}),
    id: args.id,
    name: args.name ?? "Test Host",
    type: args.type ?? "persistent",
  });
}

export function seedHostSession(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { id?: string; name?: string; type?: "persistent" } = {},
) {
  const host = seedHost(deps, args);
  const session = seedSession(deps, host.id);
  return { host, session };
}

export function seedPrimaryHost(
  deps: Pick<AppDeps, "config">,
  hostId: string,
): void {
  writeFileSync(join(deps.config.dataDir, HOST_ID_FILE_NAME), hostId);
}

export function seedSession(deps: Pick<AppDeps, "db" | "hub">, hostId: string) {
  const session = openSession(deps.db, {
    hostId,
    instanceId: "instance-1",
    hostName: "Test Host",
    hostType: "persistent",
    dataDir: `/tmp/bb-host-data/${hostId}`,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    heartbeatIntervalMs: 5_000,
    leaseTimeoutMs: 30_000,
  });
  deps.hub.recordDaemonSessionPlatform(session.id, "darwin");
  registerTestHostRpcCapture(deps, { hostId, sessionId: session.id });
  return session;
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
    path?: string | null;
    status?: EnvironmentStatus;
    managed?: boolean;
    workspaceProvisionType?: WorkspaceProvisionType;
    isGitRepo?: boolean;
    isWorktree?: boolean;
    branchName?: string | null;
    baseBranch?: string | null;
    defaultBranch?: string | null;
    mergeBaseBranch?: string | null;
  },
) {
  return createEnvironment(deps.db, deps.hub, {
    projectId: args.projectId,
    hostId: args.hostId,
    path: args.path !== undefined ? args.path : "/tmp/test-environment",
    status: args.status ?? "ready",
    managed: args.managed ?? false,
    isGitRepo: args.isGitRepo ?? args.workspaceProvisionType !== "personal",
    isWorktree:
      args.isWorktree ?? args.workspaceProvisionType === "managed-worktree",
    workspaceProvisionType: args.workspaceProvisionType ?? "unmanaged",
    branchName: args.branchName !== undefined ? args.branchName : "bb/test",
    baseBranch: args.baseBranch !== undefined ? args.baseBranch : null,
    defaultBranch:
      args.defaultBranch !== undefined ? args.defaultBranch : "main",
    mergeBaseBranch: args.mergeBaseBranch ?? null,
  });
}

export function seedThread(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    projectId: string;
    environmentId?: string | null;
    providerId?: string;
    status?: ThreadStatus;
    title?: string | null;
    parentThreadId?: string | null;
    sourceThreadId?: string | null;
    originKind?: ThreadOriginKind | null;
    originPluginId?: string | null;
    titleFallback?: string | null;
    visibility?: ThreadVisibility;
  },
) {
  return createThread(deps.db, deps.hub, {
    projectId: args.projectId,
    environmentId: args.environmentId ?? null,
    providerId: args.providerId ?? "codex",
    status: args.status ?? "idle",
    title: args.title ?? "Test Thread",
    titleFallback: args.titleFallback ?? "Test Thread",
    parentThreadId: args.parentThreadId ?? null,
    sourceThreadId: args.sourceThreadId ?? null,
    originKind: args.originKind ?? null,
    originPluginId: args.originPluginId ?? null,
    visibility: args.visibility ?? "visible",
  });
}

export function seedThreadFixture(
  harness: { deps: Pick<AppDeps, "db" | "hub"> },
  args: {
    session?: Parameters<typeof seedHostSession>[1];
    environment?: Omit<
      Parameters<typeof seedEnvironment>[1],
      "hostId" | "projectId"
    >;
    thread?: Omit<
      Parameters<typeof seedThread>[1],
      "projectId" | "environmentId"
    >;
  } = {},
) {
  const { host, session } = seedHostSession(harness.deps, args.session);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    ...args.environment,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    ...args.thread,
  });
  return { host, session, project, environment, thread };
}

export function seedQueuedMessage(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    content: PromptInput[];
    threadId: string;
    model?: string;
    reasoningLevel?: string;
    permissionMode?: PermissionMode;
      senderThreadId?: string | null;
    serviceTier?: string;
    /** Defaults to a row with no wait: an ordinary queued message. */
    waitingOn?: QueuedMessageWaitingOn | null;
    sendAt?: number | null;
  },
) {
  return createQueuedThreadMessage(deps.db, deps.hub, {
    threadId: args.threadId,
    content: args.content,
    model: args.model ?? "gpt-5",
    reasoningLevel: args.reasoningLevel ?? "medium",
    permissionMode: args.permissionMode ?? "full",
    senderThreadId: args.senderThreadId ?? null,
    serviceTier: args.serviceTier ?? "default",
    waitingOn: args.waitingOn ?? null,
    sendAt: args.sendAt ?? null,
    payload: { kind: "inline" },
    systemNotice: null,
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
    scope: args.scope,
    threadId: args.threadId,
    type: args.type,
  });
  insertEvents(deps.db, deps.hub, [
    {
      createdAt: args.createdAt,
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
      providerThreadId: args.providerThreadId ?? null,
      scope: args.scope,
      sequence: args.sequence,
      type: args.type,
      ...deriveStoredEventItemFields(event),
      data: JSON.stringify(args.data),
    },
  ]);
}

export function seedTurnStarted(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SeedTurnStartedArgs,
): void {
  if (
    hasStoredTurnStarted(deps.db, {
      threadId: args.threadId,
      turnId: args.turnId,
    })
  ) {
    return;
  }

  const providerThreadId = args.providerThreadId ?? `provider-${args.turnId}`;
  seedEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId ?? null,
    providerThreadId,
    sequence:
      args.sequence ??
      getLatestThreadSequence(deps.db, { threadId: args.threadId }) + 1,
    type: "turn/started",
    scope: turnScope(args.turnId),
    data: { providerThreadId },
  });
}

export function seedThreadRuntimeState(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    environmentId: string | null;
    inputText?: string;
    model?: string;
    providerThreadId: string;
    permissionMode?: RecordedPermissionMode;
    reasoningLevel?: string;
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
    scope: threadScope(),
    data: {},
  });
  seedEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId: args.providerThreadId,
    sequence: sequenceStart + 1,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId: encodeClientTurnRequestIdNumber({ value: sequenceStart }),
      input: [
        {
          type: "text",
          text: args.inputText ?? "Prior task",
        },
      ],
      target: { kind: "new-turn" },
      execution: {
        model: args.model ?? "gpt-5",
        serviceTier: args.serviceTier ?? "default",
        reasoningLevel: args.reasoningLevel ?? "medium",
        permissionMode: args.permissionMode ?? "full",
        source: "client/turn/requested",
      },
      initiator: "user",
      senderThreadId: null,
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
      createdAt: args.createdAt,
      threadId: args.threadId,
      environmentId: args.environmentId ?? null,
      providerThreadId: args.providerThreadId ?? null,
      scope: args.scope,
      sequence: args.sequence,
      type: args.type,
      itemId: args.itemId ?? null,
      itemKind: args.itemKind ?? null,
      parentToolCallId: args.parentToolCallId ?? null,
      data: JSON.stringify(args.data),
    },
  ]);
}
