import {
  getLatestSessionForHost,
  listRetiredLoadedEnvironmentIdsOnHost,
  openSession,
  upsertHost,
  updateHost,
} from "@bb/db";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonProjectAttachmentContentQuerySchema,
  hostDaemonSessionOpenRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { z } from "zod";
import type { AppDeps } from "../types.js";
import { HEARTBEAT_INTERVAL_MS, LEASE_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { requirePublicThreadEnvironment } from "../services/lib/entity-lookup.js";
import {
  assertAuthenticatedHostMatches,
  getAuthenticatedDaemon,
} from "./auth.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";
import { readAttachment } from "../services/projects/attachments.js";
import { handleHostSessionOpened } from "./session-owner-side-effects.js";
import { resolveReportedConnectMachineId } from "./hosts.js";
import type { PluginService } from "../services/plugins/plugin-service.js";

const sessionOpenCompatibilitySchema = z
  .object({
    hostId: z.string().min(1),
    protocolVersion: z.number().int().positive(),
  })
  .passthrough();

function invalidSessionOpenRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

function sessionOpenValidationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === "invalid_type" && issue.input === undefined) {
    return "Required";
  }
  return issue?.message ?? "Invalid request";
}

export function registerInternalSessionRoutes(
  app: Hono,
  deps: AppDeps,
  plugins: PluginService,
): void {
  const { get } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  app.post("/session/open", async (context) => {
    const input: unknown = await context.req.json().catch(() => {
      throw invalidSessionOpenRequest("Invalid JSON request body");
    });
    const compatibility = sessionOpenCompatibilitySchema.safeParse(input);
    if (!compatibility.success) {
      throw invalidSessionOpenRequest(
        sessionOpenValidationMessage(compatibility.error),
      );
    }
    const daemon = getAuthenticatedDaemon(context);
    assertAuthenticatedHostMatches(daemon, {
      hostId: compatibility.data.hostId,
    });

    if (compatibility.data.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION) {
      updateHost(deps.db, deps.hub, daemon.hostId, {
        lastRejectedProtocolVersion: compatibility.data.protocolVersion,
      });
      const retryUpdate = deps.hub.takeHostProtocolUpdateRetry(daemon.hostId);
      deps.hub.notifyHost(daemon.hostId, ["host-disconnected"]);
      deps.logger.error(
        {
          hostId: daemon.hostId,
          daemonProtocolVersion: compatibility.data.protocolVersion,
          serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        },
        "Rejecting daemon session: protocol version mismatch. An older auto-update-enabled daemon will install this server's bb-app; a newer daemon requires the server to be updated.",
      );
      throw new ApiError(
        400,
        "protocol_version_mismatch",
        `Daemon protocol version ${compatibility.data.protocolVersion} does not match server protocol version ${HOST_DAEMON_PROTOCOL_VERSION}`,
        {
          details: {
            retryUpdate,
            serverProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
          },
        },
      );
    }

    const parsed = hostDaemonSessionOpenRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidSessionOpenRequest(
        sessionOpenValidationMessage(parsed.error),
      );
    }
    const payload = parsed.data;

    const previousSession = getLatestSessionForHost(deps.db, {
      hostId: daemon.hostId,
    });
    const connectMachineId = resolveReportedConnectMachineId(
      context,
      payload.connectMachineId,
    );
    upsertHost(deps.db, deps.hub, {
      ...(connectMachineId !== undefined ? { connectMachineId } : {}),
      id: daemon.hostId,
      name: payload.hostName,
    });
    updateHost(deps.db, deps.hub, daemon.hostId, {
      lastRejectedProtocolVersion: null,
    });
    const session = openSession(deps.db, {
      hostId: daemon.hostId,
      instanceId: payload.instanceId,
      hostName: payload.hostName,
      dataDir: payload.dataDir,
      protocolVersion: payload.protocolVersion,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      leaseTimeoutMs: LEASE_TIMEOUT_MS,
    });
    deps.hub.recordDaemonSessionPlatform(session.id, payload.platform);
    deps.hub.recordDaemonSessionLocalApiPort(session.id, payload.localApiPort);
    deps.sharedPorts.recordHostConnectCapability({
      hostId: daemon.hostId,
      sessionId: session.id,
      hasMachineCredential: payload.hasMachineCredential,
    });

    await handleHostSessionOpened(deps, {
      activeThreads: payload.activeThreads,
      hostId: daemon.hostId,
      openedSession: session,
      previousSession,
    });

    const retiredEnvironmentIds = listRetiredLoadedEnvironmentIdsOnHost(
      deps.db,
      {
        hostId: daemon.hostId,
        environmentIds: (payload.loadedEnvironments ?? []).map(
          (environment) => environment.environmentId,
        ),
      },
    );

    return context.json(
      {
        sessionId: session.id,
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        leaseTimeoutMs: LEASE_TIMEOUT_MS,
        watchSet: deps.watchInterests.reconcileWatchSetForHost(daemon.hostId),
        connectShares: deps.sharedPorts.reconcileSharedPortsForHost(
          daemon.hostId,
        ),
        pluginHostGenerations: plugins.listHostArtifactGenerations(),
        retiredEnvironmentIds,
      },
      201,
    );
  });

  get(
    "/session/project-attachment-content",
    hostDaemonProjectAttachmentContentQuerySchema,
    async (context, query) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: query.sessionId,
      });

      const { environment, thread } = requirePublicThreadEnvironment(
        deps.db,
        query.threadId,
      );
      if (thread.projectId !== query.projectId) {
        throw new ApiError(
          403,
          "forbidden",
          "Thread does not belong to project",
        );
      }
      if (environment.hostId !== session.hostId) {
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
  );
}
