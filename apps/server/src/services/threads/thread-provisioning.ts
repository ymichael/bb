import { z } from "zod";
import {
  createEnvironment,
  createHostId,
  type CreateEnvironmentInput,
  type UpsertHostInput,
  getEnvironment,
  getEnvironmentOperation,
  getThread,
  getThreadOperation,
  updateThread,
  upsertHost,
} from "@bb/db";
import {
  markThreadOperationRecordCompleted,
  markThreadOperationRecordFailed,
  upsertEnvironmentOperationRecord,
  upsertThreadOperationRecord,
} from "@bb/db/internal-lifecycle";
import {
  isActiveLifecycleOperationState,
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
  type Environment,
  type PromptInput,
  type ProvisioningTranscriptEntry,
  type ResolvedThreadExecutionOptions,
  type Thread,
  type ThreadTurnInitiator,
} from "@bb/domain";
import { SANDBOX_DATA_DIR } from "@bb/sandbox-host";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  advanceEnvironmentProvisioning,
} from "../environments/environment-provisioning.js";
import {
  buildDirectEnvironmentProvisionRequest,
  buildSandboxHostEnvironmentProvisionRequest,
} from "../environments/environment-provision-request.js";
import {
  buildEnvironmentProvisionCommand,
  buildManagedBranchName,
  SETUP_TIMEOUT_MS,
} from "./thread-create-helpers.js";
import { queueThreadRenameCommand } from "./thread-commands.js";
import {
  appendClientTurnEvent,
  appendSystemErrorEvent,
  appendThreadProvisioningEvent,
  appendThreadProvisioningEventInTransaction,
  buildCwdBranchEntries,
} from "./thread-events.js";
import {
  inferThreadMetadata,
  MANAGED_THREAD_METADATA_TIMEOUT_MS,
} from "./thread-metadata-inference.js";
import { resolveManagedTargetPath } from "./worktree-paths.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { requestThreadStart } from "./thread-lifecycle.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { parseJsonWithSchema } from "../lib/json-parsing.js";
import { tryTransition } from "./thread-transitions.js";
import { createAsyncDeduper } from "../lib/async-deduper.js";

type ThreadProvisioningDeps = Pick<
  AppDeps,
  | "cloudAuth"
  | "config"
  | "db"
  | "hostLifecycle"
  | "hub"
  | "logger"
  | "machineAuth"
  | "sandboxEnv"
  | "sandboxRegistry"
>;

const directUnmanagedIntentSchema = z.object({
  type: z.literal("direct-unmanaged"),
  hostId: z.string().min(1),
  path: z.string().min(1),
});

const directManagedIntentSchema = z.object({
  type: z.literal("direct-managed"),
  hostId: z.string().min(1),
  sourcePath: z.string().min(1),
  workspaceProvisionType: z.enum(["managed-worktree", "managed-clone"]),
});

const sandboxManagedIntentSchema = z.object({
  type: z.literal("sandbox-managed"),
  cloneRepoUrl: z.string().min(1),
  sandboxType: z.string().min(1),
});

const reuseIntentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

const threadProvisionEnvironmentIntentSchema = z.discriminatedUnion("type", [
  directUnmanagedIntentSchema,
  directManagedIntentSchema,
  sandboxManagedIntentSchema,
  reuseIntentSchema,
]);

const threadProvisionCommonPayloadSchema = z.object({
  clientRequestSequence: z.number().int().nonnegative(),
  environmentIntent: threadProvisionEnvironmentIntentSchema,
  execution: resolvedThreadExecutionOptionsSchema,
  input: z.array(promptInputSchema),
  titleProvided: z.boolean(),
});

const threadProvisionMetadataPendingPayloadSchema =
  threadProvisionCommonPayloadSchema.extend({
    stage: z.literal("metadata-pending"),
  });

const threadProvisionEnvironmentPendingPayloadSchema =
  threadProvisionCommonPayloadSchema.extend({
    stage: z.literal("environment-pending"),
    branchSlug: z.string().nullable(),
  });

const threadProvisionEnvironmentAttachedPayloadSchema =
  threadProvisionCommonPayloadSchema.extend({
    stage: z.literal("environment-attached"),
    attachedEnvironmentId: z.string().min(1),
    branchSlug: z.string().nullable(),
  });

const threadProvisionEnvironmentProvisioningPayloadSchema =
  threadProvisionCommonPayloadSchema.extend({
    stage: z.literal("environment-provisioning"),
    attachedEnvironmentId: z.string().min(1),
    branchSlug: z.string().nullable(),
    provisionEventSequence: z.number().int().nonnegative(),
  });

