import {
  createEnvironment,
  getAppSettings,
  getEnvironment,
  getThread,
  type CreateEnvironmentInput,
  type DbNotifier,
  type DbTransaction,
  updateThread,
} from "@bb/db";
import { runtimeErrorLogFields } from "../lib/error-log-fields.js";
import {
  threadScope,
  type Environment,
  type ProvisioningTranscriptEntry,
  type Thread,
} from "@bb/domain";
import type { BaseBranchSpec, UnmanagedBranchSpec } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { ApiError } from "../../errors.js";
import { advanceEnvironmentProvisioning } from "../environments/environment-provisioning-internal.js";
import { applyLoggedEnvironmentLifecycleEventInTransaction } from "../environments/lifecycle-outcome.js";
import type { EnvironmentProvisionRequest } from "../environments/environment-provision-request.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import {
  appendSystemErrorEvent,
  appendThreadProvisioningEvent,
  appendThreadProvisioningEventInTransaction,
} from "./thread-events.js";
import {
  baseBranchSpecToStoredName,
  buildEnvironmentProvisionCommand,
  buildManagedBranchName,
  SETUP_TIMEOUT_MS,
  type UnmanagedCheckoutCommand,
} from "./thread-create-helpers.js";
import { dispatchThreadRenameCommand } from "./thread-commands.js";
import { inferThreadMetadata } from "./thread-metadata-inference.js";
import { sanitizeGeneratedBranchSlug } from "./title-generation.js";
import {
  createEnvironmentAttachedContext,
  createEnvironmentPendingContext,
  createEnvironmentPreparedContext,
  createEnvironmentProvisioningContext,
  createWorkspaceReadyContext,
  isAttachableContext,
  isEnvironmentPreparedContext,
  isEnvironmentProvisioningContext,
  isEnvironmentPendingContext,
  isMetadataPendingContext,
  isProvisionableContext,
  provisionableContextForWorkspaceReady,
  provisioningStartedContext,
  resolvePreparedEnvironmentMetadata,
  type ThreadProvisionAttachableContext,
  type ThreadProvisionContext,
  type ThreadProvisionEnvironmentIntent,
  type ThreadProvisionEnvironmentPendingContext,
  type ThreadProvisionEnvironmentPreparedContext,
  type ThreadProvisionEnvironmentProvisioningContext,
  type ThreadProvisionMetadataPendingContext,
  type ThreadProvisionProvisionableContext,
} from "./thread-provisioning-context.js";
import {
  forgetActiveThreadProvisionContext,
  getActiveThreadProvisionContext,
  rememberActiveThreadProvisionContext,
} from "./thread-provisioning-active-context.js";
import { applyLoggedThreadLifecycleEvent } from "./lifecycle-outcome.js";
import {
  resolveManagedTargetPath,
  resolvePersonalTargetPath,
} from "./worktree-paths.js";

export type ThreadProvisioningDeps = CommandResultSideEffectsDeps;

type ThreadProvisionWriteDeps = Pick<
  AppDeps,
  "db" | "hub" | "logger" | "providerRegistry"
>;
type DirectUnmanagedIntent = Extract<
  ThreadProvisionEnvironmentIntent,
  { type: "direct-unmanaged" }
>;
type CheckoutUnmanagedIntent = Extract<
  ThreadProvisionEnvironmentIntent,
  { type: "checkout-unmanaged" }
>;
type NewThreadProvisionEnvironmentIntent = Exclude<
  ThreadProvisionEnvironmentIntent,
  { type: "reuse" } | { type: "checkout-unmanaged" }
>;

const INITIAL_PROVISIONING_TEXT_BY_WORKSPACE_TYPE = {
  unmanaged: "Preparing workspace",
  "managed-worktree": "Preparing worktree",
  personal: "Preparing personal workspace",
} satisfies Record<Environment["workspaceProvisionType"], string>;

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
  environment: Environment;
  thread: Thread;
}

interface AttachThreadToEnvironmentArgs {
  context: ThreadProvisionAttachableContext;
  environment: Environment;
  thread: Thread;
}

interface BuildEnvironmentProvisionRequestArgs {
  context: ThreadProvisionEnvironmentProvisioningContext;
  environment: Environment;
}

