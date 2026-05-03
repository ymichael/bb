import {
  getProjectExecutionDefaults,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import type {
  ProjectExecutionDefaults,
  ResolvedThreadExecutionOptions,
} from "@bb/domain";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import type {
  ThreadCreateServiceRequest,
  ThreadCreateServiceRequestInput,
} from "./thread-create-request.js";
import { resolveCreateThreadExecutionDefaults } from "./thread-default-policy.js";

export interface RememberProjectExecutionDefaultsForCreateArgs {
  execution: ResolvedThreadExecutionOptions;
  request: ThreadCreateServiceRequest;
}

export interface ResolveProjectExecutionDefaultsForCreateArgs {
  model?: ThreadCreateServiceRequestInput["model"];
  projectId: string;
  providerId?: ThreadCreateServiceRequestInput["providerId"];
  threadType: ThreadCreateServiceRequestInput["type"];
}

export interface ResolvedProjectExecutionDefaultsForCreate {
  executionDefaults: ProjectExecutionDefaults | null;
  providerId: string;
}

function shouldRememberProjectExecutionDefaults(args: {
  automationId: string | null;
  origin: ThreadCreateServiceRequest["origin"];
}): boolean {
  return args.origin === "app" && args.automationId === null;
}

export function resolveProjectExecutionDefaultsForCreate(
  deps: Pick<AppDeps, "db">,
  args: ResolveProjectExecutionDefaultsForCreateArgs,
): ResolvedProjectExecutionDefaultsForCreate {
  const storedDefaults = getProjectExecutionDefaults(deps.db, {
    projectId: args.projectId,
    threadType: args.threadType,
  });
  const resolution = resolveCreateThreadExecutionDefaults({
    requestedProviderId: args.providerId,
    storedDefaults,
    threadType: args.threadType,
  });
  if (resolution.kind === "provider_required") {
    throw new ApiError(
      400,
      "invalid_request",
      `Provider is required when project ${args.projectId} has no stored execution defaults for thread type ${args.threadType}`,
    );
  }
  const { executionDefaults, providerId } = resolution;

  if (!args.model && !executionDefaults) {
    throw new ApiError(
      400,
      "invalid_request",
      `Model is required when project ${args.projectId} has no stored execution defaults for provider ${providerId} and thread type ${args.threadType}`,
    );
  }

  return {
    executionDefaults,
    providerId,
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
    threadType: args.request.type,
    model: args.execution.model,
    reasoningLevel: args.execution.reasoningLevel,
    permissionMode: args.execution.permissionMode,
    serviceTier: args.execution.serviceTier,
  });
}
