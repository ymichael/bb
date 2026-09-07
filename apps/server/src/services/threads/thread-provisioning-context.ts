import { z } from "zod";
import { createThreadProvisioningId } from "@bb/db";
import {
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
  clientTurnRequestIdSchema,
  type ClientTurnRequestId,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
} from "@bb/domain";
import {
  baseBranchSpecSchema,
  unmanagedBranchSpecSchema,
} from "@bb/server-contract";

const directUnmanagedIntentSchema = z.object({
  type: z.literal("direct-unmanaged"),
  hostId: z.string().min(1),
  path: z.string().min(1),
  branch: unmanagedBranchSpecSchema.optional(),
});

const checkoutUnmanagedIntentSchema = z.object({
  type: z.literal("checkout-unmanaged"),
  environmentId: z.string().min(1),
  hostId: z.string().min(1),
  path: z.string().min(1),
  branch: unmanagedBranchSpecSchema,
});

const directManagedIntentSchema = z.object({
  type: z.literal("direct-managed"),
  hostId: z.string().min(1),
  sourcePath: z.string().min(1),
  baseBranch: baseBranchSpecSchema,
  workspaceProvisionType: z.literal("managed-worktree"),
});

const directPersonalIntentSchema = z.object({
  type: z.literal("direct-personal"),
  hostId: z.string().min(1),
  workspaceProvisionType: z.literal("personal"),
});

const reuseIntentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

/**
 * Exported so a queued thread-start can persist the intent it resolved at
 * create time and rebuild this context when its wait clears, possibly after a
 * restart. Nothing else should construct one by hand.
 */
export const threadProvisionEnvironmentIntentSchema = z.discriminatedUnion(
  "type",
  [
    directUnmanagedIntentSchema,
    checkoutUnmanagedIntentSchema,
    directManagedIntentSchema,
    directPersonalIntentSchema,
    reuseIntentSchema,
  ],
);

export const threadForkDescriptorSchema = z.object({
  sourceProviderThreadId: z.string().min(1),
  sourceProviderCheckpointId: z.string().min(1).optional(),
});

const threadProvisionCommonPayloadSchema = z.object({
  branchSlug: z.string().nullable().default(null),
  clientRequestId: clientTurnRequestIdSchema,
  environmentIntent: threadProvisionEnvironmentIntentSchema,
  execution: resolvedThreadExecutionOptionsSchema,
  fork: threadForkDescriptorSchema.nullable().default(null),
  input: z.array(promptInputSchema),
  inputGroups: z.array(z.array(promptInputSchema).min(1)).min(1).optional(),
  titleProvided: z.boolean(),
  seedWithoutRun: z.boolean().default(false),
});

export type ThreadForkDescriptor = z.infer<typeof threadForkDescriptorSchema>;
export type ThreadProvisionEnvironmentIntent = z.infer<
  typeof threadProvisionEnvironmentIntentSchema
>;
type ThreadProvisionOperationPayload = z.infer<
  typeof threadProvisionCommonPayloadSchema
>;

const threadProvisioningStageValues = [
  "metadata-pending",
  "environment-pending",
  "environment-prepared",
  "environment-attached",
  "environment-provisioning",
  "workspace-ready",
] as const;

type ThreadProvisioningStage = (typeof threadProvisioningStageValues)[number];

interface ThreadProvisioningState {
  environmentId: string | null;
  provisionEventSequence: number | null;
  provisioningId: string;
  stage: ThreadProvisioningStage;
  workspaceReadyEventSequence: number | null;
}

export interface ThreadProvisionContext {
  request: ThreadProvisionOperationPayload;
  state: ThreadProvisioningState;
}

export type ThreadProvisionMetadataPendingContext = ThreadProvisionContext & {
  state: ThreadProvisioningState & {
    environmentId: null;
    provisionEventSequence: null;
    stage: "metadata-pending";
    workspaceReadyEventSequence: null;
  };
};

export type ThreadProvisionEnvironmentPendingContext =
  ThreadProvisionContext & {
    state: ThreadProvisioningState & {
      environmentId: null;
      provisionEventSequence: null;
      stage: "environment-pending";
      workspaceReadyEventSequence: null;
    };
  };

export type ThreadProvisionEnvironmentPreparedContext =
  ThreadProvisionContext & {
    state: ThreadProvisioningState & {
      environmentId: string;
      provisionEventSequence: number;
      stage: "environment-prepared";
      workspaceReadyEventSequence: null;
    };
  };

type ThreadProvisionEnvironmentAttachedContext = ThreadProvisionContext & {
  state: ThreadProvisioningState & {
    environmentId: string;
    provisionEventSequence: null;
    stage: "environment-attached";
    workspaceReadyEventSequence: null;
  };
};

