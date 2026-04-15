import {
  archiveThread,
  createDraft,
  deleteDraft,
  getDraft,
  unarchiveThread,
  updateThread,
} from "@bb/db";
import {
  archiveThreadRequestSchema,
  createDraftRequestSchema,
  sendDraftRequestSchema,
  sendMessageRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { toQueuedMessage } from "../../services/threads/drafts.js";
import {
  advanceEnvironmentCleanup,
  requestEnvironmentCleanup,
  validateEnvironmentCleanupRequest,
  wouldCleanupEnvironment,
} from "../../services/environments/environment-cleanup.js";
import {
  requirePublicThread,
  requirePublicThreadEnvironment,
} from "../../services/lib/entity-lookup.js";
import { sendQueuedDraft } from "../../services/threads/queued-drafts.js";
import {
  queueTurnDuringReprovision,
  requireReadyThreadEnvironment,
} from "../../services/threads/thread-turn-dispatch.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../../services/system/event-pruning.js";
import {
  buildExecutionOptions,
  queueTurnSteerCommand,
} from "../../services/threads/thread-commands.js";
import {
  ensureThreadCanQueueStartRequest,
  queueReadyThreadTurnCommand,
  requestThreadStopIfNeeded,
} from "../../services/threads/thread-lifecycle.js";
import {
  appendClientTurnEvent,
  requireActiveTurnId,
} from "../../services/threads/thread-events.js";
import { resolvePermissionEscalation } from "../../services/threads/thread-runtime-config.js";
import { tryTransition } from "../../services/threads/thread-transitions.js";

function ensureThreadIsWritable(thread: Thread): void {
  if (thread.archivedAt) {
    throw new ApiError(409, "invalid_request", "Thread is archived");
  }
  if (thread.stopRequestedAt !== null) {
    throw new ApiError(409, "invalid_request", "Thread is stopping");
  }
}

function ensureThreadIsNotAwaitingUserInteraction(
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

function resolveSendMode(
  threadStatus: string,
  requestedMode: "auto" | "start" | "steer",
): "start" | "steer" {
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
    return "steer";
  }
  return "start";
}

async function validateArchiveCleanupRequest(
  deps: AppDeps,
  thread: Thread,
  force: boolean,
): Promise<boolean> {
  const shouldRequestCleanup = wouldCleanupEnvironment(deps, {
    environmentId: thread.environmentId,
    excludeThreadId: thread.id,
  });

  if (!shouldRequestCleanup) {
    return false;
  }

  await validateEnvironmentCleanupRequest(deps, {
    environmentId: thread.environmentId,
    mode: force ? "force" : "safe",
  });
  return true;
}

export function registerThreadActionRoutes(app: Hono, deps: AppDeps): void {
  const { post, del } = typedRoutes<PublicApiSchema>(app, { onValidationError: (msg) => new ApiError(400, "invalid_request", msg) });

  post("/threads/:id/send", sendMessageRequestSchema, async (context, payload) => {
    const { environment, thread } = requirePublicThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
    const mode = resolveSendMode(thread.status, payload.mode);
    if (mode === "start") {
      ensureThreadCanQueueStartRequest(deps, thread);
    }
    const expectedSteerTurnId = mode === "steer"
      ? requireActiveTurnId(deps, thread.id)
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
      initiator: "user",
    });

    if (
      await queueTurnDuringReprovision({
        deps,
        environment,
        execution,
        initiator: "user",
        input: payload.input,
        thread,
      })
    ) {
      return context.json({ ok: true });
    }
    const readyEnvironment = requireReadyThreadEnvironment(environment);

    const eventSequence = appendClientTurnEvent(deps, {
      threadId: thread.id,
      environmentId: readyEnvironment.id,
      type: "client/turn/requested",
      input: payload.input,
      execution,
      initiator: "user",
      requestMethod: "turn/start",
      source: "tell",
    });

    if (mode === "start") {
      const queuedMode = await queueReadyThreadTurnCommand(deps, {
        thread,
        input: payload.input,
        eventSequence,
        execution,
        permissionEscalation,
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
      if (expectedSteerTurnId === null) {
        throw new ApiError(409, "invalid_request", "No active turn to steer");
      }
      await queueTurnSteerCommand(deps, {
        thread,
        input: payload.input,
        eventSequence,
        execution,
        permissionEscalation,
        expectedTurnId: expectedSteerTurnId,
        environment: {
          id: readyEnvironment.id,
          hostId: readyEnvironment.hostId,
          path: readyEnvironment.path,
          workspaceProvisionType: readyEnvironment.workspaceProvisionType,
        },
      });
    }

    return context.json({ ok: true });
  });

  post("/threads/:id/drafts", createDraftRequestSchema, async (context, payload) => {
    const { thread } = requirePublicThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    const execution = await buildExecutionOptions(
      deps,
      payload,
      {
        threadId: thread.id,
      },
      "client/turn/requested",
    );
    const draft = createDraft(deps.db, deps.hub, {
      threadId: context.req.param("id"),
      content: payload.input,
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      permissionMode: execution.permissionMode,
      serviceTier: execution.serviceTier,
    });
    return context.json(toQueuedMessage(draft), 201);
  });

  post("/threads/:id/drafts/:draftId/send", sendDraftRequestSchema, async (context) => {
    const { thread } = requirePublicThreadEnvironment(deps.db, context.req.param("id"));
    ensureThreadIsWritable(thread);
    ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
    const queuedMessage = await sendQueuedDraft(deps, {
      draftId: context.req.param("draftId"),
      threadId: context.req.param("id"),
    });
    return context.json({ ok: true, queuedMessage });
  });

  del("/threads/:id/drafts/:draftId", (context) => {
    const draft = getDraft(deps.db, context.req.param("draftId"));
    if (!draft || draft.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    const deleted = deleteDraft(deps.db, deps.hub, context.req.param("draftId"));
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    return context.json({ ok: true });
  });

  post("/threads/:id/stop", async (context) => {
    const { environment, thread } = requirePublicThreadEnvironment(deps.db, context.req.param("id"));
    if (thread.status !== "active" && thread.stopRequestedAt === null) {
      throw new ApiError(409, "invalid_request", "Thread is not active");
    }
    requestThreadStopIfNeeded(deps, thread, environment);
    return context.json({ ok: true });
  });

  post("/threads/:id/archive", archiveThreadRequestSchema, async (context, payload) => {
    const force = payload.force;
    const { environment, thread } = requirePublicThreadEnvironment(deps.db, context.req.param("id"));
    // Idempotent: archiving an already-archived thread is a no-op success.
    // A concurrent archive (e.g. from another tab) could land between the
    // client seeing a confirmation-required 409 and the user clicking
    // "Archive anyway"; we'd rather succeed than surface a confusing error.
    if (thread.archivedAt !== null) {
      return context.json({ ok: true });
    }
    const shouldRequestCleanup = await validateArchiveCleanupRequest(
      deps,
      thread,
      force,
    );
    archiveThread(deps.db, deps.hub, thread.id);
    requestThreadStopIfNeeded(deps, thread, environment);
    resetActiveThreadEventPruningState(thread.id);
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "archived",
      threadId: thread.id,
    });
    if (shouldRequestCleanup) {
      requestEnvironmentCleanup(deps, {
        environmentId: thread.environmentId,
        mode: force ? "force" : "safe",
      });
      await advanceEnvironmentCleanup(deps, {
        environmentId: thread.environmentId,
      });
    }
    return context.json({ ok: true });
  });

  post("/threads/:id/unarchive", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    unarchiveThread(deps.db, deps.hub, context.req.param("id"));
    return context.json({ ok: true });
  });

  post("/threads/:id/read", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: Date.now(),
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });

  post("/threads/:id/unread", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(thread);
  });
}
