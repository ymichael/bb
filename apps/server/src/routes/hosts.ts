import { createHostId, getHost, upsertHost } from "@bb/db";
import {
  createHostJoinRequestSchema,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { listHostsWithStatus, requireHostWithStatus } from "../services/lib/entity-lookup.js";

function resolveJoinServerUrl(
  deps: Pick<AppDeps, "config">,
  requestUrl: string,
): string {
  return deps.config.publicUrl ?? new URL(requestUrl).origin;
}

function resolvePendingHostName(hostId: string): string {
  return `pending-${hostId.slice(-8)}`;
}

export function registerHostRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) => new ApiError(400, "invalid_request", message),
  });

  get("/hosts", (context) => context.json(listHostsWithStatus(deps.db)));

  post("/hosts/join", createHostJoinRequestSchema, async (context, payload) => {
    const hostId = payload.hostId ?? createHostId();
    const existing = getHost(deps.db, hostId);
    const hostName = existing?.name ?? resolvePendingHostName(hostId);

    upsertHost(deps.db, deps.hub, {
      id: hostId,
      name: hostName,
      type: payload.hostType,
    });

    const joinMaterial = await deps.machineAuth.issueHostEnrollKey({
      hostId,
      hostType: payload.hostType,
    });
    const joinCommand = deps.machineAuth.buildJoinCommand({
      hostId,
      hostType: payload.hostType,
      joinCode: joinMaterial.key,
      serverUrl: resolveJoinServerUrl(deps, context.req.url),
    });

    return context.json(
      {
        expiresAt: joinMaterial.expiresAt,
        hostId,
        joinCode: joinMaterial.key,
        joinCommand,
      },
      201,
    );
  });

  get("/hosts/:id", (context) =>
    context.json(requireHostWithStatus(deps.db, context.req.param("id"))),
  );
}
