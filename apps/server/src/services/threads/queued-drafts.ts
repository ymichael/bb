import {
  claimDraft,
  claimNextDraft,
  deleteDraft,
  getDraft,
  getThread,
  releaseDraftClaim,
} from "@bb/db";
import type { Thread, ThreadQueuedMessage } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { toQueuedMessage } from "./drafts.js";
import { requireThreadEnvironment } from "../lib/entity-lookup.js";
import {
  buildExecutionOptions,
  queueTurnSteerCommand,
} from "./thread-commands.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
} from "./thread-lifecycle.js";
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

type ClaimedDraft = Exclude<ReturnType<typeof claimDraft>, null>;

function resolveQueuedDraftSendMode(
  threadStatus: Thread["status"],
): "start" | "steer" {
  if (threadStatus === "active") {
    return "steer";
  }

  return "start";
}

function claimDraftForSend(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedDraftArgs,
): ClaimedDraft {
  const existingDraft = getDraft(deps.db, args.draftId);
  if (!existingDraft || existingDraft.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Draft not found");
  }

  const claimedDraft = claimDraft(deps.db, deps.hub, args.draftId);
  if (claimedDraft) {
    return claimedDraft;
  }

  const latestDraft = getDraft(deps.db, args.draftId);
  if (!latestDraft || latestDraft.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Draft not found");
  }
  throw new ApiError(409, "invalid_request", "Draft is already being sent");
}

async function sendClaimedDraft(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    draft: ClaimedDraft;
    threadId: string;
  },
): Promise<ThreadQueuedMessage> {
  const draft = args.draft;
  const queuedMessage = toQueuedMessage(draft);
  const { environment, thread } = requireThreadEnvironment(deps.db, args.threadId);
  if (resolveQueuedDraftSendMode(thread.status) === "start") {
    ensureThreadCanQueueStartRequest(deps, thread);
  }
  const execution = await buildExecutionOptions(
    deps,
    queuedMessage,
    {
      threadId: thread.id,
    },
    "client/turn/requested",
  );

  if (
    queueTurnDuringReprovision({
      deps,
      environment,
      execution,
      initiator: "user",
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
    const queuedMode = await queueReadyThreadTurnCommand(deps, {
      thread,
      input: queuedMessage.content,
      eventSequence,
      execution,
      environment: {
        id: readyEnvironment.id,
        hostId: readyEnvironment.hostId,
        path: readyEnvironment.path,
        workspaceProvisionType: readyEnvironment.workspaceProvisionType,
      },
    });
    if (queuedMode === "turn.run") {
      tryTransition(deps.db, deps.hub, thread.id, "active");
    }
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
        workspaceProvisionType: readyEnvironment.workspaceProvisionType,
      },
    });
  }

  deleteDraft(deps.db, deps.hub, draft.id);
  return queuedMessage;
}

export async function sendQueuedDraft(
  deps: Pick<AppDeps, "db" | "hub">,
  args: SendQueuedDraftArgs,
): Promise<ThreadQueuedMessage> {
  const draft = claimDraftForSend(deps, args);
  try {
    return await sendClaimedDraft(deps, {
      draft,
      threadId: args.threadId,
    });
  } catch (error) {
    releaseDraftClaim(deps.db, deps.hub, draft.id);
    throw error;
  }
}

export async function sendNextQueuedDraftIfPresent(
  deps: Pick<AppDeps, "db" | "hub">,
  args: { threadId: string },
): Promise<boolean> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread || thread.archivedAt) {
    return false;
  }

  const nextDraft = claimNextDraft(deps.db, deps.hub, args.threadId);
  if (!nextDraft) {
    return false;
  }

  try {
    await sendClaimedDraft(deps, {
      draft: nextDraft,
      threadId: args.threadId,
    });
  } catch (error) {
    releaseDraftClaim(deps.db, deps.hub, nextDraft.id);
    throw error;
  }
  return true;
}
