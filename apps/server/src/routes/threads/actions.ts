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
import {
  requestQueuedDraftAutoSendForThread,
  sendQueuedDraft,
} from "../../services/threads/queued-drafts.js";
import {
  ensureThreadIsNotAwaitingUserInteraction,
  ensureThreadIsWritable,
  sendThreadMessage,
} from "../../services/threads/thread-send.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../../services/system/event-pruning.js";
import { buildExecutionOptions } from "../../services/threads/thread-commands.js";
import { getLastProviderThreadId } from "../../services/threads/thread-events.js";
import { requestThreadStopIfNeeded } from "../../services/threads/thread-lifecycle.js";
import { toThreadResponseFromThread } from "../../services/threads/thread-runtime-display.js";

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
    "/threads/:id/drafts",
    createDraftRequestSchema,
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
      const draft = createDraft(deps.db, deps.hub, {
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
        requestQueuedDraftAutoSendForThread(deps, {
          draftId: draft.id,
          threadId: thread.id,
        });
      }
      return context.json(toQueuedMessage(draft), 201);
    },
  );

  post(
    "/threads/:id/drafts/:draftId/send",
    sendDraftRequestSchema,
    async (context) => {
      const { thread } = requirePublicThreadEnvironment(
        deps.db,
        context.req.param("id"),
      );
      ensureThreadIsWritable(thread);
      ensureThreadIsNotAwaitingUserInteraction(deps, thread.id);
      const queuedMessage = await sendQueuedDraft(deps, {
        draftId: context.req.param("draftId"),
        threadId: context.req.param("id"),
      });
      return context.json({ ok: true, queuedMessage });
    },
  );

  del("/threads/:id/drafts/:draftId", (context) => {
    const draft = getDraft(deps.db, context.req.param("draftId"));
    if (!draft || draft.threadId !== context.req.param("id")) {
      throw new ApiError(404, "invalid_request", "Draft not found");
    }
    const deleted = deleteDraft(
      deps.db,
      deps.hub,
      context.req.param("draftId"),
    );
    if (!deleted) {
      throw new ApiError(404, "invalid_request", "Draft not found");
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

  post(
    "/threads/:id/archive",
    archiveThreadRequestSchema,
    async (context, payload) => {
      const force = payload.force;
      const { environment, thread } = requirePublicThreadEnvironment(
        deps.db,
        context.req.param("id"),
      );
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
          environmentId: environment.id,
          mode: force ? "force" : "safe",
        });
        await advanceEnvironmentCleanup(deps, {
          environmentId: environment.id,
        });
      }
      return context.json({ ok: true });
    },
  );

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
