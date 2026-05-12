import {
  getActiveSession,
  listThreadEnvironmentAssignmentsOnHost,
  openSession,
  upsertHost,
} from "@bb/db";
import {
  hostDaemonProjectAttachmentContentQuerySchema,
  hostDaemonRuntimeMaterialQuerySchema,
  hostDaemonSessionOpenRequestSchema,
  hostRuntimeMaterialSnapshotSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { HEARTBEAT_INTERVAL_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  listHostThreadIds,
  requirePublicThreadEnvironment,
} from "../services/lib/entity-lookup.js";
import {
  assertAuthenticatedHostMatches,
  getAuthenticatedDaemon,
} from "./auth.js";
import { reconcileSessionThreads } from "./reconciliation.js";
import {
  advanceSandboxRuntimeMaterialSync,
  requestSandboxRuntimeMaterialSync,
} from "../services/hosts/sandbox-runtime-material.js";
import { runWithDaemonCommandWaitForbidden } from "../services/hosts/command-wait-context.js";
import { markHostSessionOpened } from "../services/hosts/host-lifecycle.js";
import { reconcileSandboxRuntimeMaterialAfterSessionOpen } from "../services/hosts/sandbox-runtime-material-operation.js";
import { readSandboxRuntimeMaterialSnapshotForVersion } from "../services/hosts/sandbox-runtime-material-snapshot.js";
import { requireAuthorizedActiveSession } from "./session-state.js";
import { readAttachment } from "../services/projects/attachments.js";

export function registerInternalSessionRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/open",
    hostDaemonSessionOpenRequestSchema,
    (context, payload) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/open",
        work: async () => {
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
          await markHostSessionOpened(deps, {
            hostId: daemon.hostId,
          });
          if (daemon.hostType === "ephemeral") {
            // A replaced session can strand a fetched runtime-sync command on the
            // old daemon session. Refresh the desired version first, then requeue
            // only if the existing operation is no longer reusable.
            await requestSandboxRuntimeMaterialSync(deps, {
              hostId: daemon.hostId,
            });
            reconcileSandboxRuntimeMaterialAfterSessionOpen(deps, {
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

            // Pending interactions are bound to the daemon session that registered
            // them. A new session id is a new in-memory provider-request registry,
            // even if the daemon instance id is unchanged and reports active threads.
            const pendingInteractionInterruptReason =
              existingSession.instanceId !== payload.instanceId
                ? "Host daemon restarted while awaiting user interaction; retry the thread to continue"
                : "Host daemon session was replaced while awaiting user interaction; retry the thread to continue";
            deps.pendingInteractions.interruptPendingInteractionsForSessionIds({
              sessionIds: [existingSession.id],
              reason: pendingInteractionInterruptReason,
            });
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
              trackedThreadTargets: listThreadEnvironmentAssignmentsOnHost(
                deps.db,
                {
                  hostId: daemon.hostId,
                  threadIds: hostThreadIds,
                },
              ),
            },
            201,
          );
        },
      }),
  );

  get(
    "/session/runtime-material",
    hostDaemonRuntimeMaterialQuerySchema,
    (context, query) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/runtime-material",
        work: async () => {
          const daemon = getAuthenticatedDaemon(context);
          requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: query.sessionId,
          });

          return context.json(
            hostRuntimeMaterialSnapshotSchema.parse(
              await readSandboxRuntimeMaterialSnapshotForVersion(deps, {
                version: query.version,
              }),
            ),
          );
        },
      }),
  );

  get(
    "/session/project-attachment-content",
    hostDaemonProjectAttachmentContentQuerySchema,
    (context, query) =>
      runWithDaemonCommandWaitForbidden({
        reason: "/session/project-attachment-content",
        work: async () => {
          const daemon = getAuthenticatedDaemon(context);
          requireAuthorizedActiveSession(deps.db, {
            hostId: daemon.hostId,
            sessionId: query.sessionId,
          });

          const { environment, thread } = requirePublicThreadEnvironment(
            deps.db,
            query.threadId,
          );
          // Attachment paths are project-scoped upload tokens, so cross-check
          // projectId before reading bytes even though threadId identifies a thread.
          if (thread.projectId !== query.projectId) {
            throw new ApiError(
              403,
              "forbidden",
              "Thread does not belong to project",
            );
          }
          if (environment.hostId !== daemon.hostId) {
            throw new ApiError(
              403,
              "forbidden",
              "Host is not assigned to thread environment",
            );
          }

          const attachment = await readAttachment(
            deps.config.dataDir,
            query.projectId,
            query.path,
          );
          return new Response(new Uint8Array(attachment.content), {
            status: 200,
            headers: {
              "content-type": attachment.mimeType ?? "application/octet-stream",
            },
          });
        },
      }),
  );
}
