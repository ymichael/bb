import {
  attachProviderLaunch,
  restoreProviderLaunchContext,
} from "../environments/provider-orchestration.js";
import {
  createEnvironment,
  getEnvironment,
  getThread,
  type CreateEnvironmentInput,
  type EnvironmentRow,
  type DbNotifier,
  type DbTransaction,
  updateThread,
} from "@bb/db";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  threadScope,
  type ProvisioningTranscriptEntry,
  type Thread,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { ApiError } from "../../errors.js";
import { advanceEnvironmentProvisioning } from "../environments/environment-provisioning-internal.js";
import type { EnvironmentProvisionRequest } from "../environments/environment-provision-request.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendSystemErrorEvent,
  appendThreadProvisioningEvent,
  appendThreadProvisioningEventInTransaction,
} from "./thread-events.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import { dispatchThreadRenameCommand } from "./thread-commands.js";
import { inferThreadMetadata } from "./thread-metadata-inference.js";
import {
  createEnvironmentAttachedContext,
  createEnvironmentPendingContext,
  createProviderPendingContext,
  hasProvisioningTimelineRow,
  isProviderPendingContext,
  createEnvironmentProvisioningContext,
  createWorkspaceReadyContext,
  isAttachableContext,
  isEnvironmentPendingContext,
  isMetadataPendingContext,
  isProvisionableContext,
  provisionableContextForWorkspaceReady,
  provisioningStartedContext,
  type ThreadProvisionAttachableContext,
  type ThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionEnvironmentPendingContext,
  type ThreadProvisionEnvironmentProvisioningContext,
  type ThreadProvisionMetadataPendingContext,
  type ThreadProvisionProducedBy,
  type ThreadProvisionProvisionableContext,
  type ThreadProvisionProviderPendingContext,
} from "./thread-provisioning-context.js";
import { resolveEnvironmentProvider } from "./thread-environment-providers.js";
import {
  forgetActiveThreadProvisionContext,
  getActiveThreadProvisionContext,
  rememberActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";

export type ThreadProvisioningDeps = CommandResultSideEffectsDeps;

type NewThreadProvisionEnvironmentIntent = Exclude<
  ThreadProvisionEnvironmentIntent,
  { type: "reuse" }
>;

const INITIAL_PROVISIONING_TEXT = "Preparing workspace";

interface EnsureWorkspaceReadyEventArgs {
  context?: ThreadProvisionAttachableContext;
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  threadId: string;
}

type EnsureWorkspaceReadyEventResult =
  | { reached: true; appendedSequence: number | null }
  | { reached: false };

interface ThreadProvisionTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
}

interface FailThreadProvisioningArgs {
  detail: string;
  environmentId: string | null;
  thread: Thread;
}

interface ResolveMetadataIfNeededArgs {
  context: ThreadProvisionContext;
  thread: Thread;
}

interface EnvironmentPayloadThreadArgs {
  context: ThreadProvisionProvisionableContext;
  environment: EnvironmentRow;
  thread: Thread;
}

interface AttachThreadToEnvironmentArgs {
  context: ThreadProvisionAttachableContext;
  environment: EnvironmentRow;
  thread: Thread;
}

interface BuildEnvironmentProvisionRequestArgs {
  context: ThreadProvisionEnvironmentProvisioningContext;
  environment: EnvironmentRow;
}

interface ThreadProvisionEnvironmentPlan {
  buildRequest: (
    args: BuildEnvironmentProvisionRequestArgs,
  ) => EnvironmentProvisionRequest;
  environmentInput: CreateEnvironmentInput;
}

interface CreateProvisioningEnvironmentArgs extends ThreadProvisionEnvironmentPlan {
  context: ThreadProvisionEnvironmentPendingContext;
  thread: Thread;
}

interface ThreadProvisioningResult {
  context: ThreadProvisionContext;
  environment: EnvironmentRow;
  provisionRequest?: EnvironmentProvisionRequest | null;
}

interface ResolveEnvironmentCreationPlanArgs {
  intent: NewThreadProvisionEnvironmentIntent;
  producedBy: ThreadProvisionProducedBy | null;
  thread: Thread;
}

