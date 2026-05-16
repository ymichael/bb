import {
  createQueuedThreadMessage,
  deleteQueuedThreadMessage,
  getEnvironment,
  getQueuedThreadMessage,
  unarchiveThread,
  updateThread,
} from "@bb/db";
import {
  createQueuedMessageRequestSchema,
  sendQueuedMessageRequestSchema,
  sendMessageRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { Thread } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { toThreadQueuedMessage } from "../../services/threads/thread-queued-messages.js";
import {
  cancelPendingEnvironmentCleanup,
  requestEnvironmentCleanup,
  requestEnvironmentCleanupAdvance,
  wouldCleanupEnvironment,
} from "../../services/environments/environment-cleanup.js";
import {
  requirePublicThread,
  requirePublicThreadEnvironment,
} from "../../services/lib/entity-lookup.js";
import {
  requestQueuedMessageAutoSendForThread,
  sendQueuedMessage,
} from "../../services/threads/queued-messages.js";
import {
  ensureThreadIsNotAwaitingUserInteraction,
  ensureThreadIsWritable,
  sendThreadMessage,
} from "../../services/threads/thread-send.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../../services/system/event-pruning.js";
import {
  buildExecutionOptions,
  queueThreadUnarchiveCommand,
} from "../../services/threads/thread-commands.js";
import { getLastProviderThreadId } from "../../services/threads/thread-events.js";
import {
  queueSettledArchivedThreadProviderArchiveCommand,
  requestThreadStopIfNeeded,
} from "../../services/threads/thread-lifecycle.js";
import { toThreadResponseFromThread } from "../../services/threads/thread-runtime-display.js";
import { archiveThreadAndReleaseChildren } from "../../services/threads/thread-ownership.js";

function shouldCleanupAfterArchive(
  deps: AppDeps,
  thread: Thread,
): boolean {
  return wouldCleanupEnvironment(deps, {
    environmentId: thread.environmentId,
    excludeThreadId: thread.id,
  });
}

export function registerThreadActionRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/threads/:id/send",
    sendMessageRequestSchema,
    async (context, payload) => {
      const { environment, thread } = requirePublicThreadEnvironment(
        deps.db,
        context.req.param("id"),
      );
      await sendThreadMessage(deps, {
        environment,
        payload,
        thread,
        trigger: "user",
      });
      return context.json({ ok: true });
    },
  );

  post(
    "/threads/:id/queued-messages",
    createQueuedMessageRequestSchema,
    async (context, payload) => {
      const { thread } = requirePublicThreadEnvironment(
        deps.db,
        context.req.param("id"),
      );
      ensureThreadIsWritable(thread);
      const execution = await buildExecutionOptions(
        deps,
        payload,
        {
          threadId: thread.id,
        },
        "client/turn/requested",
      );
      const queuedMessage = createQueuedThreadMessage(deps.db, deps.hub, {
        threadId: context.req.param("id"),
        content: payload.input,
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        permissionMode: execution.permissionMode,
        serviceTier: execution.serviceTier,
      });
      if (
        thread.status === "idle" &&
        getLastProviderThreadId(deps, thread.id) !== null
      ) {
        requestQueuedMessageAutoSendForThread(deps, {
          queuedMessageId: queuedMessage.id,
          threadId: thread.id,
        });
      }
      return context.json(toThreadQueuedMessage(queuedMessage), 201);
    },
  );

  post(
    "/threads/:id/queued-messages/:queuedMessageId/send",
    sendQueuedMessageRequestSchema,
    async (context, payload) => {
      const { thread } = requirePublicThreadEnvironment(
        deps.db,
        context.req.param("id"),
      );
      ensureThreadIsWritable(thread);
      ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
      const queuedMessage = await sendQueuedMessage(deps, {
        queuedMessageId: context.req.param("queuedMessageId"),
        mode: payload.mode,
        threadId: context.req.param("id"),
      });
      return context.json({ ok: true, queuedMessage });
    },
  );

  del("/threads/:id/queued-messages/:queuedMessageId", (context) => {
    const queuedMessage = getQueuedThreadMessage(
      deps.db,
      context.req.param("queuedMessageId"),
    );
    if (!queuedMessage || queuedMessage.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    const deleted = deleteQueuedThreadMessage(
      deps.db,
      deps.hub,
      context.req.param("queuedMessageId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Queued message not found");
    }
    return context.json({ ok: true });
  });

  post("/threads/:id/stop", async (context) => {
    const { environment, thread } = requirePublicThreadEnvironment(
      deps.db,
      context.req.param("id"),
    );
    if (thread.status !== "active" && thread.stopRequestedAt === null) {
      throw new ApiError(409, "invalid_request", "Thread is not active");
    }
    requestThreadStopIfNeeded(deps, thread, environment);
    return context.json({ ok: true });
  });

  post("/threads/:id/archive", async (context) => {
    const { environment, thread } = requirePublicThreadEnvironment(
      deps.db,
      context.req.param("id"),
    );
    if (thread.archivedAt !== null) {
      deps.terminalSessions.closeArchivedThreadTerminals({
        threadId: thread.id,
      });
      return context.json({ ok: true });
    }
    const shouldRequestCleanup = shouldCleanupAfterArchive(deps, thread);
    const archiveResult = archiveThreadAndReleaseChildren(deps, { thread });
    if (!archiveResult) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    const { archivedThread } = archiveResult;
    deps.terminalSessions.closeArchivedThreadTerminals({
      threadId: archivedThread.id,
    });
    requestThreadStopIfNeeded(deps, archivedThread, environment);
    queueSettledArchivedThreadProviderArchiveCommand(deps, {
      threadId: archivedThread.id,
    });
    resetActiveThreadEventPruningState(thread.id);
    pruneThreadEventHistoryBestEffort(deps, {
      mode: "archived",
      threadId: thread.id,
    });
    if (shouldRequestCleanup) {
      requestEnvironmentCleanup(deps, {
        environmentId: environment.id,
      });
      requestEnvironmentCleanupAdvance(deps, {
        environmentId: environment.id,
      });
    }
    return context.json({ ok: true });
  });

  post("/threads/:id/unarchive", (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    const providerThreadId = getLastProviderThreadId(deps, thread.id);
    const environment = thread.environmentId
      ? getEnvironment(deps.db, thread.environmentId)
      : null;
    const cleanupCancellation = cancelPendingEnvironmentCleanup(deps, {
      environmentId: thread.environmentId,
    });
    if (cleanupCancellation === "in_progress") {
      throw new ApiError(
        409,
        "environment_cleanup_in_progress",
        "Environment cleanup is already in progress",
      );
    }
    unarchiveThread(deps.db, deps.hub, thread.id);
    if (providerThreadId && environment) {
      queueThreadUnarchiveCommand(deps, {
        host: {
          hostId: environment.hostId,
        },
        providerThreadId,
        thread,
      });
    }
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
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });

  post("/threads/:id/unread", (context) => {
    requirePublicThread(deps.db, context.req.param("id"));
    const thread = updateThread(deps.db, deps.hub, context.req.param("id"), {
      lastReadAt: null,
    });
    if (!thread) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }
    return context.json(toThreadResponseFromThread(deps, { thread }));
  });
}
