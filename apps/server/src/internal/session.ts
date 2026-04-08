import {
  getActiveSession,
  getHighWaterMarks,
  listThreadEnvironmentAssignmentsOnHost,
  openSession,
  upsertHost,
  updateHostLifecycleState,
} from "@bb/db";
import {
  hostDaemonSessionOpenRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { HEARTBEAT_INTERVAL_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { listHostThreadIds } from "../services/lib/entity-lookup.js";
import { assertAuthenticatedHostMatches, getAuthenticatedDaemon } from "./auth.js";
import { reconcileSessionThreads } from "./reconciliation.js";
import { advanceSandboxRuntimeMaterialSync, invalidateSandboxRuntimeMaterialAfterSessionOpen } from "../services/hosts/sandbox-runtime-material.js";

export function registerInternalSessionRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post("/session/open", hostDaemonSessionOpenRequestSchema, async (context, payload) => {
    const daemon = getAuthenticatedDaemon(context);
    assertAuthenticatedHostMatches(daemon, {
      hostId: payload.hostId,
      hostType: payload.hostType,
    });

    const existingSession = getActiveSession(deps.db, daemon.hostId);
    upsertHost(deps.db, deps.hub, {
      id: daemon.hostId,
      name: payload.hostName,
      type: daemon.hostType,
    });
    const session = openSession(deps.db, deps.hub, {
      hostId: daemon.hostId,
      instanceId: payload.instanceId,
      hostName: payload.hostName,
      hostType: daemon.hostType,
      dataDir: payload.dataDir,
      protocolVersion: payload.protocolVersion,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
    });
    updateHostLifecycleState(deps.db, {
      hostId: daemon.hostId,
      suspendedAt: null,
    });
    if (daemon.hostType === "ephemeral") {
      invalidateSandboxRuntimeMaterialAfterSessionOpen(deps, {
        hostId: daemon.hostId,
      });
      advanceSandboxRuntimeMaterialSync(deps, {
        hostId: daemon.hostId,
      });
    }

    deps.logger.info(
      {
        sessionId: session.id,
        hostId: daemon.hostId,
        replacedSessionId: existingSession?.id ?? null,
      },
      "Session opened",
    );

    if (existingSession && existingSession.id !== session.id) {
      deps.hub.closeDaemonSession(existingSession.id, "replaced");
    }

    await reconcileSessionThreads(
      deps,
      daemon.hostId,
      payload.activeThreads,
    );

    const hostThreadIds = listHostThreadIds(deps.db, daemon.hostId);

    return context.json(
      {
        sessionId: session.id,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        leaseTimeoutMs: LEASE_TIMEOUT_MS,
        trackedThreadTargets: listThreadEnvironmentAssignmentsOnHost(deps.db, {
          hostId: daemon.hostId,
          threadIds: hostThreadIds,
        }),
        threadHighWaterMarks: getHighWaterMarks(
          deps.db,
          hostThreadIds,
        ),
      },
      201,
    );
  });
}