interface BuildUnmanagedCheckoutArgs {
  branch: UnmanagedBranchSpec;
  branchPrefix: string;
  context: ThreadProvisionEnvironmentProvisioningContext;
  thread: Thread;
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

interface CreatePreparedProvisioningEnvironmentArgs {
  context: ThreadProvisionMetadataPendingContext;
  environmentInput: CreateEnvironmentInput;
  thread: Thread;
}

interface ThreadProvisioningResult {
  context: ThreadProvisionContext;
  environment: Environment;
  provisionRequest?: EnvironmentProvisionRequest | null;
}

interface ResolveEnvironmentCreationPlanArgs {
  intent: NewThreadProvisionEnvironmentIntent;
  thread: Thread;
}

interface RequestPreparedEnvironmentProvisionArgs {
  context: ThreadProvisionEnvironmentPreparedContext;
  thread: Thread;
}

interface DirectUnmanagedEnvironmentPlanArgs {
  branchPrefix: string;
  intent: DirectUnmanagedIntent;
  thread: Thread;
}

interface CheckoutUnmanagedEnvironmentArgs {
  context: ThreadProvisionContext;
  intent: CheckoutUnmanagedIntent;
  thread: Thread;
}

interface QueueCheckoutUnmanagedEnvironmentArgs {
  context: ThreadProvisionProvisionableContext;
  environment: Environment;
  intent: CheckoutUnmanagedIntent;
  thread: Thread;
}

interface RequestCheckoutUnmanagedEnvironmentProvisionArgs {
  context: ThreadProvisionProvisionableContext;
  environment: Environment;
  intent: CheckoutUnmanagedIntent;
  thread: Thread;
}

type CheckoutUnmanagedEnvironmentProvisionResult =
  | {
      context: ThreadProvisionEnvironmentProvisioningContext;
      environment: Environment;
      eventAppended: boolean;
      kind: "queued";
    }
  | { kind: "active-provision" };

interface ManagedEnvironmentPlanArgs {
  branchPrefix: string;
  dataDir: string;
  hostId: string;
  sourcePath: string;
  baseBranch: BaseBranchSpec;
  thread: Thread;
  workspaceProvisionType: "managed-worktree";
}

interface PersonalEnvironmentPlanArgs {
  dataDir: string;
  hostId: string;
  thread: Thread;
  workspaceProvisionType: "personal";
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
  environment: Environment;
  thread: Thread;
}

function initialProvisioningEntries(
  environment: Pick<Environment, "workspaceProvisionType">,
): ProvisioningTranscriptEntry[] {
  return [
    {
      type: "step",
      key: "workspace-started",
      text: INITIAL_PROVISIONING_TEXT_BY_WORKSPACE_TYPE[
        environment.workspaceProvisionType
      ],
      status: "started",
    },
  ];
}

export function loadActiveThreadProvisionContext(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ThreadProvisionContext | null {
  const thread = getThread(deps.db, threadId);
  const context = getActiveThreadProvisionContext(threadId);
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
  forgetActiveThreadProvisionContext(args.thread.id);
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

function hasActiveEnvironmentProvision(environment: Environment): boolean {
  return environment.status === "provisioning";
}

function shouldPrepareEnvironmentBeforeMetadata(
  context: ThreadProvisionContext,
): context is ThreadProvisionMetadataPendingContext {
  return (
    isMetadataPendingContext(context) &&
    context.request.environmentIntent.type === "direct-managed" &&
    !context.request.titleProvided
  );
}

async function resolveMetadataIfNeeded(
  deps: ThreadProvisioningDeps,
  args: ResolveMetadataIfNeededArgs,
): Promise<ThreadProvisionContext> {
  if (isEnvironmentPreparedContext(args.context)) {
    if (
      args.context.request.environmentIntent.type !== "direct-managed" ||
      args.context.request.titleProvided
    ) {
      return args.context;
    }

    const metadata = await inferThreadMetadata(deps, {
      environmentId: args.context.state.environmentId,
      generateBranchName: true,
      input: args.context.request.input,
      provisioningId: args.context.state.provisioningId,
      threadId: args.thread.id,
      writeTranscript: true,
    });

    const resolvedContext = resolvePreparedEnvironmentMetadata(args.context, {
      branchSlug: metadata.branchSlug,
    });
    rememberActiveThreadProvisionContext({
      threadId: args.thread.id,
      context: resolvedContext,
    });
    return resolvedContext;
  }

  if (!isMetadataPendingContext(args.context)) {
    return args.context;
  }

  const needsBranch =
    args.context.request.environmentIntent.type === "direct-managed";
  if (!needsBranch) {
    if (!args.context.request.titleProvided) {
      void inferThreadMetadata(deps, {
        environmentId: null,
        generateBranchName: false,
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
    const resolvedContext = createEnvironmentPendingContext(args.context, {
      branchSlug: null,
    });
    rememberActiveThreadProvisionContext({
      threadId: args.thread.id,
      context: resolvedContext,
    });
    return resolvedContext;
  }

  if (args.context.request.titleProvided) {
    const resolvedContext = createEnvironmentPendingContext(args.context, {
      branchSlug: args.thread.title
        ? sanitizeGeneratedBranchSlug(args.thread.title)
        : null,
    });
    rememberActiveThreadProvisionContext({
      threadId: args.thread.id,
      context: resolvedContext,
    });
    return resolvedContext;
  }

  const metadata = await inferThreadMetadata(deps, {
    environmentId: null,
    generateBranchName: needsBranch,
    input: args.context.request.input,
    provisioningId: args.context.state.provisioningId,
    threadId: args.thread.id,
    writeTranscript: false,
  });

  const resolvedContext = createEnvironmentPendingContext(args.context, {
    branchSlug: metadata.branchSlug,
  });
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
    entries: initialProvisioningEntries(args.environment),
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
        entries: initialProvisioningEntries(environment),
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

function createPreparedProvisioningEnvironment(
  deps: ThreadProvisionWriteDeps,
  args: CreatePreparedProvisioningEnvironmentArgs,
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
      if (!isMetadataPendingContext(activeContext)) {
        throw new Error(
          `Cannot prepare environment from ${activeContext.state.stage} state`,
        );
      }

      const environment = createEnvironment(tx, deps.hub, {
        ...args.environmentInput,
        status: "ready",
      });
      if (args.thread.environmentId !== environment.id) {
        updateThread(tx, deps.hub, args.thread.id, {
          environmentId: environment.id,
        });
      }

      const appendedSequence = appendThreadProvisioningEventInTransaction(tx, {
        threadId: args.thread.id,
        environmentId: environment.id,
        provisioningId: activeContext.state.provisioningId,
        status: "active",
        entries: initialProvisioningEntries(environment),
      });
      const context = createEnvironmentPreparedContext(activeContext, {
        attachedEnvironmentId: environment.id,
        provisionEventSequence: appendedSequence,
      });
      rememberActiveThreadProvisionContext({
        threadId: args.thread.id,
        context,
      });
      return { context, environment };
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"], {
    eventTypes: ["system/thread-provisioning"],
  });
  return result;
}

function buildUnmanagedCheckout(
  args: BuildUnmanagedCheckoutArgs,
): UnmanagedCheckoutCommand {
  if (args.branch.kind === "existing") {
    return {
      kind: "existing",
      name: args.branch.name,
    };
  }

  return {
    kind: "new",
    name: buildManagedBranchName({
      branchPrefix: args.branchPrefix,
      branchSlug: args.context.request.branchSlug,
      threadId: args.thread.id,
    }),
    baseBranch: args.branch.baseBranch,
  };
}

function buildCheckoutUnmanagedEnvironmentProvisionRequest(
  args: BuildEnvironmentProvisionRequestArgs & {
    branchPrefix: string;
    intent: CheckoutUnmanagedIntent;
    thread: Thread;
  },
): EnvironmentProvisionRequest {
  const checkout = buildUnmanagedCheckout({
    branch: args.intent.branch,
    branchPrefix: args.branchPrefix,
    context: args.context,
    thread: args.thread,
  });
  const command = buildEnvironmentProvisionCommand({
    environmentId: args.environment.id,
    hostId: args.intent.hostId,
    initiator: {
      threadId: args.thread.id,
      provisioningId: args.context.state.provisioningId,
    },
    path: args.intent.path,
    workspaceProvisionType: "unmanaged",
    checkout,
  });

  return { command };
}

function buildDirectUnmanagedEnvironmentPlan(
  args: DirectUnmanagedEnvironmentPlanArgs,
): ThreadProvisionEnvironmentPlan {
  return {
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.intent.hostId,
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    },
    buildRequest: ({ context, environment }) => {
      const checkout = args.intent.branch
        ? buildUnmanagedCheckout({
            branch: args.intent.branch,
            branchPrefix: args.branchPrefix,
            context,
            thread: args.thread,
          })
        : undefined;
      return {
        command: buildEnvironmentProvisionCommand({
          environmentId: environment.id,
          hostId: args.intent.hostId,
          initiator: {
            threadId: args.thread.id,
            provisioningId: context.state.provisioningId,
          },
          path: args.intent.path,
          workspaceProvisionType: "unmanaged",
          ...(checkout ? { checkout } : {}),
        }),
      };
    },
  };
}

function buildManagedEnvironmentPlan(
  args: ManagedEnvironmentPlanArgs,
): ThreadProvisionEnvironmentPlan {
  return {
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.hostId,
      managed: true,
      workspaceProvisionType: args.workspaceProvisionType,
      baseBranch: baseBranchSpecToStoredName(args.baseBranch),
      status: "provisioning",
    },
    buildRequest: ({ context, environment }) => {
      const command = buildEnvironmentProvisionCommand({
        branchName: buildManagedBranchName({
          branchPrefix: args.branchPrefix,
          branchSlug: context.request.branchSlug,
          threadId: args.thread.id,
        }),
        baseBranch: args.baseBranch,
        environmentId: environment.id,
        hostId: args.hostId,
        initiator: {
          threadId: args.thread.id,
          provisioningId: context.state.provisioningId,
        },
        sourcePath: args.sourcePath,
        targetPath: resolveManagedTargetPath({
          dataDir: args.dataDir,
          environmentId: environment.id,
          sourcePath: args.sourcePath,
        }),
        workspaceProvisionType: args.workspaceProvisionType,
        setupTimeoutMs: SETUP_TIMEOUT_MS,
      });

      return { command };
    },
  };
}

function buildPersonalEnvironmentPlan(
  args: PersonalEnvironmentPlanArgs,
): ThreadProvisionEnvironmentPlan {
  return {
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.hostId,
      managed: true,
      workspaceProvisionType: args.workspaceProvisionType,
      status: "provisioning",
    },
    buildRequest: ({ context, environment }) => ({
      command: buildEnvironmentProvisionCommand({
        environmentId: environment.id,
        hostId: args.hostId,
        initiator: {
          threadId: args.thread.id,
          provisioningId: context.state.provisioningId,
        },
        targetPath: resolvePersonalTargetPath({
          dataDir: args.dataDir,
          environmentId: environment.id,
        }),
        workspaceProvisionType: args.workspaceProvisionType,
      }),
    }),
  };
}

async function resolveEnvironmentCreationPlan(
  deps: ThreadProvisioningDeps,
  args: ResolveEnvironmentCreationPlanArgs,
): Promise<ThreadProvisionEnvironmentPlan> {
  switch (args.intent.type) {
    case "direct-unmanaged":
      return buildDirectUnmanagedEnvironmentPlan({
        branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
        intent: args.intent,
        thread: args.thread,
      });
    case "direct-managed": {
      const hostSession = await ensureHostSessionReadyForWork(deps, {
        hostId: args.intent.hostId,
      });
      return buildManagedEnvironmentPlan({
        branchPrefix: getAppSettings(deps.db).managedBranchPrefix,
        dataDir: hostSession.dataDir,
        hostId: args.intent.hostId,
        sourcePath: args.intent.sourcePath,
        baseBranch: args.intent.baseBranch,
        thread: args.thread,
        workspaceProvisionType: args.intent.workspaceProvisionType,
      });
    }
    case "direct-personal": {
      const hostSession = await ensureHostSessionReadyForWork(deps, {
        hostId: args.intent.hostId,
      });
      return buildPersonalEnvironmentPlan({
        dataDir: hostSession.dataDir,
        hostId: args.intent.hostId,
        thread: args.thread,
        workspaceProvisionType: args.intent.workspaceProvisionType,
      });
    }
  }
  const _exhaustive: never = args.intent;
  return _exhaustive;
}

function requestCheckoutUnmanagedEnvironmentProvision(
  deps: ThreadProvisionWriteDeps,
  args: RequestCheckoutUnmanagedEnvironmentProvisionArgs,
): CheckoutUnmanagedEnvironmentProvisionResult {
  const branchPrefix = getAppSettings(deps.db).managedBranchPrefix;
  return deps.db.transaction(
    (tx) => {
      if (hasActiveEnvironmentProvision(args.environment)) {
        return { kind: "active-provision" };
      }

      const activeThread = getThread(tx, args.thread.id);
      const activeContext = getActiveThreadProvisionContext(args.thread.id);
      if (
        !activeThread ||
        activeThread.status !== "starting" ||
        !activeContext ||
        !isProvisionableContext(activeContext) ||
        activeContext.state.environmentId !== args.environment.id ||
        activeContext.state.provisioningId !== args.context.state.provisioningId
      ) {
        throw new Error("Thread provisioning context is no longer active");
      }

      const eventAppended = !isEnvironmentProvisioningContext(activeContext);
      const context = isEnvironmentProvisioningContext(activeContext)
        ? activeContext
        : createEnvironmentProvisioningContext(activeContext, {
            provisionEventSequence: appendThreadProvisioningEventInTransaction(
              tx,
              {
                threadId: args.thread.id,
                environmentId: args.environment.id,
                provisioningId: activeContext.state.provisioningId,
                status: "active",
                entries: initialProvisioningEntries(args.environment),
              },
            ),
          });
      const request = buildCheckoutUnmanagedEnvironmentProvisionRequest({
        branchPrefix,
        context,
        environment: args.environment,
        intent: args.intent,
        thread: args.thread,
      });

      rememberActiveThreadProvisionContext({
        threadId: args.thread.id,
        context,
      });
      const requestedOutcome =
        applyLoggedEnvironmentLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          {
            environmentId: args.environment.id,
            event: { type: "provision.requested" },
          },
        );
      if (requestedOutcome.applied) {
        deps.hub.notifyEnvironment(
          args.environment.id,
          requestedOutcome.changes,
        );
      }

      return {
        kind: "queued",
        context,
        eventAppended,
        environment:
          getEnvironment(tx, args.environment.id) ?? args.environment,
        provisionRequest: request,
      };
    },
    { behavior: "immediate" },
  );
}

function queueCheckoutUnmanagedEnvironment(
  deps: ThreadProvisioningDeps,
  args: QueueCheckoutUnmanagedEnvironmentArgs,
): ThreadProvisioningResult {
  const result = requestCheckoutUnmanagedEnvironmentProvision(deps, {
    context: args.context,
    environment: args.environment,
    intent: args.intent,
    thread: args.thread,
  });

  if (result.kind === "active-provision") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment already has an active provision",
    });
    return {
      context: args.context,
      environment: args.environment,
    };
  }

  if (result.eventAppended) {
    deps.hub.notifyThread(args.thread.id, ["events-appended"], {
      eventTypes: ["system/thread-provisioning"],
    });
  }
  return result;
}