export type ThreadProvisionEnvironmentProvisioningContext =
  ThreadProvisionContext & {
    state: ThreadProvisioningState & {
      environmentId: string;
      provisionEventSequence: number;
      stage: "environment-provisioning";
      workspaceReadyEventSequence: null;
    };
  };

type ThreadProvisionWorkspaceReadyContext = ThreadProvisionContext & {
  state: ThreadProvisioningState & {
    environmentId: string;
    stage: "workspace-ready";
    workspaceReadyEventSequence: number | null;
  };
};

export type ThreadProvisionAttachableContext =
  | ThreadProvisionEnvironmentPendingContext
  | ThreadProvisionEnvironmentAttachedContext
  | ThreadProvisionEnvironmentProvisioningContext
  | ThreadProvisionWorkspaceReadyContext;

type ThreadProvisionProvisionRequestableContext =
  | ThreadProvisionEnvironmentPreparedContext
  | ThreadProvisionEnvironmentAttachedContext
  | ThreadProvisionEnvironmentProvisioningContext
  | ThreadProvisionWorkspaceReadyContext;

export type ThreadProvisionProvisionableContext =
  | ThreadProvisionEnvironmentAttachedContext
  | ThreadProvisionEnvironmentProvisioningContext
  | ThreadProvisionWorkspaceReadyContext;

interface CreateMetadataPendingContextArgs {
  clientRequestId: ClientTurnRequestId;
  environmentIntent: ThreadProvisionEnvironmentIntent;
  execution: ResolvedThreadExecutionOptions;
  fork: ThreadForkDescriptor | null;
  input: PromptInput[];
  seedWithoutRun: boolean;
  titleProvided: boolean;
}

interface CreateEnvironmentPendingContextArgs {
  branchSlug: string | null;
}

interface CreateEnvironmentAttachedContextArgs {
  attachedEnvironmentId: string;
}

interface CreateEnvironmentPreparedContextArgs {
  attachedEnvironmentId: string;
  provisionEventSequence: number;
}

interface CreateEnvironmentProvisioningContextArgs {
  provisionEventSequence: number;
}

interface CreateReprovisioningContextArgs {
  clientRequestId: ClientTurnRequestId;
  environmentId: string;
  provisionEventSequence: number;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  inputGroups?: PromptInput[][];
  provisioningId: string;
}

interface CreateWorkspaceReadyContextArgs {
  workspaceReadyEventSequence: number | null;
}

interface ResolvePreparedEnvironmentMetadataArgs {
  branchSlug: string | null;
}

export function isAttachableContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionAttachableContext {
  switch (context.state.stage) {
    case "metadata-pending":
      return false;
    case "environment-pending":
      return context.state.environmentId === null;
    case "environment-prepared":
      return false;
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return context.state.environmentId !== null;
  }
}

export function isMetadataPendingContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionMetadataPendingContext {
  return (
    context.state.stage === "metadata-pending" &&
    context.state.environmentId === null &&
    context.state.provisionEventSequence === null &&
    context.state.workspaceReadyEventSequence === null
  );
}

export function isEnvironmentPendingContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionEnvironmentPendingContext {
  return (
    context.state.stage === "environment-pending" &&
    context.state.environmentId === null &&
    context.state.provisionEventSequence === null &&
    context.state.workspaceReadyEventSequence === null
  );
}

export function isEnvironmentProvisioningContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionEnvironmentProvisioningContext {
  return (
    context.state.stage === "environment-provisioning" &&
    context.state.environmentId !== null &&
    context.state.provisionEventSequence !== null &&
    context.state.workspaceReadyEventSequence === null
  );
}

export function isEnvironmentPreparedContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionEnvironmentPreparedContext {
  return (
    context.state.stage === "environment-prepared" &&
    context.state.environmentId !== null &&
    context.state.provisionEventSequence !== null &&
    context.state.workspaceReadyEventSequence === null
  );
}

function isWorkspaceReadyContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionWorkspaceReadyContext {
  return (
    context.state.stage === "workspace-ready" &&
    context.state.environmentId !== null
  );
}

export function hasProvisioningTimelineRow(
  context: ThreadProvisionContext,
): boolean {
  return (
    context.state.provisionEventSequence !== null ||
    context.state.workspaceReadyEventSequence !== null
  );
}

export function isProvisionableContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionProvisionableContext {
  switch (context.state.stage) {
    case "metadata-pending":
    case "environment-pending":
    case "environment-prepared":
      return false;
    case "environment-attached":
    case "environment-provisioning":
    case "workspace-ready":
      return context.state.environmentId !== null;
  }
}