const threadProvisionWorkspaceReadyPayloadSchema =
  threadProvisionCommonPayloadSchema.extend({
    stage: z.literal("workspace-ready"),
    attachedEnvironmentId: z.string().min(1),
    branchSlug: z.string().nullable(),
    provisionEventSequence: z.number().int().nonnegative().nullable(),
    workspaceReadyEventSequence: z.number().int().nonnegative(),
  });

const threadProvisionPayloadSchema = z.discriminatedUnion("stage", [
  threadProvisionMetadataPendingPayloadSchema,
  threadProvisionEnvironmentPendingPayloadSchema,
  threadProvisionEnvironmentAttachedPayloadSchema,
  threadProvisionEnvironmentProvisioningPayloadSchema,
  threadProvisionWorkspaceReadyPayloadSchema,
]);

const ACTIVE_DIRECT_ENVIRONMENT_OPERATION_KINDS = [
  "provision",
  "reprovision",
] as const;

const threadProvisionAdvanceDeduper = createAsyncDeduper<string, void>();

type ThreadProvisionEnvironmentIntent = z.infer<
  typeof threadProvisionEnvironmentIntentSchema
>;
type ThreadProvisionPayload = z.infer<typeof threadProvisionPayloadSchema>;
type ThreadProvisionMetadataPendingPayload = z.infer<
  typeof threadProvisionMetadataPendingPayloadSchema
>;
type ThreadProvisionEnvironmentPendingPayload = z.infer<
  typeof threadProvisionEnvironmentPendingPayloadSchema
>;
type ThreadProvisionEnvironmentAttachedPayload = z.infer<
  typeof threadProvisionEnvironmentAttachedPayloadSchema
>;
type ThreadProvisionEnvironmentProvisioningPayload = z.infer<
  typeof threadProvisionEnvironmentProvisioningPayloadSchema
>;
type ThreadProvisionWorkspaceReadyPayload = z.infer<
  typeof threadProvisionWorkspaceReadyPayloadSchema
>;
type ThreadProvisionAttachablePayload =
  | ThreadProvisionEnvironmentPendingPayload
  | ThreadProvisionEnvironmentAttachedPayload
  | ThreadProvisionEnvironmentProvisioningPayload
  | ThreadProvisionWorkspaceReadyPayload;
type ThreadProvisionProvisionablePayload =
  | ThreadProvisionEnvironmentAttachedPayload
  | ThreadProvisionEnvironmentProvisioningPayload
  | ThreadProvisionWorkspaceReadyPayload;
type DirectManagedIntent = z.infer<typeof directManagedIntentSchema>;
type SandboxManagedIntent = z.infer<typeof sandboxManagedIntentSchema>;
type DirectUnmanagedIntent = z.infer<typeof directUnmanagedIntentSchema>;

export interface RequestThreadProvisionArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  thread: Thread;
  titleProvided: boolean;
}

export interface RequestThreadReprovisionArgs {
  environment: Environment;
  eventSequence: number;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  initiator: ThreadTurnInitiator;
  thread: Thread;
}

export interface AdvanceThreadProvisioningArgs {
  threadId: string;
}

export interface RecordThreadProvisionWorkspaceReadyArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  threadId: string;
}

interface EnsureWorkspaceReadyEventArgs {
  entries: ProvisioningTranscriptEntry[];
  environmentId: string;
  threadId: string;
}

interface BuildEnvironmentProvisionRequestArgs {
  environment: Environment;
  eventSequence: number;
  payload: ThreadProvisionEnvironmentProvisioningPayload;
}

interface CreateProvisioningEnvironmentWithOperationArgs {
  buildRequest: (args: BuildEnvironmentProvisionRequestArgs) =>
    | ReturnType<typeof buildDirectEnvironmentProvisionRequest>
    | ReturnType<typeof buildSandboxHostEnvironmentProvisionRequest>;
  environmentInput: CreateEnvironmentInput;
  hostInput: UpsertHostInput | null;
  payload: ThreadProvisionEnvironmentPendingPayload;
  thread: Thread;
}

interface ThreadProvisioningResult {
  environment: Environment;
  payload: ThreadProvisionPayload;
}

interface SaveThreadProvisionPayloadArgs {
  payload: ThreadProvisionPayload;
  threadId: string;
}

interface FailThreadProvisioningArgs {
  detail: string;
  environmentId: string | null;
  thread: Thread;
}