async function requestPreparedEnvironmentProvision(
  deps: ThreadProvisioningDeps,
  args: RequestPreparedEnvironmentProvisionArgs,
): Promise<ThreadProvisioningResult> {
  const intent = args.context.request.environmentIntent;
  if (intent.type === "reuse" || intent.type === "checkout-unmanaged") {
    throw new Error(`Cannot provision prepared ${intent.type} environment`);
  }

  const plan = await resolveEnvironmentCreationPlan(deps, {
    intent,
    thread: args.thread,
  });

  return deps.db.transaction(
    (tx) => {
      const activeThread = getThread(tx, args.thread.id);
      const activeContext = getActiveThreadProvisionContext(args.thread.id);
      if (
        !activeThread ||
        activeThread.status !== "starting" ||
        !activeContext ||
        !isEnvironmentPreparedContext(activeContext) ||
        activeContext.state.environmentId !==
          args.context.state.environmentId ||
        activeContext.state.provisioningId !== args.context.state.provisioningId
      ) {
        throw new Error("Thread provisioning context is no longer active");
      }

      const environment = getEnvironment(tx, activeContext.state.environmentId);
      if (!environment) {
        throw new ApiError(
          404,
          "environment_not_found",
          "Environment not found",
        );
      }

      const context = createEnvironmentProvisioningContext(activeContext, {
        provisionEventSequence: activeContext.state.provisionEventSequence,
      });
      rememberActiveThreadProvisionContext({
        threadId: args.thread.id,
        context,
      });
      const provisionRequest = plan.buildRequest({
        context,
        environment,
      });
      const requestedOutcome =
        applyLoggedEnvironmentLifecycleEventInTransaction(
          { db: tx, logger: deps.logger },
          {
            environmentId: environment.id,
            event: { type: "provision.requested" },
          },
        );
      if (requestedOutcome.applied) {
        deps.hub.notifyEnvironment(environment.id, requestedOutcome.changes);
      }
      return {
        context,
        environment: getEnvironment(tx, environment.id) ?? environment,
        provisionRequest,
      };
    },
    { behavior: "immediate" },
  );
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

function ensureCheckoutUnmanagedEnvironmentRequested(
  deps: ThreadProvisioningDeps,
  args: CheckoutUnmanagedEnvironmentArgs,
): ThreadProvisioningResult {
  if (!isAttachableContext(args.context)) {
    throw new Error(
      `Cannot request environment from ${args.context.state.stage} state`,
    );
  }

  const environment = getEnvironment(deps.db, args.intent.environmentId);
  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  if (environment.projectId !== args.thread.projectId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different project",
    );
  }
  if (environment.hostId !== args.intent.hostId) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment belongs to a different host",
    );
  }
  if (environment.path !== args.intent.path) {
    throw new ApiError(
      409,
      "invalid_request",
      "Environment path changed before checkout reconciliation",
    );
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

  const startedContext = provisioningStartedContext(context);
  if (startedContext) {
    if (
      isEnvironmentProvisioningContext(startedContext) &&
      environment.status === "ready" &&
      environment.path
    ) {
      return queueCheckoutUnmanagedEnvironment(deps, {
        context: startedContext,
        environment,
        intent: args.intent,
        thread: args.thread,
      });
    }
    return {
      context: startedContext,
      environment,
    };
  }

  if (environment.status !== "ready" || !environment.path) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: environment.id,
      detail: `Environment is ${environment.status}`,
    });
    return { context, environment };
  }

  return queueCheckoutUnmanagedEnvironment(deps, {
    context,
    environment,
    intent: args.intent,
    thread: args.thread,
  });
}

