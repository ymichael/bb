import {
  type UIOperationMessage,
} from "@bb/core";

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

function shouldShimmerOperation(message: UIOperationMessage): boolean {
  if (message.threadOperation) {
    const status = message.threadOperation.status;
    return status === "requested" || status === "queued" || status === "running" || status === "started";
  }
  switch (message.title) {
    case "Commit requested":
    case "Commit queued":
    case "Committing changes":
    case "Squash merge requested":
    case "Squash merge queued":
    case "Squash merging changes":
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
    case "operation":
      return shouldShimmerOperation(message);
    default:
      // opType is stringly/open_external at the UI boundary; unknown values are intentionally not treated as ongoing.
      return false;
  }
}
