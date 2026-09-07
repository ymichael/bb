import type {
  MessageDispatchHookContext,
  PluginAgentConfigurationContext,
  PluginThreadEventPayloads,
} from "@get-bb/plugin-sdk";

type ThreadResponse = PluginThreadEventPayloads["thread.created"]["thread"];
type QueueEntry = PluginThreadEventPayloads["message.queued"]["entry"];
type TurnFailedEvent = PluginThreadEventPayloads["turn.failed"];
type PluginAgentConfigurationContextOverrides = {
  thread?: Partial<PluginAgentConfigurationContext["thread"]>;
  project?: Partial<PluginAgentConfigurationContext["project"]>;
  environment?: Partial<PluginAgentConfigurationContext["environment"]>;
  host?: Partial<PluginAgentConfigurationContext["host"]>;
  provider?: Omit<
    Partial<PluginAgentConfigurationContext["provider"]>,
    "capabilities"
  > & {
    capabilities?: Partial<
      PluginAgentConfigurationContext["provider"]["capabilities"]
    >;
  };
  origin?: Partial<PluginAgentConfigurationContext["origin"]>;
};
type MessageDispatchHookContextOverrides = Omit<
  Partial<MessageDispatchHookContext>,
  | "thread"
  | "project"
  | "environment"
  | "host"
  | "input"
  | "requestedExecution"
  | "executionSources"
  | "queuedMessage"
> & {
  thread?: Partial<MessageDispatchHookContext["thread"]>;
  project?: Partial<MessageDispatchHookContext["project"]>;
  environment?: Partial<
    NonNullable<MessageDispatchHookContext["environment"]>
  > | null;
  host?: Partial<NonNullable<MessageDispatchHookContext["host"]>> | null;
  input?: Partial<MessageDispatchHookContext["input"]>;
  requestedExecution?: Partial<
    MessageDispatchHookContext["requestedExecution"]
  >;
  executionSources?: Partial<MessageDispatchHookContext["executionSources"]>;
  queuedMessage?: Partial<
    NonNullable<MessageDispatchHookContext["queuedMessage"]>
  > | null;
};

/**
 * A complete, deterministic `ThreadResponse` for thread lifecycle event
 * payloads (`harness.emitThreadEvent`). Defaults are the minimal idle
 * thread; override the fields the test cares about. If the contract grows a
 * required field, this builder fails typecheck — update the default here.
 */
export function makeThreadResponse(
  overrides: Partial<ThreadResponse> = {},
): ThreadResponse {
  return {
    id: "thread-1",
    projectId: "project-1",
    environmentId: null,
    providerId: "test-provider",
    title: null,
    titleFallback: null,
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
    lastReadAt: null,
    latestAttentionAt: 0,
    createdAt: 0,
    updatedAt: 0,
    runtime: { displayStatus: "idle", hostReconnectGraceExpiresAt: null },
    activeBackgroundAgentCount: 0,
    canSpawnChild: true,
    queuedMessageCount: 0,
    ...overrides,
  };
}

/**
 * A complete, deterministic context for conditional agent configuration.
 * Defaults describe a standard project on an unmanaged local environment;
 * override the fields the test cares about. If the contract grows a required
 * field, this builder fails typecheck — update the default here.
 */
export function makePluginAgentConfigurationContext(
  overrides: PluginAgentConfigurationContextOverrides = {},
): PluginAgentConfigurationContext {
  const context: PluginAgentConfigurationContext = {
    thread: {
      id: "thread-test",
      title: null,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "project-test",
      kind: "standard",
      name: "Test project",
      gitRemoteUrl: null,
    },
    environment: {
      id: "environment-test",
      name: null,
      path: "/tmp/test",
      workspaceProvisionType: "unmanaged",
      branchName: null,
    },
    host: { id: "host-test", name: "Test host" },
    provider: {
      id: "test-provider",
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: null },
  };
  return {
    thread: { ...context.thread, ...overrides.thread },
    project: { ...context.project, ...overrides.project },
    environment: { ...context.environment, ...overrides.environment },
    host: { ...context.host, ...overrides.host },
    provider: {
      ...context.provider,
      ...overrides.provider,
      capabilities: {
        ...context.provider.capabilities,
        ...overrides.provider?.capabilities,
      },
    },
    origin: { ...context.origin, ...overrides.origin },
  };
}