async function ensureEnvironmentRequested(
  deps: ThreadProvisioningDeps,
  args: EnsureEnvironmentRequestedArgs,
): Promise<ThreadProvisioningResult> {
  if (isEnvironmentPreparedContext(args.context)) {
    return requestPreparedEnvironmentProvision(deps, {
      context: args.context,
      thread: args.thread,
    });
  }

  if (!isAttachableContext(args.context)) {
    throw new Error(
      `Cannot request environment from ${args.context.state.stage} state`,
    );
  }

  if (args.context.request.environmentIntent.type === "checkout-unmanaged") {
    return ensureCheckoutUnmanagedEnvironmentRequested(deps, {
      context: args.context,
      intent: args.context.request.environmentIntent,
      thread: args.thread,
    });
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
    thread: args.thread,
  });
  return createProvisioningEnvironment(deps, {
    context: args.context,
    thread: args.thread,
    ...plan,
  });
}

export async function ensureThreadProvisionEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnsureThreadProvisionEnvironmentReadyArgs,
): Promise<ThreadProvisionReadyEnvironment> {
  let preparedContext = args.context;
  if (shouldPrepareEnvironmentBeforeMetadata(args.context)) {
    const intent = args.context.request.environmentIntent;
    if (intent.type !== "direct-managed") {
      throw new Error(
        `Cannot prepare ${intent.type} environment before metadata`,
      );
    }
    const plan = await resolveEnvironmentCreationPlan(deps, {
      intent,
      thread: args.thread,
    });
    preparedContext = createPreparedProvisioningEnvironment(deps, {
      context: args.context,
      environmentInput: plan.environmentInput,
      thread: args.thread,
    }).context;
  }
  const context = await resolveMetadataIfNeeded(deps, {
    context: preparedContext,
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
