import {
  resolvePendingInteractionRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { requirePublicThread } from "../../services/lib/entity-lookup.js";

export function registerThreadInteractionRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/threads/:id/interactions", (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.listPendingThreadInteractions(thread.id),
    );
  });

  get("/threads/:id/interactions/:interactionId", (context) => {
    const thread = requirePublicThread(deps.db, context.req.param("id"));
    return context.json(
      deps.pendingInteractions.getThreadInteraction({
        threadId: thread.id,
        interactionId: context.req.param("interactionId"),
      }),
    );
  });

  post(
    "/threads/:id/interactions/:interactionId/resolve",
    resolvePendingInteractionRequestSchema,
    (context, payload) => {
      const thread = requirePublicThread(deps.db, context.req.param("id"));
      return context.json(
        deps.pendingInteractions.resolvePendingInteraction({
          threadId: thread.id,
          interactionId: context.req.param("interactionId"),
          resolution: payload,
        }),
      );
    },
  );
}
