import { getHost, upsertHost } from "@bb/db";
import {
  hostDaemonEnrollRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { assertMatchingExistingHostType } from "../services/hosts/host-type-guard.js";
import { requireBearerToken } from "./auth.js";

export function registerInternalHostRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (message) => new ApiError(400, "invalid_request", message),
  });

  post("/hosts/enroll", hostDaemonEnrollRequestSchema, async (context, payload) => {
    const token = requireBearerToken(context.req.header("authorization"));
    const enrollment = await deps.machineAuth.enrollHost({
      hostId: payload.hostId,
      hostType: payload.hostType,
      token,
    });

    if (!enrollment) {
      throw new ApiError(401, "unauthorized", "Unauthorized");
    }
    assertMatchingExistingHostType({
      existingHost: getHost(deps.db, enrollment.metadata.hostId),
      requestedHostType: enrollment.metadata.hostType,
    });

    upsertHost(deps.db, deps.hub, {
      id: enrollment.metadata.hostId,
      name: payload.hostName,
      type: enrollment.metadata.hostType,
    });

    return context.json(
      {
        hostId: enrollment.metadata.hostId,
        hostKey: enrollment.hostKey,
      },
      201,
    );
  });
}