export function createMetadataPendingContext(
  args: CreateMetadataPendingContextArgs,
): ThreadProvisionMetadataPendingContext {
  return {
    request: {
      branchSlug: null,
      clientRequestId: args.clientRequestId,
      environmentIntent: args.environmentIntent,
      execution: args.execution,
      fork: args.fork,
      input: args.input,
      titleProvided: args.titleProvided,
      seedWithoutRun: args.seedWithoutRun,
    },
    state: {
      environmentId: null,
      provisionEventSequence: null,
      provisioningId: createThreadProvisioningId(),
      stage: "metadata-pending",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createEnvironmentPendingContext(
  context: ThreadProvisionMetadataPendingContext,
  args: CreateEnvironmentPendingContextArgs,
): ThreadProvisionEnvironmentPendingContext {
  return {
    request: {
      ...context.request,
      branchSlug: args.branchSlug,
    },
    state: {
      environmentId: null,
      provisionEventSequence: null,
      provisioningId: context.state.provisioningId,
      stage: "environment-pending",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createEnvironmentAttachedContext(
  context: ThreadProvisionAttachableContext,
  args: CreateEnvironmentAttachedContextArgs,
): ThreadProvisionEnvironmentAttachedContext {
  return {
    request: context.request,
    state: {
      environmentId: args.attachedEnvironmentId,
      provisionEventSequence: null,
      provisioningId: context.state.provisioningId,
      stage: "environment-attached",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createEnvironmentPreparedContext(
  context: ThreadProvisionMetadataPendingContext,
  args: CreateEnvironmentPreparedContextArgs,
): ThreadProvisionEnvironmentPreparedContext {
  return {
    request: context.request,
    state: {
      environmentId: args.attachedEnvironmentId,
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: context.state.provisioningId,
      stage: "environment-prepared",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createEnvironmentProvisioningContext(
  context: ThreadProvisionProvisionRequestableContext,
  args: CreateEnvironmentProvisioningContextArgs,
): ThreadProvisionEnvironmentProvisioningContext {
  return {
    request: context.request,
    state: {
      environmentId: context.state.environmentId,
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: context.state.provisioningId,
      stage: "environment-provisioning",
      workspaceReadyEventSequence: null,
    },
  };
}

export function resolvePreparedEnvironmentMetadata(
  context: ThreadProvisionEnvironmentPreparedContext,
  args: ResolvePreparedEnvironmentMetadataArgs,
): ThreadProvisionEnvironmentPreparedContext {
  return {
    request: {
      ...context.request,
      branchSlug: args.branchSlug,
    },
    state: context.state,
  };
}

export function createReprovisioningContext(
  args: CreateReprovisioningContextArgs,
): ThreadProvisionEnvironmentProvisioningContext {
  return {
    request: {
      branchSlug: null,
      environmentIntent: {
        type: "reuse",
        environmentId: args.environmentId,
      },
      clientRequestId: args.clientRequestId,
      execution: args.execution,
      fork: null,
      input: args.input,
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      titleProvided: true,
      seedWithoutRun: false,
    },
    state: {
      environmentId: args.environmentId,
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: args.provisioningId,
      stage: "environment-provisioning",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createWorkspaceReadyContext(
  context: ThreadProvisionProvisionableContext,
  args: CreateWorkspaceReadyContextArgs,
): ThreadProvisionWorkspaceReadyContext {
  return {
    request: context.request,
    state: {
      environmentId: context.state.environmentId,
      provisionEventSequence: context.state.provisionEventSequence,
      provisioningId: context.state.provisioningId,
      stage: "workspace-ready",
      workspaceReadyEventSequence: args.workspaceReadyEventSequence,
    },
  };
}

export function provisionableContextForWorkspaceReady(
  context: ThreadProvisionAttachableContext,
  args: CreateEnvironmentAttachedContextArgs,
): ThreadProvisionProvisionableContext {
  if (context.state.stage === "environment-pending") {
    return createEnvironmentAttachedContext(context, args);
  }
  if (isProvisionableContext(context)) {
    return context;
  }
  throw new Error(
    `Cannot attach workspace-ready state from ${context.state.stage}`,
  );
}

export function provisioningStartedContext(
  context: ThreadProvisionProvisionableContext,
):
  | ThreadProvisionEnvironmentProvisioningContext
  | ThreadProvisionWorkspaceReadyContext
  | null {
  if (context.state.stage === "environment-attached") {
    return null;
  }
  if (isEnvironmentProvisioningContext(context)) {
    return context;
  }
  if (isWorkspaceReadyContext(context)) {
    return context;
  }
  throw new Error(
    `Cannot resolve started provisioning from ${context.state.stage}`,
  );
}