interface ResolveMetadataIfNeededArgs {
  payload: ThreadProvisionPayload;
  thread: Thread;
}

interface EnvironmentPayloadThreadArgs {
  environment: Environment;
  payload: ThreadProvisionProvisionablePayload;
  thread: Thread;
}

interface AttachThreadToEnvironmentArgs {
  environment: Environment;
  payload: ThreadProvisionAttachablePayload;
  thread: Thread;
}

interface DirectUnmanagedEnvironmentArgs {
  intent: DirectUnmanagedIntent;
  payload: ThreadProvisionEnvironmentPendingPayload;
  thread: Thread;
}

interface DirectManagedEnvironmentArgs {
  intent: DirectManagedIntent;
  payload: ThreadProvisionEnvironmentPendingPayload;
  thread: Thread;
}

interface SandboxManagedEnvironmentArgs {
  intent: SandboxManagedIntent;
  payload: ThreadProvisionEnvironmentPendingPayload;
  thread: Thread;
}

interface EnsureEnvironmentRequestedArgs {
  payload: ThreadProvisionPayload;
  thread: Thread;
}

function attachedEnvironmentIdForPayload(
  payload: ThreadProvisionPayload,
): string | null {
  switch (payload.stage) {
    case "metadata-pending":
    case "environment-pending":
      return null;
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return payload.attachedEnvironmentId;
  }
}

function provisionEventSequenceForPayload(
  payload: ThreadProvisionProvisionablePayload,
): number | null {
  switch (payload.stage) {
    case "environment-attached":
      return null;
    case "environment-provisioning":
    case "workspace-ready":
      return payload.provisionEventSequence;
  }
}

function isAttachablePayload(
  payload: ThreadProvisionPayload,
): payload is ThreadProvisionAttachablePayload {
  switch (payload.stage) {
    case "metadata-pending":
      return false;
    case "environment-pending":
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return true;
  }
}

function isProvisionablePayload(
  payload: ThreadProvisionPayload,
): payload is ThreadProvisionProvisionablePayload {
  switch (payload.stage) {
    case "metadata-pending":
    case "environment-pending":
      return false;
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return true;
  }
}

function createMetadataPendingPayload(
  args: RequestThreadProvisionArgs & { clientRequestSequence: number },
): ThreadProvisionMetadataPendingPayload {
  return {
    clientRequestSequence: args.clientRequestSequence,
    environmentIntent: args.environmentIntent,
    execution: args.execution,
    input: args.input,
    stage: "metadata-pending",
    titleProvided: args.titleProvided,
  };
}

function createEnvironmentPendingPayload(
  payload: ThreadProvisionMetadataPendingPayload,
  args: { branchSlug: string | null },
): ThreadProvisionEnvironmentPendingPayload {
  return {
    branchSlug: args.branchSlug,
    clientRequestSequence: payload.clientRequestSequence,
    environmentIntent: payload.environmentIntent,
    execution: payload.execution,
    input: payload.input,
    stage: "environment-pending",
    titleProvided: payload.titleProvided,
  };
}

function createEnvironmentAttachedPayload(
  payload: ThreadProvisionAttachablePayload,
  args: { attachedEnvironmentId: string },
): ThreadProvisionEnvironmentAttachedPayload {
  return {
    attachedEnvironmentId: args.attachedEnvironmentId,
    branchSlug: payload.branchSlug,
    clientRequestSequence: payload.clientRequestSequence,
    environmentIntent: payload.environmentIntent,
    execution: payload.execution,
    input: payload.input,
    stage: "environment-attached",
    titleProvided: payload.titleProvided,
  };
}

function createEnvironmentProvisioningPayload(
  payload: ThreadProvisionProvisionablePayload,
  args: { provisionEventSequence: number },
): ThreadProvisionEnvironmentProvisioningPayload {
  return {
    attachedEnvironmentId: payload.attachedEnvironmentId,
    branchSlug: payload.branchSlug,
    clientRequestSequence: payload.clientRequestSequence,
    environmentIntent: payload.environmentIntent,
    execution: payload.execution,
    input: payload.input,
    provisionEventSequence: args.provisionEventSequence,
    stage: "environment-provisioning",
    titleProvided: payload.titleProvided,
  };
}

