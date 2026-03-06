import type {
  WorkflowCompatibilityResult,
  WorkflowDefinitionSummary,
  WorkflowKind,
} from "@beanbag/agent-core";
import { assertNever, type ThreadStatus } from "@beanbag/agent-core";
import type { IEnvironment } from "@beanbag/environment";

const BRANCH_COMMIT_MERGE_INSTRUCTIONS = [
  "[Beanbag branch-commit-merge workflow]",
  "- You are running in an isolated branch workspace for this thread.",
  "- Commit your work before reporting completion.",
  "- Use the primary checkout only for manual verification when needed, then return to the thread workspace.",
  "- Treat squash-merge back into the primary branch as the workflow completion step.",
].join("\n");

export interface WorkflowDefinition {
  kind: WorkflowKind;
  displayName: string;
  description?: string;
  checkCompatibility(environment: IEnvironment): WorkflowCompatibilityResult;
  buildInstructions(): string | undefined;
}

export type WorkflowOperationPolicyAction =
  | "promote"
  | "demote"
  | "commit"
  | "squash_merge";

export interface WorkflowOperationPolicyContext {
  status: ThreadStatus;
  archived: boolean;
  primaryCheckoutActive: boolean;
}

export interface WorkflowOperationPolicyDecision {
  allowed: boolean;
  reason?: string;
  shouldQueue?: boolean;
  requiresDemoteFirst: boolean;
}

function resolveQueueBehavior(status: ThreadStatus): boolean | undefined {
  switch (status) {
    case "idle":
      return false;
    case "active":
      return true;
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

const NOOP_WORKFLOW: WorkflowDefinition = {
  kind: "noop",
  displayName: "No Structured Workflow",
  description: "No pre-defined branch, commit, or merge policy.",
  checkCompatibility() {
    return { ok: true, missingRequirements: [] };
  },
  buildInstructions() {
    return undefined;
  },
};

const BRANCH_COMMIT_MERGE_WORKFLOW: WorkflowDefinition = {
  kind: "branch-commit-merge",
  displayName: "Branch, Commit, Merge",
  description: "Work in an isolated branch workspace and complete with commit and merge-back.",
  checkCompatibility(environment: IEnvironment) {
    const missingRequirements = [];
    if (!environment.isIsolatedWorkspace()) {
      missingRequirements.push({
        capability: "isolated_workspace",
        reason: "Workflow requires an isolated workspace",
      });
    }
    if (!environment.supportsPromoteToActiveWorkspace()) {
      missingRequirements.push({
        capability: "promote_primary_checkout",
        reason: "Workflow requires primary checkout promotion support",
      });
    }
    if (!environment.supportsDemoteFromActiveWorkspace()) {
      missingRequirements.push({
        capability: "demote_primary_checkout",
        reason: "Workflow requires primary checkout demotion support",
      });
    }
    if (!environment.supportsSquashMergeIntoDefaultBranch()) {
      missingRequirements.push({
        capability: "squash_merge",
        reason: "Workflow requires merge-back support",
      });
    }
    return {
      ok: missingRequirements.length === 0,
      missingRequirements,
    };
  },
  buildInstructions() {
    return BRANCH_COMMIT_MERGE_INSTRUCTIONS;
  },
};

const DEFINITIONS: Record<WorkflowKind, WorkflowDefinition> = {
  noop: NOOP_WORKFLOW,
  "branch-commit-merge": BRANCH_COMMIT_MERGE_WORKFLOW,
};

export class WorkflowService {
  listDefinitions(): WorkflowDefinitionSummary[] {
    return Object.values(DEFINITIONS).map((definition) => ({
      kind: definition.kind,
      displayName: definition.displayName,
      description: definition.description,
      requiredEnvironmentCapabilities:
        definition.kind === "branch-commit-merge"
          ? [
              "isolated_workspace",
              "promote_primary_checkout",
              "demote_primary_checkout",
              "squash_merge",
            ]
          : [],
    }));
  }

  getDefinition(kind: WorkflowKind): WorkflowDefinition {
    return DEFINITIONS[kind];
  }

  resolveWorkflowId(requested?: WorkflowKind): WorkflowKind {
    return requested ?? "noop";
  }

  evaluateOperationPolicy(
    workflowId: WorkflowKind,
    action: WorkflowOperationPolicyAction,
    context: WorkflowOperationPolicyContext,
  ): WorkflowOperationPolicyDecision {
    if (context.archived) {
      return {
        allowed: false,
        reason: "Archived threads cannot run this operation",
        requiresDemoteFirst: false,
      };
    }

    switch (workflowId) {
      case "noop":
        return this.evaluateNoopOperationPolicy(action, context);
      case "branch-commit-merge":
        return this.evaluateBranchCommitMergeOperationPolicy(action, context);
      default:
        return assertNever(workflowId);
    }
  }

  shouldAutoArchiveOnSuccess(args: {
    workflowId: WorkflowKind;
    operation: "commit" | "squash_merge";
    requested?: boolean;
  }): boolean {
    switch (args.workflowId) {
      case "noop":
        return args.requested === true;
      case "branch-commit-merge":
        if (args.operation !== "squash_merge") {
          return false;
        }
        return args.requested !== false;
      default:
        return assertNever(args.workflowId);
    }
  }

  private evaluateNoopOperationPolicy(
    action: WorkflowOperationPolicyAction,
    context: WorkflowOperationPolicyContext,
  ): WorkflowOperationPolicyDecision {
    switch (action) {
      case "promote":
      case "demote":
        return {
          allowed: false,
          reason: "This workflow does not support primary checkout promotion",
          requiresDemoteFirst: false,
        };
      case "commit":
      case "squash_merge": {
        const shouldQueue = resolveQueueBehavior(context.status);
        if (shouldQueue === undefined) {
          return {
            allowed: false,
            reason: resolveIntentStatusBlockReason(context.status),
            requiresDemoteFirst: false,
          };
        }
        return {
          allowed: true,
          shouldQueue,
          requiresDemoteFirst: false,
        };
      }
      default:
        return assertNever(action);
    }
  }

  private evaluateBranchCommitMergeOperationPolicy(
    action: WorkflowOperationPolicyAction,
    context: WorkflowOperationPolicyContext,
  ): WorkflowOperationPolicyDecision {
    switch (action) {
      case "promote":
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
      case "demote":
        return {
          allowed: true,
          requiresDemoteFirst: false,
        };
      case "commit":
      case "squash_merge": {
        const shouldQueue = resolveQueueBehavior(context.status);
        if (shouldQueue === undefined) {
          return {
            allowed: false,
            reason: resolveIntentStatusBlockReason(context.status),
            requiresDemoteFirst: false,
          };
        }
        return {
          allowed: true,
          shouldQueue,
          requiresDemoteFirst: context.primaryCheckoutActive,
        };
      }
      default:
        return assertNever(action);
    }
  }
}
