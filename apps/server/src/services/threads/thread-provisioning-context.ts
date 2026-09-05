import { z } from "zod";
import { createThreadProvisioningId } from "@bb/db";
import {
  environmentProviderSelectionSchema,
  environmentMachineSelectionSchema,
  jsonValueSchema,
  promptInputSchema,
  resolvedThreadExecutionOptionsSchema,
  clientTurnRequestIdSchema,
  type ClientTurnRequestId,
  type PromptInput,
  type ResolvedThreadExecutionOptions,
} from "@bb/domain";

const producedHostSchema = z.object({
  hostId: z.string().min(1),
  path: z.string().min(1),
  mergeBaseBranch: z.string().min(1).nullable().default(null),
  ownsPath: z.boolean().default(false),
});

const reuseIntentSchema = z.object({
  type: z.literal("reuse"),
  environmentId: z.string().min(1),
});

const providerIntentSchema = z.object({
  type: z.literal("provider"),
  environmentProviderId: z.string().min(1),
  machine: environmentMachineSelectionSchema,
  inputs: jsonValueSchema.nullable(),
  selectionResolved: z.boolean().default(true),
  produced: producedHostSchema.nullable().default(null),
});

/**
 * Exported so a queued thread-start can persist the intent it resolved at
 * create time and rebuild this context when its wait clears, possibly after a
 * restart. Nothing else should construct one by hand.
 */
export const threadProvisionEnvironmentIntentSchema = z.discriminatedUnion(
  "type",
  [reuseIntentSchema, providerIntentSchema],
);

export const threadForkDescriptorSchema = z.object({
  sourceProviderThreadId: z.string().min(1),
  sourceProviderCheckpointId: z.string().min(1).optional(),
});

const producedByProviderSchema = z.object({
  environmentProviderId: z.string().min(1),
  instanceKey: z.string().min(1).max(128).nullable().default(null),
  selection: environmentProviderSelectionSchema,
});

