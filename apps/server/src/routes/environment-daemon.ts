import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { assertNever } from "@bb/core";
import type {
  EnvironmentDaemonSessionClientMessage,
  EnvironmentDaemonSessionCommandAckPayload,
  EnvironmentDaemonSessionCommandResultPayload,
  EnvironmentDaemonSessionEventBatchPayload,
  EnvironmentDaemonSessionHeartbeatPayload,
  EnvironmentDaemonSessionOpenPayload,
  EnvironmentDaemonSessionProviderRequestPayload,
} from "@bb/environment-daemon";
import {
  environmentDaemonSessionClientMessageSchema,
  environmentDaemonSessionOpenPayloadSchema,
} from "@bb/environment-daemon";
import { invalidRequestError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import type { EnvironmentDaemonSessionService } from "../environment-daemon-session-service.js";
import type {
  EnvironmentDaemonSessionRecord,
  EnvironmentRepository,
} from "@bb/db";

const environmentDaemonSessionCommandsQuerySchema = z.object({
  sessionId: z.string().min(1),
  afterCursor: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return undefined;
      return parsed;
    }),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      return parsed;
    }),
  waitMs: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return undefined;
      return parsed;
    }),
});

function isAbortError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  const errorWithCode = error as Error & { code?: string };
  if (
    errorWithCode.code === "ABORT_ERR" ||
    errorWithCode.code === "ERR_ABORTED" ||
    errorWithCode.code === "ERR_HTTP_ABORTED"
  ) {
    return true;
  }
  const message = error.message.toLowerCase();
  return message.includes("aborted") || message.includes("aborterror");
}

function toEnvironmentDaemonSessionDebugView(
  session: EnvironmentDaemonSessionRecord,
): Record<string, unknown> {
  return {
    id: session.id,
    environmentId: session.environmentId,
    agentId: session.agentId,
    agentInstanceId: session.agentInstanceId,
    protocolVersion: session.protocolVersion,
    ...(session.workerName ? { workerName: session.workerName } : {}),
    ...(session.workerVersion ? { workerVersion: session.workerVersion } : {}),
    ...(session.workerBuildId ? { workerBuildId: session.workerBuildId } : {}),
    ...(session.providerMetadata !== undefined
      ? { providerMetadata: session.providerMetadata }
      : {}),
    ...(session.selectedCapabilities !== undefined
      ? { selectedCapabilities: session.selectedCapabilities }
      : {}),
    status: session.status,
    leaseExpiresAt: session.leaseExpiresAt,
    ...(session.lastHeartbeatAt !== undefined
      ? { lastHeartbeatAt: session.lastHeartbeatAt }
      : {}),
    ...(session.closedAt !== undefined ? { closedAt: session.closedAt } : {}),
    ...(session.closeReason !== undefined ? { closeReason: session.closeReason } : {}),
    ...(session.controlBaseUrl ? { controlBaseUrl: session.controlBaseUrl } : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function environmentNotFoundError(environmentId: string): Error {
  const error = new Error(`Environment not found: ${environmentId}`);
  (error as Error & { status?: number }).status = 404;
  return error;
}

export function createEnvironmentDaemonRoutes(opts: {
  environmentDaemonSessionService: EnvironmentDaemonSessionService;
  environmentRepo: EnvironmentRepository;
}) {
  const { environmentDaemonSessionService, environmentRepo } = opts;

  return new Hono()
    .get("/:id/env-daemon/status", async (c) => {
      try {
        const environmentId = c.req.param("id");
        const environment = environmentRepo.getById(environmentId);
        if (!environment) {
          return sendRouteError(c, environmentNotFoundError(environmentId));
        }
        const status = environmentDaemonSessionService.getEnvironmentStatus(
          environmentId,
          environmentId,
        );
        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/env-daemon/sessions", async (c) => {
      try {
        const environmentId = c.req.param("id");
        const environment = environmentRepo.getById(environmentId);
        if (!environment) {
          return sendRouteError(c, environmentNotFoundError(environmentId));
        }
        const sessions = environmentDaemonSessionService
          .listSessions(environmentId)
          .map(toEnvironmentDaemonSessionDebugView);
        return c.json({
          environmentId,
          sessions,
        });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post(
      "/:id/env-daemon/session/open",
      zValidator("json", environmentDaemonSessionOpenPayloadSchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const body = c.req.valid("json") as EnvironmentDaemonSessionOpenPayload;
          const opened = environmentDaemonSessionService.openSession({
            environmentId,
            payload: body,
          });
          return c.json(opened.welcome, 201);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get(
      "/:id/env-daemon/session/commands",
      zValidator("query", environmentDaemonSessionCommandsQuerySchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const query = c.req.valid("query");
          const response = await environmentDaemonSessionService.waitForCommands({
            environmentId,
            sessionId: query.sessionId,
            ...(query.afterCursor !== undefined
              ? { afterCursor: query.afterCursor }
              : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
            ...(query.waitMs !== undefined ? { waitMs: query.waitMs } : {}),
            signal: c.req.raw.signal,
          });
          return c.json(response);
        } catch (err) {
          if (isAbortError(err)) {
            return c.body(null, 204);
          }
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/env-daemon/session/messages",
      zValidator("json", environmentDaemonSessionClientMessageSchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const body = c.req.valid("json") as Exclude<
            EnvironmentDaemonSessionClientMessage,
            { type: "session_open" }
          >;
          switch (body.type) {
            case "heartbeat":
              environmentDaemonSessionService.recordHeartbeat({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentDaemonSessionHeartbeatPayload,
              });
              return c.body(null, 204);
            case "event_batch": {
              const response = await environmentDaemonSessionService.applyEventBatch({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentDaemonSessionEventBatchPayload,
              });
              return c.json(response);
            }
            case "command_ack":
              environmentDaemonSessionService.recordCommandAck({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentDaemonSessionCommandAckPayload,
              });
              return c.body(null, 204);
            case "command_result":
              environmentDaemonSessionService.recordCommandResult({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentDaemonSessionCommandResultPayload,
              });
              return c.body(null, 204);
            case "provider_request": {
              const response = await environmentDaemonSessionService.handleProviderRequest({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentDaemonSessionProviderRequestPayload,
              });
              return c.json(response);
            }
            case "session_close":
              environmentDaemonSessionService.closeSession({
                environmentId,
                sessionId: body.sessionId,
                reason: (body.payload as { reason: "agent_shutdown" | "server_shutdown" | "migration" | "internal_error" }).reason,
              });
              return c.body(null, 204);
            default:
              assertNever(body);
          }
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    );
}
