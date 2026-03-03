import { assertNever, type ThreadStatus } from "@beanbag/agent-core";

export type ThreadOperationPolicyAction =
  | "promote"
  | "demote"
  | "commit-intent"
  | "squash-intent";

export type ThreadIntentDispatchMode = "immediate" | "queued";

export interface ThreadOperationPolicyContext {
  status: ThreadStatus;
  archived: boolean;
  primaryCheckoutActive: boolean;
}

export interface ThreadOperationPolicyDecision {
  allowed: boolean;
  reason?: string;
  dispatchMode?: ThreadIntentDispatchMode;
  requiresDemoteFirst: boolean;
}

function resolveIntentDispatchMode(status: ThreadStatus): ThreadIntentDispatchMode | undefined {
  switch (status) {
    case "idle":
      return "immediate";
    case "active":
      return "queued";
    case "created":
    case "provisioning":
    case "provisioning_failed":
      return undefined;
    default:
      return assertNever(status);
  }
}

function resolveIntentStatusBlockReason(status: ThreadStatus): string {
  switch (status) {
    case "created":
    case "provisioning":
      return "Thread provisioning is in progress; wait until the thread is idle or active";
    case "provisioning_failed":
      return "Thread provisioning failed; reprovision the thread before requesting operations";
    case "idle":
    case "active":
      return "Operation intents are available for idle or active threads only";
    default:
      return assertNever(status);
  }
}

export function evaluateThreadOperationPolicy(
  action: ThreadOperationPolicyAction,
  context: ThreadOperationPolicyContext,
): ThreadOperationPolicyDecision {
  if (context.archived) {
    return {
      allowed: false,
      reason: "Archived threads cannot run this operation",
      requiresDemoteFirst: false,
    };
  }

  switch (action) {
    case "promote": {
      if (context.status !== "idle") {
        return {
          allowed: false,
          reason: "Promotion requires an idle thread",
          requiresDemoteFirst: false,
        };
      }
      return {
        allowed: true,
        requiresDemoteFirst: false,
      };
    }
    case "demote":
      return {
        allowed: true,
        requiresDemoteFirst: false,
      };
    case "commit-intent":
    case "squash-intent": {
      const dispatchMode = resolveIntentDispatchMode(context.status);
      if (!dispatchMode) {
        return {
          allowed: false,
          reason: resolveIntentStatusBlockReason(context.status),
          requiresDemoteFirst: false,
        };
      }
      return {
        allowed: true,
        dispatchMode,
        requiresDemoteFirst: context.primaryCheckoutActive,
      };
    }
    default:
      return assertNever(action);
  }
}
