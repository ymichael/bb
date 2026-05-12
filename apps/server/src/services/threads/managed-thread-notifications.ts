import type { ThreadEventTurnStatus } from "@bb/domain";
import { renderTemplate } from "@bb/templates";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { queueManagerSystemMessage } from "./manager-system-messages.js";

interface RenderManagedThreadTurnStatusMessageArgs {
  managedThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
}

export interface QueueManagedThreadTurnNotificationArgs {
  managedThreadId: string;
  managerThreadId: string;
  title: string | null;
  turnStatus: ThreadEventTurnStatus;
}

function formatManagedThreadTitleSuffix(title: string | null): string {
  return title ? ` (${title})` : "";
}

function renderManagedThreadTurnStatusMessage(
  args: RenderManagedThreadTurnStatusMessageArgs,
): string {
  const variables = {
    threadId: args.managedThreadId,
    titleSuffix: formatManagedThreadTitleSuffix(args.title),
  };

  switch (args.turnStatus) {
    case "completed":
      return renderTemplate("systemMessageManagedThreadComplete", variables);
    case "failed":
      return renderTemplate("systemMessageManagedThreadFailed", variables);
    case "interrupted":
      return renderTemplate("systemMessageManagedThreadInterrupted", variables);
    default: {
      const exhaustiveCheck: never = args.turnStatus;
      return exhaustiveCheck;
    }
  }
}

/**
 * Queues a manager-facing notification for managed thread turn outcomes.
 * Normal turn-completion event side effects pass the actual terminal status;
 * command-result failures pass `failed` because no terminal turn event exists.
 * This is best-effort post-commit notification work.
 */
export async function queueManagedThreadTurnNotificationBestEffort(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueManagedThreadTurnNotificationArgs,
): Promise<void> {
  try {
    await queueManagerSystemMessage(deps, {
      managerThreadId: args.managerThreadId,
      messageText: renderManagedThreadTurnStatusMessage(args),
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        managedThreadId: args.managedThreadId,
        managerThreadId: args.managerThreadId,
        turnStatus: args.turnStatus,
      },
      "Failed to queue manager turn notification",
    );
  }
}
