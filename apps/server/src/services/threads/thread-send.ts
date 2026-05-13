import { getThread } from "@bb/db";
import type {
  Environment,
  PromptInput,
  Thread,
  ThreadStatus,
  ThreadTurnInitiator,
} from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import { renderTemplate } from "@bb/templates";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  buildExecutionOptions,
  ensureThreadNativeArchiveSettled,
  queueTurnSubmitCommand,
} from "./thread-commands.js";
import { appendClientTurnEvent, getActiveTurnId } from "./thread-events.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import { resolvePermissionEscalation } from "./thread-runtime-config.js";
import { resolveThreadRuntimeState } from "./thread-runtime-display.js";
import { tryTransition } from "./thread-transitions.js";

type SendThreadMessageMode = SendMessageRequest["mode"];
type TextPromptInput = Extract<PromptInput, { type: "text" }>;
export type SendThreadMessageTrigger = "auto-dispatch" | "user";

export interface SendThreadMessageArgs {
  environment: Environment;
  payload: SendMessageRequest;
  thread: Thread;
  trigger: SendThreadMessageTrigger;
}

interface ResolveMessageSenderArgs {
  senderThreadId?: string;
  targetThread: Thread;
}

interface FormatAgentThreadInputArgs {
  input: PromptInput[];
  senderThreadId: string;
}

interface BuildAgentThreadMessageTextArgs {
  messageText: string;
  senderThreadId: string;
}

export function ensureThreadIsNotAwaitingUserInteraction(
  deps: Pick<AppDeps, "pendingInteractions">,
  threadId: string,
): void {
  if (!deps.pendingInteractions.hasPendingThreadInteraction(threadId)) {
    return;
  }

  throw new ApiError(
    409,
    "awaiting_user_interaction",
    "Thread is awaiting user interaction. Resolve the pending interaction before sending another prompt.",
  );
}

export function ensureThreadIsWritable(thread: Thread): void {
  if (thread.archivedAt) {
    throw new ApiError(409, "invalid_request", "Thread is archived");
  }
  if (thread.stopRequestedAt !== null) {
    throw new ApiError(409, "invalid_request", "Thread is stopping");
  }
}

function resolveSendMode(
  threadStatus: ThreadStatus,
  requestedMode: SendThreadMessageMode,
): "start" | "auto" | "steer" {
  if (requestedMode === "start") {
    if (threadStatus === "active") {
      throw new ApiError(409, "invalid_request", "Thread is already active");
    }
    return "start";
  }
  if (requestedMode === "steer") {
    if (threadStatus !== "active") {
      throw new ApiError(409, "invalid_request", "Thread is not active");
    }
    return "steer";
  }
  if (threadStatus === "active") {
    return "auto";
  }
  return "start";
}

function ensureRuntimeCanAcceptActiveSend(
  deps: Pick<AppDeps, "db">,
  args: Pick<SendThreadMessageArgs, "environment" | "thread">,
): void {
  if (args.thread.status !== "active") {
    return;
  }

  const runtime = resolveThreadRuntimeState(deps, {
    environmentHostId: args.environment.hostId,
    status: args.thread.status,
  });
  if (runtime.displayStatus === "active") {
    return;
  }

  throw new ApiError(502, "host_disconnected", "Host daemon is not connected");
}

function resolveMessageSenderThreadId(
  deps: Pick<AppDeps, "db">,
  args: ResolveMessageSenderArgs,
): string | null {
  if (!args.senderThreadId || args.senderThreadId === args.targetThread.id) {
    return null;
  }

  const senderThread = getThread(deps.db, args.senderThreadId);
  if (!senderThread || senderThread.deletedAt !== null) {
    throw new ApiError(
      400,
      "invalid_request",
      "senderThreadId must reference a live thread",
    );
  }

  return senderThread.id;
}

function buildAgentThreadMessageText(
  args: BuildAgentThreadMessageTextArgs,
): string {
  return renderTemplate("agentThreadMessage", {
    messageText: args.messageText,
    senderThreadId: args.senderThreadId,
  });
}

function formatAgentThreadInput(
  args: FormatAgentThreadInputArgs,
): PromptInput[] {
  const firstTextIndex = args.input.findIndex((item) => item.type === "text");
  if (firstTextIndex === -1) {
    const textItem: TextPromptInput = {
      type: "text",
      text: buildAgentThreadMessageText({
        messageText: "",
        senderThreadId: args.senderThreadId,
      }),
    };
    return [textItem, ...args.input];
  }

  return args.input.map((item, index) => {
    if (index !== firstTextIndex || item.type !== "text") {
      return item;
    }
    return {
      ...item,
      text: buildAgentThreadMessageText({
        messageText: item.text,
        senderThreadId: args.senderThreadId,
      }),
    };
  });
}

export async function sendThreadMessage(
  deps: AppDeps,
  args: SendThreadMessageArgs,
): Promise<void> {
  const { environment, payload, thread } = args;
  ensureThreadIsWritable(thread);
  ensureThreadNativeArchiveSettled(deps, { environment, thread });
  if (args.trigger === "user") {
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
  }
  const mode = resolveSendMode(thread.status, payload.mode);
  ensureRuntimeCanAcceptActiveSend(deps, args);
  if (mode === "start") {
    ensureThreadCanQueueStartRequest(deps, thread);
  }
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  const input = senderThreadId
    ? formatAgentThreadInput({
        input: payload.input,
        senderThreadId,
      })
    : payload.input;
  // Agent-originated CLI sends still appear as normal turn requests in
  // timeline/prompt history, while initiator lets policy distinguish the source.
  const initiator: ThreadTurnInitiator = senderThreadId ? "agent" : "user";
  const expectedSteerTurnId =
    mode === "auto" || mode === "steer"
      ? getActiveTurnId(deps, thread.id)
      : null;
  const execution = await buildExecutionOptions(
    deps,
    payload,
    {
      threadId: thread.id,
    },
    "client/turn/requested",
  );
  const permissionEscalation = resolvePermissionEscalation({
    thread,
    initiator,
  });

  if (
    await queueTurnDuringReprovision({
      deps,
      environment,
      execution,
      initiator,
      input,
      thread,
    })
  ) {
    return;
  }
  const readyEnvironment = requireReadyThreadEnvironment(environment);

  const request = appendClientTurnEvent(deps, {
    threadId: thread.id,
    environmentId: readyEnvironment.id,
    type: "client/turn/requested",
    input,
    execution,
    initiator,
    requestMethod: "turn/start",
    source: "tell",
    target:
      mode === "start"
        ? { kind: "new-turn" }
        : {
            kind: mode,
            expectedTurnId: expectedSteerTurnId,
          },
  });

  if (mode === "start") {
    const queuedMode = await queueReadyThreadTurnCommand(deps, {
      thread,
      input,
      requestId: request.requestId,
      execution,
      permissionEscalation,
      environment: {
        id: readyEnvironment.id,
        hostId: readyEnvironment.hostId,
        path: readyEnvironment.path,
        workspaceProvisionType: readyEnvironment.workspaceProvisionType,
      },
    });
    if (queuedMode === "turn.submit") {
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }
    return;
  }

  await queueTurnSubmitCommand(deps, {
    thread,
    input,
    requestId: request.requestId,
    execution,
    permissionEscalation,
    target: {
      mode,
      expectedTurnId: expectedSteerTurnId,
    },
    environment: {
      id: readyEnvironment.id,
      hostId: readyEnvironment.hostId,
      path: readyEnvironment.path,
      workspaceProvisionType: readyEnvironment.workspaceProvisionType,
    },
  });
}
