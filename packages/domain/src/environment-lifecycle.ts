import type { EnvironmentStatus } from "./environment.js";

export type EnvironmentLifecycleEvent =
  | { type: "provision.requested" }
  | { type: "provision.succeeded" }
  | { type: "provision.failed" }
  | { type: "provision.cancelled" }
  | { type: "retire.requested" }
  | { type: "retire.cancelled" }
  | { type: "destroy.started"; destroyAttemptId: string }
  | { type: "destroy.completed"; destroyAttemptId: string | null }
  | { type: "destroy.failed"; destroyAttemptId: string }
  | { type: "destroy.lost" };

export type EnvironmentLifecycleEventType = EnvironmentLifecycleEvent["type"];

interface EnvironmentLifecycleSupersessionPredicates {
  managed?: true;
  matchingDestroyAttempt?: true;
}

export const ENVIRONMENT_LIFECYCLE_EVENT_PREDICATES: Record<
  EnvironmentLifecycleEventType,
  EnvironmentLifecycleSupersessionPredicates
> = {
  "provision.requested": {},
  "provision.succeeded": {},
  "provision.failed": {},
  "provision.cancelled": {},
  "retire.requested": { managed: true },
  "retire.cancelled": {},
  "destroy.started": { managed: true },
  "destroy.completed": { matchingDestroyAttempt: true },
  "destroy.failed": { matchingDestroyAttempt: true },
  "destroy.lost": {},
};

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
      withoutWorkspacePath: "destroying",
    },
  },
  ready: {
    "provision.requested": "provisioning",
    "retire.requested": "retiring",
  },
  retiring: {
    "retire.cancelled": "ready",
    "destroy.started": "destroying",
  },
  error: {
    "provision.requested": "provisioning",
    "destroy.started": "destroying",
    "destroy.completed": "destroyed",
  },
  destroying: {
    "destroy.completed": "destroyed",
    "destroy.failed": "retiring",
    "destroy.lost": "error",
  },
  destroyed: {},
};

export interface EnvironmentLifecycleRowState {
  destroyAttemptId: string | null;
  managed: boolean;
  path: string | null;
  status: EnvironmentStatus;
}

export type EnvironmentLifecycleNoopReason =
  | "illegal-transition"
  | "superseded";

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
  const predicates = ENVIRONMENT_LIFECYCLE_EVENT_PREDICATES[event.type];
  if (predicates.managed && !environment.managed) {
    return { noop: "superseded", detail: "environment is not managed" };
  }
  if (
    predicates.matchingDestroyAttempt &&
    "destroyAttemptId" in event &&
    event.destroyAttemptId !== environment.destroyAttemptId
  ) {
    return { noop: "superseded", detail: "destroyAttemptId mismatch" };
  }

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