interface DirectUnmanagedEnvironmentPlanArgs {
  intent: Extract<ThreadProvisionEnvironmentIntent, { type: "provider" }> & {
    produced: NonNullable<
      Extract<
        ThreadProvisionEnvironmentIntent,
        { type: "provider" }
      >["produced"]
    >;
  };
  producedBy: ThreadProvisionProducedBy | null;
  thread: Thread;
}

interface EnsureEnvironmentRequestedArgs {
  context: ThreadProvisionContext;
  thread: Thread;
}

interface EnsureThreadProvisionEnvironmentReadyArgs {
  context: ThreadProvisionContext;
  thread: Thread;
}

interface ThreadProvisionReadyEnvironment {
  context: ThreadProvisionProvisionableContext;
  environment: EnvironmentRow;
  thread: Thread;
}

function initialProvisioningEntries(): ProvisioningTranscriptEntry[] {
  return [
    {
      type: "step",
      key: "workspace-started",
      text: INITIAL_PROVISIONING_TEXT,
      status: "started",
    },
  ];
}

export function loadActiveThreadProvisionContext(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ThreadProvisionContext | null {
  const thread = getThread(deps.db, threadId);
  const context =
    getActiveThreadProvisionContext(threadId) ??
    restoreProviderLaunchContext(deps.db, threadId);
  if (context !== null)
    rememberActiveThreadProvisionContext({ threadId, context });
  if (
    !thread ||
    thread.deletedAt !== null ||
    !context ||
    thread.status !== "starting" ||
    (context.state.environmentId !== null &&
      thread.environmentId !== context.state.environmentId)
  ) {
    return null;
  }
  return context;
}

export function ensureWorkspaceReadyEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EnsureWorkspaceReadyEventArgs,
): EnsureWorkspaceReadyEventResult {
  return deps.db.transaction(
    (tx) =>
      ensureWorkspaceReadyEventInTransaction({ db: tx, hub: deps.hub }, args),
    { behavior: "immediate" },
  );
}

function ensureWorkspaceReadyEventRecord(
  db: DbTransaction,
  args: EnsureWorkspaceReadyEventArgs,
): EnsureWorkspaceReadyEventResult {
  const thread = getThread(db, args.threadId);
  const context =
    args.context ?? getActiveThreadProvisionContext(args.threadId);
  if (
    !thread ||
    thread.deletedAt !== null ||
    !context ||
    thread.status !== "starting" ||
    (context.state.environmentId !== null &&
      context.state.environmentId !== args.environmentId)
  ) {
    return { reached: false };
  }
  if (context.state.stage === "workspace-ready") {
    return {
      reached: true,
      appendedSequence: context.state.workspaceReadyEventSequence,
    };
  }
  if (!isAttachableContext(context)) {
    return { reached: false };
  }
  const provisionableContext = provisionableContextForWorkspaceReady(context, {
    attachedEnvironmentId: args.environmentId,
  });

  const appendedSequence =
    provisionableContext.state.provisionEventSequence === null
      ? null
      : appendThreadProvisioningEventInTransaction(db, {
          threadId: args.threadId,
          environmentId: args.environmentId,
          provisioningId: context.state.provisioningId,
          status: "active",
          entries: args.entries,
        });
  rememberActiveThreadProvisionContext({
    threadId: args.threadId,
    context: createWorkspaceReadyContext(provisionableContext, {
      workspaceReadyEventSequence: appendedSequence,
    }),
  });
  return { reached: true, appendedSequence };
}

export function ensureWorkspaceReadyEventInTransaction(
  deps: ThreadProvisionTransactionDeps,
  args: EnsureWorkspaceReadyEventArgs,
): EnsureWorkspaceReadyEventResult {
  const result = ensureWorkspaceReadyEventRecord(deps.db, args);
  if (result.reached && result.appendedSequence !== null) {
    deps.hub.notifyThread(args.threadId, ["events-appended"], {
      eventTypes: ["system/thread-provisioning"],
    });
  }
  return result;
}

