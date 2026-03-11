import {
  assertNever,
  type UIOperationMessage,
} from "@beanbag/agent-core";

type ThreadOperationIntentPhase = NonNullable<UIOperationMessage["threadOperation"]>["phase"];
type PrimaryCheckoutPhase = NonNullable<UIOperationMessage["primaryCheckout"]>["phase"];

function isShimmeringThreadOperationIntentPhase(
  phase: ThreadOperationIntentPhase,
): boolean {
  switch (phase) {
    case "requested":
    case "queued":
    case "running":
      return true;
    case "completed":
    case "failed":
    case "update":
      return false;
    default:
      return assertNever(phase);
  }
}

function isShimmeringPrimaryCheckoutPhase(phase: PrimaryCheckoutPhase): boolean {
  switch (phase) {
    case "started":
      return true;
    case "completed":
    case "failed":
    case "noop":
    case "update":
      return false;
    default:
      return assertNever(phase);
  }
}

function shouldShimmerProvisioningOperation(message: UIOperationMessage): boolean {
  if (message.status !== "pending") return false;
  switch (message.title) {
    case "Environment setup completed":
    case "Environment setup failed":
    case "Environment setup interrupted":
      return false;
    default:
      return true;
  }
}

function shouldShimmerThreadOperationIntent(message: UIOperationMessage): boolean {
  if (message.threadOperation) {
    return isShimmeringThreadOperationIntentPhase(message.threadOperation.phase);
  }
  switch (message.title) {
    case "Commit requested":
    case "Commit queued":
    case "Committing changes":
    case "Squash merge requested":
    case "Squash merge queued":
    case "Squash merging changes":
      return true;
    default:
      return false;
  }
}

function shouldShimmerPrimaryCheckoutOperation(message: UIOperationMessage): boolean {
  if (message.primaryCheckout) {
    return isShimmeringPrimaryCheckoutPhase(message.primaryCheckout.phase);
  }
  switch (message.title) {
    case "Promoting primary checkout":
    case "Demoting primary checkout":
      return true;
    default:
      return false;
  }
}

export function shouldShimmerOperationTitle(message: UIOperationMessage): boolean {
  switch (message.opType) {
    case "mcp-progress":
      return true;
    case "provisioning":
      return shouldShimmerProvisioningOperation(message);
    case "thread-operation-intent":
      return shouldShimmerThreadOperationIntent(message);
    case "primary-checkout":
      return shouldShimmerPrimaryCheckoutOperation(message);
    default:
      // opType is stringly/open_external at the UI boundary; unknown values are intentionally not treated as ongoing.
      return false;
  }
}
