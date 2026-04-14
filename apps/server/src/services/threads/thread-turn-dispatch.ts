import type {
  Environment,
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
  ThreadTurnInitiator,
} from "@bb/domain";
import type { SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { queueManagedEnvironmentReprovision } from "../environments/environment-provisioning.js";
import {
  hasActiveManagedEnvironmentProvision,
  MANAGED_REPROVISION_IN_PROGRESS,
  MANAGED_REPROVISION_QUEUED,
} from "../environments/environment-provisioning.js";
import { ensureHostSessionReadyForWork } from "../hosts/host-lifecycle.js";
import { appendThreadProvisioningEvent } from "./thread-events.js";
import { requestThreadReprovision } from "./thread-provisioning.js";
import { tryTransition } from "./thread-transitions.js";

export interface ReadyThreadEnvironment extends Environment {
  path: string;
  status: "ready";
}

export interface QueueTurnDuringReprovisionArgs {
  deps: SandboxWorkSessionDeps;
  environment: Environment;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  onQueued?: () => void;
  thread: Thread;
}

function reprovisionStartedText(
  workspaceProvisionType: Environment["workspaceProvisionType"],
): string {
  switch (workspaceProvisionType) {
    case "managed-clone":
      return "Restoring clone";
    case "managed-worktree":
      return "Restoring worktree";
    case "unmanaged":
      return "Restoring environment";
  }
}

export function requireReadyThreadEnvironment(
  environment: Environment,
): ReadyThreadEnvironment {
  if (environment.status !== "ready" || !environment.path) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }

  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

export async function queueTurnDuringReprovision(
  args: QueueTurnDuringReprovisionArgs,
): Promise<boolean> {
  if (args.environment.status === "ready" && args.environment.path) {
    return false;
  }

  if (
    !args.environment.managed ||
    args.environment.status === "provisioning"
  ) {
    throw new ApiError(409, "invalid_request", "Environment is not ready");
  }
  if (hasActiveManagedEnvironmentProvision(args.deps, {
    environmentId: args.environment.id,
  })) {
    throw new ApiError(409, "invalid_request", "Environment is already provisioning");
  }
  await ensureHostSessionReadyForWork(args.deps, {
    hostId: args.environment.hostId,
  });

  if (args.thread.status === "idle") {
    tryTransition(args.deps.db, args.deps.hub, args.thread.id, "provisioning");
  }
  const provisionEventSequence = appendThreadProvisioningEvent(args.deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    status: "active",
    entries: [
      {
        type: "step",
        key: "workspace-restore-started",
        text: reprovisionStartedText(args.environment.workspaceProvisionType),
        status: "started",
      },
    ],
  });

  const reprovisionResult = await queueManagedEnvironmentReprovision(args.deps, {
    environment: args.environment,
    projectId: args.thread.projectId,
    provisionEventSequence,
    threadId: args.thread.id,
  });
  if (reprovisionResult === MANAGED_REPROVISION_IN_PROGRESS) {
    throw new ApiError(409, "invalid_request", "Environment is already provisioning");
  }
  if (reprovisionResult.status !== MANAGED_REPROVISION_QUEUED) {
    throw new ApiError(500, "internal_error", "Unexpected reprovision result");
  }

  requestThreadReprovision(args.deps, {
    thread: args.thread,
    environment: args.environment,
    eventSequence: reprovisionResult.eventSequence,
    input: args.input,
    execution: args.execution,
    initiator: args.initiator,
  });
  args.onQueued?.();
  return true;
}
