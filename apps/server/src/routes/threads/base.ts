import {
  deleteThread,
  listThreads,
  updateThread,
} from "@bb/db";
import {
  createThreadRequestSchema,
  updateThreadRequestSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { maybeCleanupEnvironment } from "../../services/environment-cleanup.js";
import {
  requireEnvironment,
  requireThread,
} from "../../services/entity-lookup.js";
import { queueThreadRenameCommand } from "../../services/thread-commands.js";
import { createThreadFromRequest } from "../../services/thread-create.js";
import { parseJsonBody, parseOptionalBoolean } from "../../services/validation.js";

export function registerThreadBaseRoutes(app: Hono, deps: AppDeps): void {
  app.get("/threads", (context) => {
    const queryType = context.req.query("type");
    const threadType =
      queryType === "manager" || queryType === "standard"
        ? queryType
        : undefined;
    return context.json(
      listThreads(deps.db, {
        ...(context.req.query("projectId")
          ? { projectId: context.req.query("projectId") }
          : {}),
        ...(threadType ? { type: threadType } : {}),
        ...(context.req.query("parentThreadId")
          ? { parentThreadId: context.req.query("parentThreadId") }
          : {}),
        archived: parseOptionalBoolean(context.req.query("archived")),
      }),
    );
  });

  app.post("/threads", async (context) =>
    context.json(
      await createThreadFromRequest(
        deps,
        await parseJsonBody(context, createThreadRequestSchema),
      ),
      201,
    ),
  );

  app.get("/threads/:id", (context) =>
    context.json(requireThread(deps.db, context.req.param("id"))),
  );

  app.patch("/threads/:id", async (context) => {
    const thread = requireThread(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, updateThreadRequestSchema);
    const updated = updateThread(deps.db, deps.hub, thread.id, payload);
    if (!updated) {
      throw new ApiError(404, "thread_not_found", "Thread not found");
    }

    if (
      payload.title &&
      payload.title !== thread.title &&
      updated.environmentId
    ) {
      const environment = requireEnvironment(deps.db, updated.environmentId);
      if (environment.status === "ready" && environment.path) {
        queueThreadRenameCommand(deps, {
          environment: {
            id: environment.id,
            hostId: environment.hostId,
          },
          threadId: updated.id,
          title: payload.title,
        });
      }
    }

    return context.json(updated);
  });

  app.delete("/threads/:id", async (context) => {
    const thread = requireThread(deps.db, context.req.param("id"));
    deleteThread(deps.db, deps.hub, thread.id);
    await maybeCleanupEnvironment(deps, thread.environmentId);
    return context.json({ ok: true });
  });
}