function createReprovisioningPayload(
  args: RequestThreadReprovisionArgs & { clientRequestSequence: number },
): ThreadProvisionEnvironmentProvisioningPayload {
  return {
    attachedEnvironmentId: args.environment.id,
    branchSlug: null,
    environmentIntent: {
      type: "reuse",
      environmentId: args.environment.id,
    },
    clientRequestSequence: args.clientRequestSequence,
    execution: args.execution,
    input: args.input,
    provisionEventSequence: args.eventSequence,
    stage: "environment-provisioning",
    titleProvided: true,
  };
}

function createWorkspaceReadyPayload(
  payload: ThreadProvisionProvisionablePayload,
  args: { workspaceReadyEventSequence: number },
): ThreadProvisionWorkspaceReadyPayload {
  return {
    attachedEnvironmentId: payload.attachedEnvironmentId,
    branchSlug: payload.branchSlug,
    clientRequestSequence: payload.clientRequestSequence,
    environmentIntent: payload.environmentIntent,
    execution: payload.execution,
    input: payload.input,
    provisionEventSequence: provisionEventSequenceForPayload(payload),
    stage: "workspace-ready",
    titleProvided: payload.titleProvided,
    workspaceReadyEventSequence: args.workspaceReadyEventSequence,
  };
}

function provisionablePayloadForWorkspaceReady(
  payload: ThreadProvisionAttachablePayload,
  args: { attachedEnvironmentId: string },
): ThreadProvisionProvisionablePayload {
  switch (payload.stage) {
    case "environment-pending":
      return createEnvironmentAttachedPayload(payload, args);
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return payload;
  }
}

function provisioningStartedPayload(
  payload: ThreadProvisionProvisionablePayload,
): ThreadProvisionEnvironmentProvisioningPayload | ThreadProvisionWorkspaceReadyPayload | null {
  switch (payload.stage) {
    case "environment-attached":
      return null;
    case "environment-provisioning":
    case "workspace-ready":
      return payload;
  }
}

function initialProvisioningEntries(
  environment: Pick<Environment, "workspaceProvisionType">,
): ProvisioningTranscriptEntry[] {
  switch (environment.workspaceProvisionType) {
    case "unmanaged":
      return [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing workspace",
          status: "started",
        },
      ];
    case "managed-worktree":
      return [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing worktree",
          status: "started",
        },
      ];
    case "managed-clone":
      return [
        {
          type: "step",
          key: "workspace-started",
          text: "Preparing clone",
          status: "started",
        },
      ];
  }
}

function loadActiveThreadProvisionPayload(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): ThreadProvisionPayload | null {
  const operation = getThreadOperation(deps.db, {
    threadId,
    kind: "provision",
  });
  if (!operation || !isActiveLifecycleOperationState(operation.state)) {
    return null;
  }
  return parseJsonWithSchema(operation.payload, threadProvisionPayloadSchema);
}

function saveThreadProvisionPayload(
  deps: Pick<AppDeps, "db">,
  args: SaveThreadProvisionPayloadArgs,
): void {
  upsertThreadOperationRecord(deps.db, {
    threadId: args.threadId,
    kind: "provision",
    payload: JSON.stringify(args.payload),
  });
}

function ensureWorkspaceReadyEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EnsureWorkspaceReadyEventArgs,
): number | null {
  const result = deps.db.transaction(
    (tx) => {
      const operation = getThreadOperation(tx, {
        threadId: args.threadId,
        kind: "provision",
      });
      if (!operation || !isActiveLifecycleOperationState(operation.state)) {
        return null;
      }
      const payload = parseJsonWithSchema(
        operation.payload,
        threadProvisionPayloadSchema,
      );
      if (payload.stage === "workspace-ready") {
        return payload.workspaceReadyEventSequence;
      }
      if (!isAttachablePayload(payload)) {
        return null;
      }
      const provisionablePayload = provisionablePayloadForWorkspaceReady(payload, {
        attachedEnvironmentId: args.environmentId,
      });

      const eventSequence = appendThreadProvisioningEventInTransaction(tx, {
        threadId: args.threadId,
        environmentId: args.environmentId,
        status: "active",
        entries: args.entries,
      });
      upsertThreadOperationRecord(tx, {
        threadId: args.threadId,
        kind: "provision",
        payload: JSON.stringify(createWorkspaceReadyPayload(provisionablePayload, {
          workspaceReadyEventSequence: eventSequence,
        })),
      });
      return eventSequence;
    },
    { behavior: "immediate" },
  );

  if (result !== null) {
    deps.hub.notifyThread(args.threadId, ["events-appended"]);
  }
  return result;
}

