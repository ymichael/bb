import { getHighWaterMarks, getActiveSession, openSession, upsertHost } from "@bb/db";
import { hostDaemonSessionOpenRequestSchema } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { HEARTBEAT_INTERVAL_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import { listHostThreadIds } from "../services/entity-lookup.js";
import { parseJsonBody } from "../services/validation.js";
import { reconcileSessionThreads } from "./reconciliation.js";

export function registerInternalSessionRoutes(app: Hono, deps: AppDeps): void {
  app.post("/session/open", async (context) => {
    const payload = await parseJsonBody(
      context,
      hostDaemonSessionOpenRequestSchema,
    );

    const existingSession = getActiveSession(deps.db, payload.hostId);
    upsertHost(deps.db, deps.hub, {
      id: payload.hostId,
      name: payload.hostName,
      type: payload.hostType,
    });
    const session = openSession(deps.db, deps.hub, {
      hostId: payload.hostId,
      instanceId: payload.instanceId,
      hostName: payload.hostName,
      hostType: payload.hostType,
      protocolVersion: payload.protocolVersion,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
    });

    if (existingSession && existingSession.id !== session.id) {
      deps.hub.closeDaemonSession(existingSession.id, "replaced");
    }

    reconcileSessionThreads(
      deps,
      payload.hostId,
      payload.activeThreads ?? [],
    );

    return context.json(
      {
        sessionId: session.id,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        leaseTimeoutMs: LEASE_TIMEOUT_MS,
        threadHighWaterMarks: getHighWaterMarks(
          deps.db,
          listHostThreadIds(deps.db, payload.hostId),
        ),
      },
      201,
    );
  });
}
