import {
  hostDaemonEnvironmentChangeRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireEnvironment } from "../services/entity-lookup.js";
import { requireActiveSession } from "./session-state.js";

export function registerInternalEnvironmentChangeRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/environment-change",
    hostDaemonEnvironmentChangeRequestSchema,
    async (context, payload) => {
      const session = requireActiveSession(deps.db, payload.sessionId);
      const environment = requireEnvironment(deps.db, payload.environmentId);
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Environment does not belong to the session host",
        );
      }

      deps.hub.notifyEnvironment(environment.id, [payload.change]);
      return context.json({ ok: true });
    },
  );
}
