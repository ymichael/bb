import {
  createHostId,
  deleteHost,
  getLatestSessionForHost,
  getHost,
  updateHost,
  upsertHost,
} from "@bb/db";
import {
  createHostJoinRequestSchema,
  updateHostRequestSchema,
  typedRoutes,
  type CreateHostJoinRequest,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { assertMatchingExistingHostType } from "../services/hosts/host-type-guard.js";
import { resolveHostJoinServerUrl } from "../services/hosts/host-join-server-url.js";
import {
  listPublicHostsWithStatus,
  requireNonDestroyedHostWithStatus,
} from "../services/lib/entity-lookup.js";
import { getTrustedRemoteAddress } from "../request-context.js";

function resolvePendingHostName(hostId: string): string {
  return `pending-${hostId.slice(-8)}`;
}

interface CancelPendingHostJoinArgs {
  deps: AppDeps;
  hostId: string;
}

function isLocalHostJoinRequest(payload: CreateHostJoinRequest): boolean {
  return "joinMode" in payload && payload.joinMode === "local";
}

async function cancelPendingHostJoin({
  deps,
  hostId,
}: CancelPendingHostJoinArgs): Promise<void> {
  const host = requireNonDestroyedHostWithStatus(deps.db, hostId);
  await deps.machineAuth.revokeHostEnrollKeys({
    hostId: host.id,
    hostType: host.type,
  });

  const latestSession = getLatestSessionForHost(deps.db, { hostId: host.id });
  if (latestSession) {
    return;
  }

  const deleted = deleteHost(deps.db, deps.hub, host.id);
  if (!deleted) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
}

export function registerHostRoutes(app: Hono, deps: AppDeps): void {
  const { get, post, patch, del } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });

  get("/hosts", (context) => context.json(listPublicHostsWithStatus(deps.db)));

  post("/hosts/join", createHostJoinRequestSchema, async (context, payload) => {
    const isLocalJoin = isLocalHostJoinRequest(payload);
    const serverUrl = resolveHostJoinServerUrl({
      appUrl: deps.config.appUrl,
      isLocalJoin,
      remoteAddress: getTrustedRemoteAddress(context),
      serverPort: deps.config.serverPort,
    });
    const hostId = payload.hostId ?? createHostId();
    const hostType = payload.hostType ?? "persistent";
    const existing = getHost(deps.db, hostId);
    assertMatchingExistingHostType({
      existingHost: existing,
      requestedHostType: hostType,
    });
    const hostName = existing?.name ?? resolvePendingHostName(hostId);

    upsertHost(deps.db, deps.hub, {
      id: hostId,
      name: hostName,
      type: hostType,
      ...(payload.hostType === "ephemeral"
        ? {
            externalId: payload.externalId,
            provider: payload.provider,
          }
        : {}),
    });

    const joinMaterial = await deps.machineAuth.issueHostEnrollKey({
      hostId,
      hostType,
    });
    const joinCommand = deps.machineAuth.buildJoinCommand({
      hostId,
      hostType,
      joinCode: joinMaterial.key,
      serverUrl,
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

  del("/hosts/:id/join", async (context) => {
    await cancelPendingHostJoin({
      deps,
      hostId: context.req.param("id"),
    });
    return context.json({ ok: true });
  });

  get("/hosts/:id", (context) =>
    context.json(
      requireNonDestroyedHostWithStatus(deps.db, context.req.param("id")),
    ),
  );

  patch("/hosts/:id", updateHostRequestSchema, (context, payload) => {
    const id = context.req.param("id");
    requireNonDestroyedHostWithStatus(deps.db, id);
    const updated = updateHost(deps.db, deps.hub, id, payload);
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    return context.json(requireNonDestroyedHostWithStatus(deps.db, id));
  });

  del("/hosts/:id", (context) => {
    const id = context.req.param("id");
    requireNonDestroyedHostWithStatus(deps.db, id);
    const deleted = deleteHost(deps.db, deps.hub, id);
    if (!deleted) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    return context.json({ ok: true });
  });
}
