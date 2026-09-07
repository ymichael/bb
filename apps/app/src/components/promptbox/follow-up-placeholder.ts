import type { ThreadRuntimeDisplayStatus } from "@bb/domain";
import { assertNever } from "@bb/core-ui";

export function getFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up workspace...";
    case "starting":
      return "Starting thread...";
    case "stopping":
      return "Stopping thread...";
    case "waiting-for-host":
      return "Host disconnected";
    case "host-reconnecting":
      return "Waiting for host to reconnect...";
    case "error":
      return "Retry by sending a follow-up message";
    case "pending":
    case "idle":
    case "active":
      return "Ask for a follow-up. @ to mention files, folders, sections, or threads";
    default:
      return assertNever(displayStatus);
  }
}

export function getCompactFollowUpPromptPlaceholder(
  displayStatus: ThreadRuntimeDisplayStatus,
): string {
  switch (displayStatus) {
    case "provisioning":
      return "Setting up...";
    case "starting":
      return "Starting...";
    case "stopping":
      return "Stopping...";
    case "waiting-for-host":
      return "Host disconnected";
    case "host-reconnecting":
      return "Reconnecting...";
    case "error":
      return "Send a follow-up";
    case "pending":
    case "idle":
    case "active":
      return "Ask a follow-up";
    default:
      return assertNever(displayStatus);
  }
}