function completeThreadProvisioning(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): void {
  markThreadOperationRecordCompleted(deps.db, {
    threadId,
    kind: "provision",
  });
}

function failThreadProvisioning(
  deps: Pick<AppDeps, "db" | "hub">,
  args: FailThreadProvisioningArgs,
): void {
  markThreadOperationRecordFailed(deps.db, {
    threadId: args.thread.id,
    kind: "provision",
    failureReason: args.detail,
  });
  appendSystemErrorEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environmentId,
    code: "thread_provisioning_failed",
    message: "Provisioning thread failed",
    detail: args.detail,
  });
  tryTransition(deps.db, deps.hub, args.thread.id, "error");
}

function hasActiveEnvironmentProvisionOperation(
  deps: Pick<AppDeps, "db">,
  environment: Environment,
): boolean {
  return ACTIVE_DIRECT_ENVIRONMENT_OPERATION_KINDS.some((kind) => {
    const operation = getEnvironmentOperation(deps.db, {
      environmentId: environment.id,
      kind,
    });
    return Boolean(operation && isActiveLifecycleOperationState(operation.state));
  });
}

async function resolveMetadataIfNeeded(
  deps: ThreadProvisioningDeps,
  args: ResolveMetadataIfNeededArgs,
): Promise<ThreadProvisionPayload> {
  if (args.payload.stage !== "metadata-pending") {
    return args.payload;
  }

  const needsBranch =
    args.payload.environmentIntent.type === "direct-managed"
    || args.payload.environmentIntent.type === "sandbox-managed";
  if (!needsBranch) {
    if (!args.payload.titleProvided) {
      void inferThreadMetadata(deps, {
        environmentId: null,
        generateBranchName: false,
        generateTitle: true,
        input: args.payload.input,
        threadId: args.thread.id,
        writeTranscript: false,
      }).then((metadata) => {
        if (!metadata.titleApplied || !metadata.title) {
          return;
        }
        const titledThread = getThread(deps.db, args.thread.id);
        const environment = titledThread?.environmentId
          ? getEnvironment(deps.db, titledThread.environmentId)
          : null;
        if (!titledThread || !environment || titledThread.status !== "active") {
          return;
        }
        queueThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          threadId: titledThread.id,
          title: metadata.title,
        });
      }).catch((error) => {
        deps.logger.warn(
          { err: error, threadId: args.thread.id },
          "Failed to generate thread title",
        );
      });
    }
    const resolvedPayload = createEnvironmentPendingPayload(args.payload, {
      branchSlug: null,
    });
    saveThreadProvisionPayload(deps, {
      threadId: args.thread.id,
      payload: resolvedPayload,
    });
    return resolvedPayload;
  }

  const metadata = await inferThreadMetadata(deps, {
    environmentId: null,
    generateBranchName: needsBranch,
    generateTitle: !args.payload.titleProvided,
    input: args.payload.input,
    threadId: args.thread.id,
    timeoutMs: needsBranch ? MANAGED_THREAD_METADATA_TIMEOUT_MS : undefined,
    writeTranscript: false,
  });

  const resolvedPayload = createEnvironmentPendingPayload(args.payload, {
    branchSlug: metadata.branchSlug,
  });
  saveThreadProvisionPayload(deps, {
    threadId: args.thread.id,
    payload: resolvedPayload,
  });
  return resolvedPayload;
}

function attachThreadToEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: AttachThreadToEnvironmentArgs,
): ThreadProvisionProvisionablePayload {
  if (args.thread.environmentId !== args.environment.id) {
    updateThread(deps.db, deps.hub, args.thread.id, {
      environmentId: args.environment.id,
    });
  }
  if (
    isProvisionablePayload(args.payload)
    && args.payload.attachedEnvironmentId === args.environment.id
  ) {
    return args.payload;
  }
  const attachedPayload = createEnvironmentAttachedPayload(args.payload, {
    attachedEnvironmentId: args.environment.id,
  });
  saveThreadProvisionPayload(deps, {
    threadId: args.thread.id,
    payload: attachedPayload,
  });
  return attachedPayload;
}

function appendProvisioningStartedEvent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: EnvironmentPayloadThreadArgs,
): ThreadProvisionProvisionablePayload {
  const existingPayload = provisioningStartedPayload(args.payload);
  if (existingPayload) {
    return existingPayload;
  }

  const eventSequence = appendThreadProvisioningEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    status: "active",
    entries: initialProvisioningEntries(args.environment),
  });
  const updatedPayload = createEnvironmentProvisioningPayload(args.payload, {
    provisionEventSequence: eventSequence,
  });
  saveThreadProvisionPayload(deps, {
    threadId: args.thread.id,
    payload: updatedPayload,
  });
  return updatedPayload;
}

