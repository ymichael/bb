import type {
  Environment,
  Host,
  ProviderInfo,
  Thread,
  ThreadListEntry,
  ThreadQueuedMessage,
  ThreadWithRuntime,
} from "@bb/domain";

type ProviderInfoOverrides = Omit<
  Partial<ProviderInfo>,
  "capabilities" | "maintenance"
> & {
  capabilities?: Partial<ProviderInfo["capabilities"]>;
  maintenance?: Partial<ProviderInfo["maintenance"]>;
};
type ThreadWithRuntimeOverrides = Omit<
  Partial<ThreadWithRuntime>,
  "runtime"
> & {
  runtime?: Partial<ThreadWithRuntime["runtime"]>;
};
type ThreadListEntryOverrides = Omit<
  Partial<ThreadListEntry>,
  "activity" | "runtime"
> & {
  activity?: Partial<ThreadListEntry["activity"]>;
  runtime?: Partial<ThreadListEntry["runtime"]>;
};

export function makeEnvironment(
  overrides: Partial<Environment> = {},
): Environment {
  return {
    id: "env_test",
    name: null,
    projectId: "proj_test",
    hostId: "host_test",
    path: "/workspace",
    managed: true,
    isGitRepo: true,
    isWorktree: true,
    workspaceProvisionType: "managed-worktree",
    branchName: "feature/test",
    baseBranch: "main",
    defaultBranch: "main",
    mergeBaseBranch: null,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return {
    id: "host_test",
    name: "Test host",
    type: "persistent",
    status: "connected",
    lastSeenAt: null,
    maxPermissionMode: "full",
    lastRejectedProtocolVersion: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export function makeProviderInfo(
  overrides: ProviderInfoOverrides & Pick<ProviderInfo, "id">,
): ProviderInfo {
  const id = overrides.id;
  const provider: ProviderInfo = {
    id,
    pluginId: `provider-${id}`,
    displayName: id,
    logoUrl: `/api/v1/system/providers/${id}/logo`,
    available: true,
    maintenance: { health: false, usage: false, installation: false },
    composerActions: [],
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsFork: true,
      supportsSessionRewind: false,
      modelCatalogScope: "workspace",
      permissionModes: ["accept-edits", "auto", "full"],
    },
  };
  return {
    ...provider,
    ...overrides,
    maintenance: { ...provider.maintenance, ...overrides.maintenance },
    capabilities: { ...provider.capabilities, ...overrides.capabilities },
  };
}

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thr_test",
    projectId: "proj_test",
    environmentId: "env_test",
    providerId: "codex",
    title: "Test thread",
    titleFallback: "Test thread",
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: 100,
    latestAttentionAt: 100,
    createdAt: 0,
    updatedAt: 100,
    ...overrides,
  };
}

export function makeThreadWithRuntime(
  overrides: ThreadWithRuntimeOverrides = {},
): ThreadWithRuntime {
  const thread: ThreadWithRuntime = {
    ...makeThread(),
    runtime: {
      displayStatus: "idle",
      hostReconnectGraceExpiresAt: null,
    },
  };
  return {
    ...thread,
    ...overrides,
    runtime: { ...thread.runtime, ...overrides.runtime },
  };
}

export function makeThreadListEntry(
  overrides: ThreadListEntryOverrides = {},
): ThreadListEntry {
  const entry: ThreadListEntry = {
    ...makeThreadWithRuntime({
      id: "thr_sender",
      environmentId: null,
      title: "Sender thread",
      titleFallback: null,
    }),
    pinSortKey: null,
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
    },
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: null,
    queuedWork: "none",
    environmentWorkspaceDisplayKind: "other",
  };
  return {
    ...entry,
    ...overrides,
    activity: { ...entry.activity, ...overrides.activity },
    runtime: { ...entry.runtime, ...overrides.runtime },
  };
}

export function makeThreadQueuedMessage(
  overrides: Partial<ThreadQueuedMessage> = {},
): ThreadQueuedMessage {
  return {
    id: "qmsg_test",
    threadId: "thr_test",
    content: [{ type: "text", text: "Queued message", mentions: [] }],
    model: "gpt-5.5",
    reasoningLevel: "medium",
    permissionMode: "auto",
    serviceTier: "default",
    groupWithNext: false,
    sendAt: null,
    waitingOn: null,
    failureReason: null,
    payload: { kind: "inline" },
    editable: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
