import type { Hono } from "hono";
import { listQueuedThreadMessagesForApi } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { toThreadQueuedMessage } from "../services/threads/thread-queued-messages.js";

/**
 * The cross-thread queue list.
 *
 * A thread's own rows are served by `GET /threads/:id/queued-messages`, which
 * is also where every per-row operation lives. This route exists for the one
 * question that list cannot answer: "what is queued right now, anywhere" — a
 * workspace-wide pending view, a limiter plugin's bookkeeping, or a plugin
 * recovering the rows it is holding after a restart. It replaced `GET /holds`,
 * which existed for exactly the same reason.
 */
export function registerQueueRoutes(app: Hono, deps: AppDeps): void {
  const { get } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get(publicApiRoutes.queue.list, (context, query) => {
    return context.json(
      listQueuedThreadMessagesForApi(deps.db, {
        ...(query.threadId !== undefined ? { threadId: query.threadId } : {}),
        ...(query.waitHolder !== undefined
          ? { waitHolder: query.waitHolder }
          : {}),
      }).map(toThreadQueuedMessage),
    );
  });
}
