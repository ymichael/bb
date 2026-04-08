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
import { MANAGED_REPROVISION_QUEUED } from "../environments/environment-provisioning.js";
import { appendClientTurnEvent } from "./thread-events.js";

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

  const reprovisionResult = await queueManagedEnvironmentReprovision(args.deps, {
    environment: args.environment,
    thread: args.thread,
  });
  if (reprovisionResult !== MANAGED_REPROVISION_QUEUED) {
    throw new ApiError(409, "invalid_request", "Environment is already provisioning");
  }

  appendClientTurnEvent(args.deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: args.initiator,
    requestMethod: "turn/start",
    source: "tell",
  });
  args.onQueued?.();
  return true;
}