export function failThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: FailThreadProvisioningArgs,
): void {
  const context = getActiveThreadProvisionContext(args.thread.id);
  forgetActiveThreadProvisionContext(args.thread.id);
  if (
    context !== null &&
    context.state.environmentId === null &&
    hasProvisioningTimelineRow(context)
  ) {
    appendThreadProvisioningEvent(deps, {
      threadId: args.thread.id,
      environmentId: null,
      provisioningId: context.state.provisioningId,
      status: "failed",
      entries: [
        {
          type: "step",
          key: "workspace-failed",
          text: "Workspace setup failed",
          status: "failed",
          startedAt: Date.now(),
        },
      ],
    });
  }
  // Provisioning is not coming, so nothing may keep waiting on it. The
  // messages stay queued rather than being discarded: they are still the
  // user's, and retrying the thread is exactly when they should go.
  requestQueuedMessageDispatch(deps, {
    kind: "provisioning-ended",
    threadId: args.thread.id,
  });
  appendSystemErrorEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environmentId,
    code: "thread_provisioning_failed",
    message: "Provisioning thread failed",
    detail: args.detail,
    scope: threadScope(),
  });
  applyLoggedThreadLifecycleEvent(deps, {
    event: { type: "run.failed" },
    threadId: args.thread.id,
  });
}

function hasActiveEnvironmentProvision(environment: EnvironmentRow): boolean {
  return environment.status === "provisioning";
}

async function resolveMetadataIfNeeded(
  deps: ThreadProvisioningDeps,
  args: ResolveMetadataIfNeededArgs,
): Promise<ThreadProvisionContext> {
  if (!isMetadataPendingContext(args.context)) {
    return args.context;
  }

  if (!args.context.request.titleProvided) {
    void inferThreadMetadata(deps, {
      environmentId: null,
      input: args.context.request.input,
      provisioningId: args.context.state.provisioningId,
      threadId: args.thread.id,
      writeTranscript: false,
    })
      .then((metadata) => {
        if (!metadata.titleApplied || !metadata.title) {
          return;
        }
        const titledThread = getThread(deps.db, args.thread.id);
        const environment = titledThread?.environmentId
          ? getEnvironment(deps.db, titledThread.environmentId)
          : null;
        if (
          !titledThread ||
          !environment ||
          (titledThread.status !== "active" && titledThread.status !== "idle")
        ) {
          return;
        }
        dispatchThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          providerId: titledThread.providerId,
          threadId: titledThread.id,
          title: metadata.title,
        });
      })
      .catch((error) => {
        deps.logger.warn(
          {
            threadId: args.thread.id,
            ...runtimeErrorLogFields(deps.config, error),
          },
          "Failed to generate thread title",
        );
      });
  }

  const resolvedContext = createEnvironmentPendingContext(args.context);
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context: resolvedContext,
  });
  return resolvedContext;
}

function attachThreadToEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AttachThreadToEnvironmentArgs,
): ThreadProvisionProvisionableContext {
  if (args.thread.environmentId !== args.environment.id) {
    updateThread(deps.db, deps.hub, args.thread.id, {
      environmentId: args.environment.id,
    });
  }
  if (
    isProvisionableContext(args.context) &&
    args.context.state.environmentId === args.environment.id
  ) {
    return args.context;
  }
  const attachedContext = createEnvironmentAttachedContext(args.context, {
    attachedEnvironmentId: args.environment.id,
  });
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context: attachedContext,
  });
  return attachedContext;
}

function appendProvisioningStartedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EnvironmentPayloadThreadArgs,
): ThreadProvisionProvisionableContext {
  const existingContext = provisioningStartedContext(args.context);
  if (existingContext) {
    return existingContext;
  }

  const appendedSequence = appendThreadProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    provisioningId: args.context.state.provisioningId,
    status: "active",
    entries: initialProvisioningEntries(),
  });
  const updatedContext = createEnvironmentProvisioningContext(args.context, {
    provisionEventSequence: appendedSequence,
  });
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context: updatedContext,
  });
  return updatedContext;
}

function createProvisioningEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: CreateProvisioningEnvironmentArgs,
): ThreadProvisioningResult {
  const result = deps.db.transaction(
    (tx) => {
      const activeThread = getThread(tx, args.thread.id);
      const activeContext = getActiveThreadProvisionContext(args.thread.id);
      if (
        !activeThread ||
        activeThread.status !== "starting" ||
        !activeContext ||
        activeContext.state.provisioningId !== args.context.state.provisioningId
      ) {
        throw new Error("Thread provisioning context is no longer active");
      }
      const activeAttachedEnvironmentId = activeContext.state.environmentId;
      if (activeAttachedEnvironmentId) {
        const existingEnvironment = getEnvironment(
          tx,
          activeAttachedEnvironmentId,
        );
        if (!existingEnvironment) {
          throw new Error("Attached provisioning environment no longer exists");
        }
        return {
          context: activeContext,
          environment: existingEnvironment,
        };
      }

      const environment = createEnvironment(
        tx,
        deps.hub,
        args.environmentInput,
      );
      attachProviderLaunch(tx, args.thread.id, environment.id);
      if (args.thread.environmentId !== environment.id) {
        updateThread(tx, deps.hub, args.thread.id, {
          environmentId: environment.id,
        });
      }

      const attachedContext = createEnvironmentAttachedContext(args.context, {
        attachedEnvironmentId: environment.id,
      });
      const appendedSequence = appendThreadProvisioningEventInTransaction(tx, {
        threadId: args.thread.id,
        environmentId: environment.id,
        provisioningId: attachedContext.state.provisioningId,
        status: "active",
        entries: initialProvisioningEntries(),
      });
      const context = createEnvironmentProvisioningContext(attachedContext, {
        provisionEventSequence: appendedSequence,
      });
      rememberActiveThreadProvisionContext({
        threadId: args.thread.id,
        context,
      });
      const provisionRequest = args.buildRequest({
        context,
        environment,
      });
      return { context, environment, provisionRequest };
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["system/thread-provisioning"],
  });
  return result;
}

function buildHostEnvironmentPlan(
  args: DirectUnmanagedEnvironmentPlanArgs,
): ThreadProvisionEnvironmentPlan {
  return {
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.intent.produced.hostId,
      providerOwnsPath: args.intent.produced.ownsPath,
      status: "provisioning",
    },
    buildRequest: ({ context, environment }) => {
      return {
        command: buildEnvironmentProvisionCommand({
          environmentId: environment.id,
          hostId: args.intent.produced.hostId,
          initiator: {
            threadId: args.thread.id,
            provisioningId: context.state.provisioningId,
          },
          path: args.intent.produced.path,
        }),
        mergeBaseBranch: args.intent.produced.mergeBaseBranch,
        mode: args.producedBy === null ? "provision" : "inspect",
      };
    },
  };
}

async function resolveEnvironmentCreationPlan(
  deps: ThreadProvisioningDeps,
  args: ResolveEnvironmentCreationPlanArgs,
): Promise<ThreadProvisionEnvironmentPlan> {
  const plan = await resolveEnvironmentCreationPlanForIntent(deps, args);
  return {
    ...plan,
    environmentInput: {
      ...plan.environmentInput,
      environmentProvider: args.producedBy,
    },
  };
}

async function resolveEnvironmentCreationPlanForIntent(
  deps: ThreadProvisioningDeps,
  args: ResolveEnvironmentCreationPlanArgs,
): Promise<ThreadProvisionEnvironmentPlan> {
  if (args.intent.produced === null) {
    throw new Error(
      "A provider intent must be resolved before an environment is created",
    );
  }
  return buildHostEnvironmentPlan({
    intent: { ...args.intent, produced: args.intent.produced },
    producedBy: args.producedBy,
    thread: args.thread,
  });
}

function attachActiveProvisioningEnvironment(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): ThreadProvisioningResult {
  if (!hasActiveEnvironmentProvision(args.environment)) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is provisioning without an active provision",
    });
    return {
      context: args.context,
      environment: args.environment,
    };
  }

  return {
    context: appendProvisioningStartedEvent(deps, {
      context: args.context,
      environment: args.environment,
      thread: args.thread,
    }),
    environment: args.environment,
  };
}