export const threadProvisionCommonPayloadSchema = z.object({
  producedBy: producedByProviderSchema.nullable().default(null),
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
export type ThreadProvisionProducedBy = z.infer<
  typeof producedByProviderSchema
>;
export type ThreadProvisionEnvironmentIntent = z.infer<
  typeof threadProvisionEnvironmentIntentSchema
>;
type ThreadProvisionOperationPayload = z.infer<
  typeof threadProvisionCommonPayloadSchema
>;

const threadProvisioningStageValues = [
  "metadata-pending",
  "provider-pending",
  "environment-pending",
  "environment-attached",
  "environment-provisioning",
  "workspace-ready",
] as const;

type ThreadProvisioningStage = (typeof threadProvisioningStageValues)[number];

export interface ThreadProvisionProviderAsk {
  environmentProviderId: string;
  lastStep: { key: string; startedAt: number; text: string } | null;
  nextAskTimer: NodeJS.Timeout | null;
  outputCount: number;
  recheckRequested: boolean;
  stepCount: number;
}

interface ThreadProvisioningState {
  environmentId: string | null;
  providerAsk: ThreadProvisionProviderAsk | null;
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

export type ThreadProvisionProviderPendingContext = ThreadProvisionContext & {
  state: ThreadProvisioningState & {
    environmentId: null;
    providerAsk: ThreadProvisionProviderAsk;
    provisionEventSequence: number;
    stage: "provider-pending";
    workspaceReadyEventSequence: null;
  };
};

export type ThreadProvisionEnvironmentPendingContext =
  ThreadProvisionContext & {
    state: ThreadProvisioningState & {
      environmentId: null;
      stage: "environment-pending";
      workspaceReadyEventSequence: null;
    };
  };

type ThreadProvisionEnvironmentAttachedContext = ThreadProvisionContext & {
  state: ThreadProvisioningState & {
    environmentId: string;
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
  inputGroups?: PromptInput[][];
  seedWithoutRun: boolean;
  titleProvided: boolean;
}

interface CreateProviderPendingContextArgs {
  provisionEventSequence: number;
}

interface ResolveProviderPendingContextArgs {
  environmentIntent: ThreadProvisionEnvironmentIntent;
  producedBy: ThreadProvisionProducedBy;
}

interface CreateEnvironmentAttachedContextArgs {
  attachedEnvironmentId: string;
}

interface CreateEnvironmentProvisioningContextArgs {
  provisionEventSequence: number;
}

interface CreateWorkspaceReadyContextArgs {
  workspaceReadyEventSequence: number | null;
}

export function isAttachableContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionAttachableContext {
  switch (context.state.stage) {
    case "metadata-pending":
    case "provider-pending":
      return false;
    case "environment-pending":
      return context.state.environmentId === null;
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
    context.state.workspaceReadyEventSequence === null
  );
}

export function isProviderPendingContext(
  context: ThreadProvisionContext,
): context is ThreadProvisionProviderPendingContext {
  return (
    context.state.stage === "provider-pending" &&
    context.state.environmentId === null &&
    context.state.providerAsk !== null &&
    context.state.provisionEventSequence !== null &&
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
    case "provider-pending":
    case "environment-pending":
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
      producedBy: null,
      clientRequestId: args.clientRequestId,
      environmentIntent: args.environmentIntent,
      execution: args.execution,
      fork: args.fork,
      input: args.input,
      ...(args.inputGroups !== undefined
        ? { inputGroups: args.inputGroups }
        : {}),
      titleProvided: args.titleProvided,
      seedWithoutRun: args.seedWithoutRun,
    },
    state: {
      environmentId: null,
      providerAsk: null,
      provisionEventSequence: null,
      provisioningId: createThreadProvisioningId(),
      stage: "metadata-pending",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createEnvironmentPendingContext(
  context: ThreadProvisionMetadataPendingContext,
): ThreadProvisionEnvironmentPendingContext {
  return {
    request: {
      ...context.request,
    },
    state: {
      environmentId: null,
      providerAsk: null,
      provisionEventSequence: null,
      provisioningId: context.state.provisioningId,
      stage: "environment-pending",
      workspaceReadyEventSequence: null,
    },
  };
}

export function createProviderPendingContext(
  context: ThreadProvisionMetadataPendingContext,
  args: CreateProviderPendingContextArgs,
): ThreadProvisionProviderPendingContext {
  const intent = context.request.environmentIntent;
  if (intent.type !== "provider" || intent.produced !== null) {
    throw new Error("A provider-pending context needs a provider intent");
  }
  return {
    request: {
      ...context.request,
    },
    state: {
      environmentId: null,
      providerAsk: {
        environmentProviderId: intent.environmentProviderId,
        lastStep: null,
        nextAskTimer: null,
        outputCount: 0,
        recheckRequested: false,
        stepCount: 0,
      },
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: context.state.provisioningId,
      stage: "provider-pending",
      workspaceReadyEventSequence: null,
    },
  };
}

export function resolveProviderPendingContext(
  context: ThreadProvisionProviderPendingContext,
  args: ResolveProviderPendingContextArgs,
): ThreadProvisionEnvironmentPendingContext {
  if (
    args.environmentIntent.type === "provider" &&
    args.environmentIntent.produced === null
  ) {
    throw new Error("A resolved provider intent needs a produced environment");
  }
  return {
    request: {
      ...context.request,
      environmentIntent: args.environmentIntent,
      producedBy: args.producedBy,
    },
    state: {
      environmentId: null,
      providerAsk: null,
      provisionEventSequence: context.state.provisionEventSequence,
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
      providerAsk: null,
      provisionEventSequence: context.state.provisionEventSequence,
      provisioningId: context.state.provisioningId,
      stage: "environment-attached",
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
      providerAsk: null,
      provisionEventSequence: args.provisionEventSequence,
      provisioningId: context.state.provisioningId,
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
      providerAsk: null,
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
