import { getThread } from "@bb/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import type { SandboxWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import { buildExecutionOptions, queueTurnSteerCommand } from "./thread-commands.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { appendClientTurnEvent, getLastTurnId } from "./thread-events.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
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
  deps: SandboxWorkSessionDeps,
  args: QueueReadyManagerSystemMessageArgs,
): Promise<void> {
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

  if (args.thread.status === "active") {
    const expectedTurnId = getLastTurnId(deps, args.thread.id);
    if (!expectedTurnId) {
      throw new ApiError(409, "invalid_request", "No active turn to steer");
    }
    await queueTurnSteerCommand(deps, {
      thread: args.thread,
      input: args.input,
      eventSequence,
      execution: args.execution,
      expectedTurnId,
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
  deps: SandboxWorkSessionDeps,
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