function createProvisioningEnvironmentWithOperation(
  deps: Pick<AppDeps, "db" | "hub">,
  args: CreateProvisioningEnvironmentWithOperationArgs,
): ThreadProvisioningResult {
  const result = deps.db.transaction(
    (tx) => {
      const activeOperation = getThreadOperation(tx, {
        threadId: args.thread.id,
        kind: "provision",
      });
      if (!activeOperation || !isActiveLifecycleOperationState(activeOperation.state)) {
        throw new Error("Thread provision operation is no longer active");
      }
      const activePayload = parseJsonWithSchema(
        activeOperation.payload,
        threadProvisionPayloadSchema,
      );
      const activeAttachedEnvironmentId =
        attachedEnvironmentIdForPayload(activePayload);
      if (activeAttachedEnvironmentId) {
        const existingEnvironment = getEnvironment(
          tx,
          activeAttachedEnvironmentId,
        );
        if (!existingEnvironment) {
          throw new Error("Attached provisioning environment no longer exists");
        }
        return {
          environment: existingEnvironment,
          payload: activePayload,
        };
      }

      if (args.hostInput) {
        upsertHost(tx, deps.hub, args.hostInput);
      }
      const environment = createEnvironment(tx, deps.hub, args.environmentInput);
      if (args.thread.environmentId !== environment.id) {
        updateThread(tx, deps.hub, args.thread.id, {
          environmentId: environment.id,
        });
      }

      const attachedPayload = createEnvironmentAttachedPayload(args.payload, {
        attachedEnvironmentId: environment.id,
      });
      const eventSequence = appendThreadProvisioningEventInTransaction(tx, {
        threadId: args.thread.id,
        environmentId: environment.id,
        status: "active",
        entries: initialProvisioningEntries(environment),
      });
      const payload = createEnvironmentProvisioningPayload(attachedPayload, {
        provisionEventSequence: eventSequence,
      });
      upsertThreadOperationRecord(tx, {
        threadId: args.thread.id,
        kind: "provision",
        payload: JSON.stringify(payload),
      });
      upsertEnvironmentOperationRecord(tx, {
        environmentId: environment.id,
        kind: "provision",
        payload: JSON.stringify(
          args.buildRequest({
            environment,
            eventSequence,
            payload,
          }),
        ),
      });
      return { environment, payload };
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(args.thread.id, ["events-appended"]);
  return result;
}

function createDirectUnmanagedEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: DirectUnmanagedEnvironmentArgs,
): ThreadProvisioningResult {
  return createProvisioningEnvironmentWithOperation(deps, {
    thread: args.thread,
    payload: args.payload,
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.intent.hostId,
      managed: false,
      workspaceProvisionType: "unmanaged",
      status: "provisioning",
    },
    hostInput: null,
    buildRequest: ({ environment, eventSequence }) =>
      buildDirectEnvironmentProvisionRequest(
        buildEnvironmentProvisionCommand({
          environmentId: environment.id,
          hostId: args.intent.hostId,
          initiator: {
            threadId: args.thread.id,
            eventSequence,
          },
          path: args.intent.path,
          workspaceProvisionType: "unmanaged",
        }),
      ),
  });
}

async function createDirectManagedEnvironment(
  deps: ThreadProvisioningDeps,
  args: DirectManagedEnvironmentArgs,
): Promise<ThreadProvisioningResult> {
  const hostSession = await ensureHostSessionReadyForWork(deps, {
    hostId: args.intent.hostId,
  });
  return createProvisioningEnvironmentWithOperation(deps, {
    thread: args.thread,
    payload: args.payload,
    environmentInput: {
      projectId: args.thread.projectId,
      hostId: args.intent.hostId,
      managed: true,
      workspaceProvisionType: args.intent.workspaceProvisionType,
      status: "provisioning",
    },
    hostInput: null,
    buildRequest: ({ environment, eventSequence, payload }) =>
      buildDirectEnvironmentProvisionRequest(
        buildEnvironmentProvisionCommand({
          branchName: buildManagedBranchName({
            branchSlug: payload.branchSlug,
            threadId: args.thread.id,
          }),
          environmentId: environment.id,
          hostId: args.intent.hostId,
          initiator: {
            threadId: args.thread.id,
            eventSequence,
          },
          sourcePath: args.intent.sourcePath,
          targetPath: resolveManagedTargetPath({
            dataDir: hostSession.dataDir,
            environmentId: environment.id,
            sourcePath: args.intent.sourcePath,
          }),
          workspaceProvisionType: args.intent.workspaceProvisionType,
          setupTimeoutMs: SETUP_TIMEOUT_MS,
        }),
      ),
  });
}

function createSandboxManagedEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SandboxManagedEnvironmentArgs,
): ThreadProvisioningResult {
  const hostId = createHostId();
  const hostName = `sandbox-${hostId.slice(-6)}`;
  return createProvisioningEnvironmentWithOperation(deps, {
    thread: args.thread,
    payload: args.payload,
    environmentInput: {
      hostId,
      managed: true,
      projectId: args.thread.projectId,
      status: "provisioning",
      workspaceProvisionType: "managed-clone",
    },
    hostInput: {
      id: hostId,
      name: hostName,
      provider: args.intent.sandboxType,
      type: "ephemeral",
    },
    buildRequest: ({ environment, eventSequence, payload }) =>
      buildSandboxHostEnvironmentProvisionRequest({
        sandboxType: args.intent.sandboxType,
        command: buildEnvironmentProvisionCommand({
          branchName: buildManagedBranchName({
            branchSlug: payload.branchSlug,
            threadId: args.thread.id,
          }),
          environmentId: environment.id,
          hostId,
          initiator: {
            threadId: args.thread.id,
            eventSequence,
          },
          sourcePath: args.intent.cloneRepoUrl,
          targetPath: resolveManagedTargetPath({
            dataDir: SANDBOX_DATA_DIR,
            environmentId: environment.id,
            sourcePath: args.intent.cloneRepoUrl,
          }),
          workspaceProvisionType: "managed-clone",
          setupTimeoutMs: SETUP_TIMEOUT_MS,
        }),
      }),
  });
}

async function ensureEnvironmentRequested(
  deps: ThreadProvisioningDeps,
  args: EnsureEnvironmentRequestedArgs,
): Promise<ThreadProvisioningResult> {
  if (!isAttachablePayload(args.payload)) {
    throw new Error(`Cannot request environment from ${args.payload.stage} payload`);
  }

  if (args.payload.environmentIntent.type === "reuse") {
    const environment = getEnvironment(
      deps.db,
      args.payload.environmentIntent.environmentId,
    );
    if (!environment) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    let payload = attachThreadToEnvironment(deps, {
      environment,
      payload: args.payload,
      thread: args.thread,
    });
    if (environment.status === "provisioning") {
      if (!hasActiveEnvironmentProvisionOperation(deps, environment)) {
        failThreadProvisioning(deps, {
          thread: args.thread,
          environmentId: environment.id,
          detail: "Environment is provisioning without an active provision operation",
        });
        return { environment, payload };
      }
      payload = appendProvisioningStartedEvent(deps, {
        environment,
        payload,
        thread: args.thread,
      });
    }
    return { environment, payload };
  }

  const attachedEnvironmentId = attachedEnvironmentIdForPayload(args.payload);
  if (attachedEnvironmentId) {
    const environment = getEnvironment(deps.db, attachedEnvironmentId);
    if (!environment) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    return {
      environment,
      payload: args.payload,
    };
  }

  if (args.payload.stage !== "environment-pending") {
    throw new Error(`Cannot request environment from ${args.payload.stage} payload`);
  }

  switch (args.payload.environmentIntent.type) {
    case "direct-unmanaged":
      return createDirectUnmanagedEnvironment(deps, {
        intent: args.payload.environmentIntent,
        payload: args.payload,
        thread: args.thread,
      });
    case "direct-managed":
      return createDirectManagedEnvironment(deps, {
        intent: args.payload.environmentIntent,
        payload: args.payload,
        thread: args.thread,
      });
    case "sandbox-managed":
      return createSandboxManagedEnvironment(deps, {
        intent: args.payload.environmentIntent,
        payload: args.payload,
        thread: args.thread,
      });
  }
}

