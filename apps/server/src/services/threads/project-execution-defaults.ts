import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import type {
  ProjectExecutionDefaults,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import type {
  ThreadCreateServiceRequest,
  ThreadCreateServiceRequestInput,
} from "./thread-create-request.js";
import { resolveCreateThreadExecutionDefaults } from "./thread-default-policy.js";

interface RememberProjectExecutionDefaultsForCreateArgs {
  execution: ResolvedThreadExecutionOptions;
  request: ThreadCreateServiceRequest;
}

interface ResolveProjectExecutionDefaultsForCreateArgs {
  executionInputSources?: ThreadCreateServiceRequestInput["executionInputSources"];
  model?: ThreadCreateServiceRequestInput["model"];
  projectId: string;
  providerId?: ThreadCreateServiceRequestInput["providerId"];
}

interface ResolvedProjectExecutionDefaultsForCreate {
  executionDefaults: ProjectExecutionDefaults | null;
  providerId: string;
  requestedModel: string | null;
}

type CreateExecutionInputSources =
  ThreadCreateServiceRequestInput["executionInputSources"];
type CreateExecutionInputField = keyof NonNullable<CreateExecutionInputSources>;

interface ResolveRequestedCreateExecutionValueArgs<TValue> {
  field: CreateExecutionInputField;
  sources: CreateExecutionInputSources;
  value: TValue | undefined;
}

function shouldRememberProjectExecutionDefaults(args: {
  environment: ThreadCreateServiceRequest["environment"];
  origin: ThreadCreateServiceRequest["origin"];
  originKind?: ThreadCreateServiceRequest["originKind"];
}): boolean {
  // Reusing an existing worktree is a one-off in a specific environment, not
  // a fresh default-shaping event. Don't overwrite the project's stored
  // execution defaults with the picker selections made for that single thread.
  if (args.environment.type === "reuse") return false;
  if (args.originKind !== null) return false;
  return args.origin === "app";
}

function resolveRequestedCreateExecutionValue<TValue>({
  field,
  sources,
  value,
}: ResolveRequestedCreateExecutionValueArgs<TValue>): TValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (sources === undefined) {
    return value;
  }
  return sources[field] === undefined ? undefined : value;
}

/**
 * Resolves the create's provider through the defaults ladder. This is the only
 * place a thread's provider is chosen: it is immutable afterwards, because a
 * provider session IS the conversation and no other provider can continue one
 * it never started.
 */
export function resolveProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: ResolveProjectExecutionDefaultsForCreateArgs,
): ResolvedProjectExecutionDefaultsForCreate {
  const storedDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: args.projectId,
  });
  const requestedProviderId = resolveRequestedCreateExecutionValue({
    field: "providerId",
    sources: args.executionInputSources,
    value: args.providerId,
  });
  const requestedModel = resolveRequestedCreateExecutionValue({
    field: "model",
    sources: args.executionInputSources,
    value: args.model,
  });
  const resolution = resolveCreateThreadExecutionDefaults(
    deps.providerRegistry,
    {
      requestedProviderId,
      storedDefaults,
    },
  );
  const { executionDefaults, providerId } = resolution;

  return {
    executionDefaults,
    providerId,
    requestedModel: requestedModel ?? null,
  };
}

export function rememberProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db">,
  args: RememberProjectExecutionDefaultsForCreateArgs,
): void {
  if (!shouldRememberProjectExecutionDefaults(args.request)) {
    return;
  }

  upsertProjectExecutionDefaults(deps.db, {
    projectId: args.request.projectId,
    providerId: args.request.providerId,
    model: args.execution.model,
    reasoningLevel: args.execution.reasoningLevel,
    permissionMode: args.execution.permissionMode,
    serviceTier: args.execution.serviceTier,
  });
}
