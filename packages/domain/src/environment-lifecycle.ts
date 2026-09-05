import type { EnvironmentStatus } from "./environment.js";

export type EnvironmentLifecycleEvent =
  | { type: "provision.requested" }
  | { type: "provision.succeeded" }
  | { type: "provision.failed" }
  | { type: "provision.cancelled" }
  | { type: "destroy.recorded" };

export type EnvironmentLifecycleEventType = EnvironmentLifecycleEvent["type"];

export interface EnvironmentLifecyclePathDependentTarget {
  withWorkspacePath: EnvironmentStatus;
  withoutWorkspacePath: EnvironmentStatus;
}

type EnvironmentLifecycleTarget =
  | EnvironmentStatus
  | EnvironmentLifecyclePathDependentTarget;

export const ENVIRONMENT_LIFECYCLE: Record<
  EnvironmentStatus,
  Partial<Record<EnvironmentLifecycleEventType, EnvironmentLifecycleTarget>>
> = {
  provisioning: {
    "provision.succeeded": "ready",
    "provision.failed": "error",
    "provision.cancelled": {
      withWorkspacePath: "ready",
      withoutWorkspacePath: "destroyed",
    },
  },
  ready: {
    "provision.requested": "provisioning",
    "destroy.recorded": "destroyed",
  },
  error: {
    "provision.requested": "provisioning",
    "destroy.recorded": "destroyed",
  },
  destroyed: {},
};

export interface EnvironmentLifecycleRowState {
  path: string | null;
  status: EnvironmentStatus;
}

export type EnvironmentLifecycleNoopReason = "illegal-transition";

type EnvironmentLifecycleEvaluation =
  | { to: EnvironmentStatus }
  | { noop: EnvironmentLifecycleNoopReason; detail: string };

interface EvaluateEnvironmentLifecycleEventArgs {
  environment: EnvironmentLifecycleRowState;
  event: EnvironmentLifecycleEvent;
}

export function evaluateEnvironmentLifecycleEvent(
  args: EvaluateEnvironmentLifecycleEventArgs,
): EnvironmentLifecycleEvaluation {
  const { environment, event } = args;
  const target = ENVIRONMENT_LIFECYCLE[environment.status][event.type];
  if (target === undefined) {
    return {
      noop: "illegal-transition",
      detail: `no transition for ${event.type} from status ${environment.status}`,
    };
  }
  if (typeof target === "string") {
    return { to: target };
  }
  return {
    to:
      environment.path !== null
        ? target.withWorkspacePath
        : target.withoutWorkspacePath,
  };
}
