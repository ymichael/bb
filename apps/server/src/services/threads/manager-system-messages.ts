import { getThread } from "@bb/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import type { PendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import { buildExecutionOptions, queueTurnSteerCommand } from "./thread-commands.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { appendClientTurnEvent, requireActiveTurnId } from "./thread-events.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { tryTransition } from "./thread-transitions.js";

const MANAGER_SYSTEM_MESSAGE_SOURCE = "tell";

interface QueueManagerSystemMessageArgs {
  managerThreadId: string;
  messageText: string;
}

interface QueueReadyManagerSystemMessageArgs {
  environment: ReadyThreadEnvironment;
  execution: ResolvedThreadExecutionOptions;
  input: PromptInput[];
  thread: Thread;
}

function buildSystemInput(messageText: string): PromptInput[] {
  return [{ type: "text", text: messageText }];
}

async function queueReadyManagerSystemMessage(
  deps: PendingInteractionWorkSessionDeps,
  args: QueueReadyManagerSystemMessageArgs,
): Promise<void> {
  const expectedSteerTurnId = args.thread.status === "active"
    ? requireActiveTurnId(deps, args.thread.id)
    : null;

  const eventSequence = appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "system",
    requestMethod: "turn/start",
    source: MANAGER_SYSTEM_MESSAGE_SOURCE,
  });
  const permissionEscalation = resolvePermissionEscalation({
    thread: args.thread,
    initiator: "system",
  });

  if (args.thread.status === "active") {
    if (expectedSteerTurnId === null) {
      throw new ApiError(409, "invalid_request", "No active turn to steer");
    }
    await queueTurnSteerCommand(deps, {
      thread: args.thread,
      input: args.input,
      eventSequence,
      execution: args.execution,
      permissionEscalation,
      expectedTurnId: expectedSteerTurnId,
      environment: {
        id: args.environment.id,
        hostId: args.environment.hostId,
        path: args.environment.path,
        workspaceProvisionType: args.environment.workspaceProvisionType,
      },
    });
    return;
  }

  ensureThreadCanQueueStartRequest(deps, args.thread);
  const queuedMode = await queueReadyThreadTurnCommand(deps, {
    thread: args.thread,
    input: args.input,
    eventSequence,
    execution: args.execution,
    permissionEscalation,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
  });
  if (queuedMode === "turn.run") {
    tryTransition(deps.db, deps.hub, args.thread.id, "active");
  }
}

export async function queueManagerSystemMessage(
  deps: PendingInteractionWorkSessionDeps,
  args: QueueManagerSystemMessageArgs,
): Promise<boolean> {
  const managerThread = getThread(deps.db, args.managerThreadId);
  if (
    !managerThread
    || managerThread.type !== "manager"
    || managerThread.archivedAt !== null
    || managerThread.deletedAt !== null
  ) {
    return false;
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(managerThread.id)) {
    return false;
  }

  const { environment } = requireThreadEnvironment(deps.db, args.managerThreadId);
  const input = buildSystemInput(args.messageText);
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: managerThread.id,
    },
    "client/turn/requested",
  );

  if (
    await queueTurnDuringReprovision({
      deps,
      environment,
      execution,
      initiator: "system",
      input,
      thread: managerThread,
    })
  ) {
    return true;
  }

  const readyEnvironment = requireReadyThreadEnvironment(environment);
  await queueReadyManagerSystemMessage(deps, {
    thread: managerThread,
    input,
    execution,
    environment: readyEnvironment,
  });
  return true;
}