/**
 * A complete, deterministic context for the `message.dispatch` hook. Defaults
 * describe a first inline dispatch before an environment or host is selected;
 * override the fields the test cares about. If the contract grows a required
 * field, this builder fails typecheck — update the default here.
 */
export function makeMessageDispatchHookContext(
  overrides: MessageDispatchHookContextOverrides = {},
): MessageDispatchHookContext {
  const context: MessageDispatchHookContext = {
    thread: makeThreadResponse({ status: "pending" }),
    project: {
      id: "project-1",
      kind: "standard",
      name: "Test project",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0,
    },
    environment: null,
    host: null,
    input: { blocks: [], text: "Test message" },
    requestedExecution: {
      providerId: "test-provider",
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
    executionSources: {
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
    },
    attempt: "start-turn",
    queuedMessage: null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    parentThreadId: null,
  };
  const environmentDefaults: NonNullable<
    MessageDispatchHookContext["environment"]
  > = {
    id: "environment-1",
    name: null,
    projectId: "project-1",
    hostId: "host-1",
    path: "/tmp/test",
    managed: true,
    isGitRepo: true,
    isWorktree: false,
    workspaceProvisionType: "unmanaged",
    branchName: "main",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
  };
  const hostDefaults: NonNullable<MessageDispatchHookContext["host"]> = {
    id: "host-1",
    name: "Test host",
    type: "persistent",
    status: "connected",
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 0,
    updatedAt: 0,
  };
  const project = { ...context.project, ...overrides.project };
  const host =
    overrides.host === undefined
      ? context.host
      : overrides.host === null
        ? null
        : { ...hostDefaults, ...overrides.host };
  const environment =
    overrides.environment === undefined
      ? context.environment
      : overrides.environment === null
        ? null
        : {
            ...environmentDefaults,
            projectId: project.id,
            hostId: host?.id ?? environmentDefaults.hostId,
            ...overrides.environment,
          };
  const thread = {
    ...context.thread,
    projectId: project.id,
    environmentId: environment?.id ?? null,
    ...overrides.thread,
  };
  return {
    ...context,
    ...overrides,
    thread,
    project,
    environment,
    host,
    input: { ...context.input, ...overrides.input },
    requestedExecution: {
      ...context.requestedExecution,
      ...overrides.requestedExecution,
    },
    executionSources: {
      ...context.executionSources,
      ...overrides.executionSources,
    },
    queuedMessage:
      overrides.queuedMessage === undefined
        ? context.queuedMessage
        : overrides.queuedMessage === null
          ? null
          : makeQueueEntry({
              threadId: thread.id,
              ...overrides.queuedMessage,
            }),
  };
}

/**
 * A complete, deterministic queued row for the `message.*` event payloads
 * and for faking `sdk.threads.queuedMessages.list`. Defaults are a live inline
 * row on this plugin's wait; override what the test is about. If the
 * contract grows a required field, this builder fails typecheck — update the
 * default here.
 */
export function makeQueueEntry(
  overrides: Partial<QueueEntry> = {},
): QueueEntry {
  return {
    id: "queued_1",
    threadId: "thread-1",
    content: [{ type: "text", text: "Queued turn", mentions: [] }],
    model: "test-model",
    reasoningLevel: "medium",
    permissionMode: "auto",
    serviceTier: "default",
    groupWithNext: false,
    sendAt: null,
    waitingOn: {
      kind: "plugin",
      pluginId: "test-plugin",
      reason: "Waiting",
    },
    failureReason: null,
    payload: { kind: "inline" },
    editable: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/**
 * A complete, deterministic `turn.failed` payload. Defaults are a first attempt
 * that failed inside a provider turn with neither structured error info nor
 * rate limits — the shape a retry policy must handle before it handles the
 * interesting ones. If the contract grows a required field, this builder fails
 * typecheck — update the default here.
 */
export function makeTurnFailedEvent(
  overrides: Partial<TurnFailedEvent> = {},
): TurnFailedEvent {
  return {
    threadId: "thread-1",
    requestId: "creq_2222222222",
    turnId: "turn-1",
    errorInfo: null,
    inputAccepted: true,
    rateLimits: null,
    attemptNumber: 1,
    ...overrides,
  };
}