async function ensureEnvironmentRequested(
  deps: ThreadProvisioningDeps,
  args: EnsureEnvironmentRequestedArgs,
): Promise<ThreadProvisioningResult> {
  if (!isAttachableContext(args.context)) {
    throw new Error(
      `Cannot request environment from ${args.context.state.stage} state`,
    );
  }

  if (args.context.request.environmentIntent.type === "reuse") {
    const environment = getEnvironment(
      deps.db,
      args.context.request.environmentIntent.environmentId,
    );
    if (!environment) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    const context = attachThreadToEnvironment(deps, {
      context: args.context,
      environment,
      thread: args.thread,
    });
    if (environment.status === "provisioning") {
      return attachActiveProvisioningEnvironment(deps, {
        context,
        environment,
        thread: args.thread,
      });
    }
    return { context, environment };
  }

  const attachedEnvironmentId = args.context.state.environmentId;
  if (attachedEnvironmentId) {
    const environment = getEnvironment(deps.db, attachedEnvironmentId);
    if (!environment) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    return {
      context: args.context,
      environment,
    };
  }

  if (!isEnvironmentPendingContext(args.context)) {
    throw new Error(
      `Cannot request environment from ${args.context.state.stage} state`,
    );
  }

  const plan = await resolveEnvironmentCreationPlan(deps, {
    intent: args.context.request.environmentIntent,
    producedBy: args.context.request.producedBy,
    thread: args.thread,
  });
  return createProvisioningEnvironment(deps, {
    context: args.context,
    thread: args.thread,
    ...plan,
  });
}

interface PrepareTargetPendingArgs {
  context: ThreadProvisionMetadataPendingContext;
  thread: Thread;
}

async function prepareTargetPending(
  deps: ThreadProvisioningDeps,
  args: PrepareTargetPendingArgs,
): Promise<ThreadProvisionProviderPendingContext> {
  const provisionEventSequence = appendThreadProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: null,
    provisioningId: args.context.state.provisioningId,
    status: "active",
    entries: [
      {
        type: "step",
        key: "workspace-started",
        text: "Preparing workspace",
        status: "completed",
        startedAt: Date.now(),
      },
    ],
  });
  if (!args.context.request.titleProvided) {
    await inferThreadMetadata(deps, {
      environmentId: null,
      input: args.context.request.input,
      provisioningId: args.context.state.provisioningId,
      threadId: args.thread.id,
      writeTranscript: true,
    });
  }
  if (
    getActiveThreadProvisionContext(args.thread.id)?.state.provisioningId !==
    args.context.state.provisioningId
  ) {
    throw new Error("Thread provisioning context is no longer active");
  }
  const context = createProviderPendingContext(args.context, {
    provisionEventSequence,
  });
  rememberActiveThreadProvisionContext({
    threadId: args.thread.id,
    context,
  });
  return context;
}

export async function ensureThreadProvisionEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnsureThreadProvisionEnvironmentReadyArgs,
): Promise<ThreadProvisionReadyEnvironment | null> {
  let resolvedContext: ThreadProvisionContext = args.context;
  if (
    isMetadataPendingContext(resolvedContext) &&
    resolvedContext.request.environmentIntent.type === "provider" &&
    resolvedContext.request.environmentIntent.produced === null
  ) {
    resolvedContext = await prepareTargetPending(deps, {
      context: resolvedContext,
      thread: args.thread,
    });
  }
  if (isProviderPendingContext(resolvedContext)) {
    const resolution = await resolveEnvironmentProvider(deps, {
      context: resolvedContext,
      thread: args.thread,
    });
    if (resolution.kind === "waiting") {
      return null;
    }
    resolvedContext = resolution.context;
  }
  const context = await resolveMetadataIfNeeded(deps, {
    context: resolvedContext,
    thread: args.thread,
  });
  const {
    context: attachedContext,
    environment,
    provisionRequest,
  } = await ensureEnvironmentRequested(deps, {
    context,
    thread: args.thread,
  });

  if (environment.status === "provisioning") {
    await advanceEnvironmentProvisioning(deps, {
      environmentId: environment.id,
      request: provisionRequest ?? null,
    });
  }
  if (!isProvisionableContext(attachedContext)) {
    throw new Error(
      `Cannot start thread from ${attachedContext.state.stage} state`,
    );
  }

  const readyEnvironment =
    environment.status === "provisioning"
      ? (getEnvironment(deps.db, environment.id) ?? environment)
      : environment;

  return {
    context: attachedContext,
    environment: readyEnvironment,
    thread: args.thread,
  };
}