async function startThreadIfEnvironmentReady(
  deps: ThreadProvisioningDeps,
  args: EnvironmentPayloadThreadArgs,
): Promise<void> {
  if (args.environment.status === "error") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment provisioning failed",
    });
    return;
  }
  if (args.environment.status === "provisioning") {
    return;
  }
  if (args.environment.status !== "ready") {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: `Environment is ${args.environment.status}`,
    });
    return;
  }
  if (!args.environment.path) {
    failThreadProvisioning(deps, {
      thread: args.thread,
      environmentId: args.environment.id,
      detail: "Environment is ready without a workspace path",
    });
    return;
  }

  const workspaceReadyEventSequence = ensureWorkspaceReadyEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    entries: buildCwdBranchEntries({
      path: args.environment.path,
      branchName: args.environment.branchName,
    }),
  });
  if (workspaceReadyEventSequence === null) {
    throw new Error("Workspace ready event sequence was not recorded");
  }

  await requestThreadStart(deps, {
    thread: args.thread,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
    input: args.payload.input,
    eventSequence: args.payload.clientRequestSequence,
    execution: args.payload.execution,
    permissionEscalation: resolvePermissionEscalation({
      thread: args.thread,
      initiator: args.thread.type === "manager" ? "system" : "user",
    }),
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
  });
  completeThreadProvisioning(deps, args.thread.id);
}

export function requestThreadProvision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadProvisionArgs,
): void {
  const clientRequestSequence = appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: args.thread.type === "manager" ? "system" : "user",
    requestMethod: "thread/start",
    source: "spawn",
    target: { kind: "thread-start" },
  });
  appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/thread/start",
    initiator: args.thread.type === "manager" ? "system" : "user",
    requestMethod: "thread/start",
    source: "spawn",
  });

  const payload = createMetadataPendingPayload({
    ...args,
    clientRequestSequence,
  });
  upsertThreadOperationRecord(deps.db, {
    threadId: args.thread.id,
    kind: "provision",
    payload: JSON.stringify(payload),
  });
}

export function requestThreadReprovision(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RequestThreadReprovisionArgs,
): void {
  const clientRequestSequence = appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: args.initiator,
    requestMethod: "turn/start",
    source: "tell",
    target: { kind: "new-turn" },
  });

  const payload = createReprovisioningPayload({
    ...args,
    clientRequestSequence,
  });
  upsertThreadOperationRecord(deps.db, {
    threadId: args.thread.id,
    kind: "provision",
    payload: JSON.stringify(payload),
  });
}

export function shouldSyncGeneratedThreadTitle(
  deps: Pick<AppDeps, "db">,
  threadId: string,
): boolean {
  const operation = getThreadOperation(deps.db, {
    threadId,
    kind: "provision",
  });
  if (!operation) {
    return false;
  }
  const payload = parseJsonWithSchema(
    operation.payload,
    threadProvisionPayloadSchema,
  );
  return !payload.titleProvided;
}

export function recordThreadProvisionWorkspaceReady(
  deps: Pick<AppDeps, "db" | "hub">,
  args: RecordThreadProvisionWorkspaceReadyArgs,
): void {
  ensureWorkspaceReadyEvent(deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    entries: args.entries,
  });
}

async function advanceThreadProvisioningOnce(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.deletedAt !== null) {
    return;
  }
  let payload = loadActiveThreadProvisionPayload(deps, thread.id);
  if (!payload) {
    return;
  }
  if (thread.status === "error") {
    markThreadOperationRecordFailed(deps.db, {
      threadId: thread.id,
      kind: "provision",
      failureReason: "Thread provisioning failed",
    });
    return;
  }
  if (thread.archivedAt !== null || thread.stopRequestedAt !== null) {
    return;
  }

  try {
    payload = await resolveMetadataIfNeeded(deps, {
      payload,
      thread,
    });
    const { environment, payload: attachedPayload } =
      await ensureEnvironmentRequested(deps, {
        payload,
        thread,
      });
    payload = attachedPayload;

    if (environment.status === "provisioning") {
      await advanceEnvironmentProvisioning(deps, {
        environmentId: environment.id,
      });
    }
    if (!isProvisionablePayload(payload)) {
      throw new Error(`Cannot start thread from ${payload.stage} payload`);
    }
    await startThreadIfEnvironmentReady(deps, {
      environment: getEnvironment(deps.db, environment.id) ?? environment,
      payload,
      thread: getThread(deps.db, thread.id) ?? thread,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    failThreadProvisioning(deps, {
      thread,
      environmentId: attachedEnvironmentIdForPayload(payload),
      detail,
    });
  }
}

export async function advanceThreadProvisioning(
  deps: ThreadProvisioningDeps,
  args: AdvanceThreadProvisioningArgs,
): Promise<void> {
  await threadProvisionAdvanceDeduper.run(args.threadId, () =>
    advanceThreadProvisioningOnce(deps, args)
  );
}
