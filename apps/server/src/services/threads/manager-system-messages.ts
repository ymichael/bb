import { getThread } from "@bb/db";
import type {
  PromptInput,
  ResolvedThreadExecutionOptions,
  Thread,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import {
  buildExecutionOptions,
  ensureThreadNativeArchiveSettled,
  queueTurnSubmitCommand,
} from "./thread-commands.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import { appendClientTurnEvent, getActiveTurnId } from "./thread-events.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
  type ReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import {
  type ManagerDynamicFileDeliveryStateUpdate,
  prependManagerPreferencesSystemMessageIfChanged,
  recordManagerDynamicFileDelivery,
  withManagerPreferencesDeliveryLock,
} from "./manager-dynamic-file-delivery.js";
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
  stateUpdate: ManagerDynamicFileDeliveryStateUpdate | null;
  thread: Thread;
}

function buildSystemInput(messageText: string): PromptInput[] {
  return [{ type: "text", text: messageText }];
}

async function queueReadyManagerSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueReadyManagerSystemMessageArgs,
): Promise<void> {
  const expectedSteerTurnId =
    args.thread.status === "active"
      ? getActiveTurnId(deps, args.thread.id)
      : null;

  const request = appendClientTurnEvent(deps, {
    threadId: args.thread.id,
    environmentId: args.environment.id,
    type: "client/turn/requested",
    input: args.input,
    execution: args.execution,
    initiator: "system",
    senderThreadId: null,
    requestMethod: "turn/start",
    source: MANAGER_SYSTEM_MESSAGE_SOURCE,
    target:
      args.thread.status === "active"
        ? {
            kind: "auto",
            expectedTurnId: expectedSteerTurnId,
          }
        : { kind: "new-turn" },
  });
  const permissionEscalation = resolvePermissionEscalation({
    thread: args.thread,
    initiator: "system",
  });

  if (args.thread.status === "active") {
    await queueTurnSubmitCommand(deps, {
      thread: args.thread,
      input: args.input,
      requestId: request.requestId,
      execution: args.execution,
      permissionEscalation,
      target: {
        mode: "auto",
        expectedTurnId: expectedSteerTurnId,
      },
      environment: {
        id: args.environment.id,
        hostId: args.environment.hostId,
        path: args.environment.path,
        workspaceProvisionType: args.environment.workspaceProvisionType,
      },
    });
    recordManagerDynamicFileDelivery(deps, args.stateUpdate);
    return;
  }

  ensureThreadCanQueueStartRequest(deps, args.thread);
  const queuedMode = await queueReadyThreadTurnCommand(deps, {
    thread: args.thread,
    input: args.input,
    requestId: request.requestId,
    execution: args.execution,
    permissionEscalation,
    environment: {
      id: args.environment.id,
      hostId: args.environment.hostId,
      path: args.environment.path,
      workspaceProvisionType: args.environment.workspaceProvisionType,
    },
  });
  if (queuedMode === "turn.submit") {
    tryTransition(deps.db, deps.hub, args.thread.id, "active");
  }
  recordManagerDynamicFileDelivery(deps, args.stateUpdate);
}

export async function queueManagerSystemMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueueManagerSystemMessageArgs,
): Promise<boolean> {
  const managerThread = getThread(deps.db, args.managerThreadId);
  if (
    !managerThread ||
    managerThread.type !== "manager" ||
    managerThread.archivedAt !== null ||
    managerThread.deletedAt !== null
  ) {
    return false;
  }
  if (deps.pendingInteractions.hasPendingThreadInteraction(managerThread.id)) {
    return false;
  }

  const { environment } = requireThreadEnvironment(
    deps.db,
    args.managerThreadId,
  );
  ensureThreadNativeArchiveSettled(deps, {
    environment,
    thread: managerThread,
  });
  const input = buildSystemInput(args.messageText);
  const execution = await buildExecutionOptions(
    deps,
    {},
    {
      threadId: managerThread.id,
    },
    "client/turn/requested",
  );
  await withManagerPreferencesDeliveryLock(
    { thread: managerThread },
    async () => {
      const preparedInput =
        await prependManagerPreferencesSystemMessageIfChanged(deps, {
          hostId: environment.hostId,
          input,
          mode: "change-detection",
          thread: managerThread,
        });

      if (
        await queueTurnDuringReprovision({
          deps,
          environment,
          execution,
          initiator: "system",
          input: preparedInput.input,
          senderThreadId: null,
          thread: managerThread,
        })
      ) {
        recordManagerDynamicFileDelivery(deps, preparedInput.stateUpdate);
        return;
      }

      const readyEnvironment = requireReadyThreadEnvironment(environment);
      await queueReadyManagerSystemMessage(deps, {
        thread: managerThread,
        input: preparedInput.input,
        stateUpdate: preparedInput.stateUpdate,
        execution,
        environment: readyEnvironment,
      });
    },
  );
  return true;
}
