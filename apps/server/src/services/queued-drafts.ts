import {
  deleteDraft,
  getDraft,
  getThread,
  listDrafts,
} from "@bb/db";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { toQueuedMessage } from "./drafts.js";
import { requireThreadEnvironment } from "./entity-lookup.js";
import {
  buildExecutionOptions,
  queueReadyThreadTurnCommand,
  queueTurnSteerCommand,
} from "./thread-commands.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
} from "./thread-turn-dispatch.js";
import {
  appendClientTurnEvent,
  getLastTurnId,
} from "./thread-events.js";
import { tryTransition } from "./thread-transitions.js";

interface SendQueuedDraftArgs {
  draftId: string;
  threadId: string;
}

function resolveQueuedDraftSendMode(
  threadStatus: Thread["status"],
): "start" | "steer" {
  if (threadStatus === "active") {
    return "steer";
  }

  return "start";
}

export async function sendQueuedDraft(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedDraftArgs,
): Promise<ThreadQueuedMessage> {
  const draft = getDraft(deps.db, args.draftId);
  if (!draft || draft.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Draft not found");
  }

  const queuedMessage = toQueuedMessage(draft);
  const { environment, thread } = requireThreadEnvironment(deps.db, args.threadId);
  const execution = await buildExecutionOptions(
    deps,
    queuedMessage,
    {
      hostId: environment.hostId,
      providerId: thread.providerId,
      threadId: thread.id,
    },
    "client/turn/requested",
  );

  if (
    queueTurnDuringReprovision({
      deps,
      environment,
      execution,
      input: queuedMessage.content,
      onQueued: () => {
        deleteDraft(deps.db, deps.hub, draft.id);
      },
      thread,
    })
  ) {
    return queuedMessage;
  }

  const readyEnvironment = requireReadyThreadEnvironment(environment);
  const eventSequence = appendClientTurnEvent(deps, {
    threadId: thread.id,
    environmentId: readyEnvironment.id,
    type: "client/turn/requested",
    input: queuedMessage.content,
    execution,
    initiator: "user",
    requestMethod: "turn/start",
    source: "tell",
  });

  if (resolveQueuedDraftSendMode(thread.status) === "start") {
    await queueReadyThreadTurnCommand(deps, {
      thread,
      input: queuedMessage.content,
      eventSequence,
      execution,
      environment: {
        id: readyEnvironment.id,
        hostId: readyEnvironment.hostId,
        path: readyEnvironment.path,
      },
    });
    tryTransition(deps.db, deps.hub, thread.id, "active");
  } else {
    const expectedTurnId = getLastTurnId(deps, thread.id);
    if (!expectedTurnId) {
      throw new ApiError(409, "invalid_request", "No active turn to steer");
    }
    await queueTurnSteerCommand(deps, {
      thread,
      input: queuedMessage.content,
      eventSequence,
      execution,
      expectedTurnId,
      environment: {
        id: readyEnvironment.id,
        hostId: readyEnvironment.hostId,
        path: readyEnvironment.path,
      },
    });
  }

  deleteDraft(deps.db, deps.hub, draft.id);
  return queuedMessage;
}

export async function sendNextQueuedDraftIfPresent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { threadId: string },
): Promise<boolean> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.archivedAt) {
    return false;
  }

  const [nextDraft] = listDrafts(deps.db, args.threadId);
  if (!nextDraft) {
    return false;
  }

  await sendQueuedDraft(deps, {
    draftId: nextDraft.id,
    threadId: args.threadId,
  });
  return true;
}
