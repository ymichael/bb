import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { assertNever } from "@bb/core";
import type {
  EnvironmentAgentEventEnvelope,
  EnvironmentAgentSessionClientMessage,
  EnvironmentAgentSessionCommandAckPayload,
  EnvironmentAgentSessionCommandResultPayload,
  EnvironmentAgentSessionEventBatchPayload,
  EnvironmentAgentSessionHeartbeatPayload,
  EnvironmentAgentSessionOpenPayload,
  EnvironmentAgentSessionProviderRequestPayload,
} from "@bb/environment-daemon";
import {
  ENVIRONMENT_AGENT_SESSION_PROTOCOL,
} from "@bb/environment-daemon";
import { invalidRequestError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import type { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import type {
  EnvironmentAgentSessionRecord,
  EnvironmentRepository,
} from "@bb/db";

const environmentAgentSessionCursorSchema = z.object({
  generation: z.number().int().min(0),
  sequence: z.number().int().min(0),
});

const environmentAgentSessionChannelBootstrapSchema = z.object({
  channelId: z.string().min(1),
  generation: z.number().int().min(0),
  lastServerAcked: environmentAgentSessionCursorSchema.optional(),
});

const environmentAgentSessionCapabilitiesSchema = z.object({
  commands: z.array(z.enum([
    "provider.ensure",
    "thread.start",
    "thread.resume",
    "thread.stop",
    "turn.run",
    "thread.rename",
    "provider.list_models",
    "provider.list_catalog",
    "workspace.status",
    "workspace.diff",
  ])).min(1),
  features: z.array(z.enum([
    "worker_metadata",
    "provider_metadata",
    "provider_runtime_version",
    "control_endpoint",
  ])),
});

const environmentAgentSessionOpenBodySchema = z.object({
  agentId: z.string().min(1),
  agentInstanceId: z.string().min(1),
  supportedProtocolVersions: z.array(z.number().int()).min(1),
  capabilities: environmentAgentSessionCapabilitiesSchema.optional(),
  worker: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    buildId: z.string().min(1).optional(),
  }).optional(),
  providers: z.array(
    z.object({
      providerId: z.string().min(1),
      adapterVersion: z.string().min(1),
      runtimeVersion: z.string().min(1).optional(),
    }),
  ).optional(),
  controlEndpoint: z.object({
    baseUrl: z.string().url(),
    authToken: z.string().min(1),
  }).optional(),
  channels: z.array(environmentAgentSessionChannelBootstrapSchema).min(1),
});

const environmentAgentSessionCommandsQuerySchema = z.object({
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

const environmentAgentSessionMessageBaseSchema = z.object({
  protocol: z.literal(ENVIRONMENT_AGENT_SESSION_PROTOCOL),
  messageId: z.string().min(1),
  sentAt: z.number().finite(),
  sessionId: z.string().min(1),
});

const environmentAgentSessionMessageBodySchema = z.discriminatedUnion("type", [
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("heartbeat"),
    payload: z.object({
      agentObservedAt: z.number().int().nonnegative(),
      outboxDepth: z.number().int().nonnegative(),
      channels: z.array(z.object({
        channelId: z.string().min(1),
        lastSent: environmentAgentSessionCursorSchema.optional(),
        lastAcked: environmentAgentSessionCursorSchema.optional(),
      })),
    }),
  }),
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("event_batch"),
    payload: z.object({
      batches: z.array(z.object({
        channelId: z.string().min(1),
        generation: z.number().int().min(0),
        events: z.array(z.object({
          sequence: z.number().int().min(0),
          eventId: z.string().min(1),
          emittedAt: z.number().int().nonnegative(),
          event: z.custom<EnvironmentAgentEventEnvelope | Record<string, unknown>>((value) =>
            Boolean(value) && typeof value === "object" && !Array.isArray(value)),
        })).min(1),
      })).min(1),
    }),
  }),
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("command_ack"),
    payload: z.object({
      commands: z.array(z.object({
        commandId: z.string().min(1),
        channelId: z.string().min(1),
        state: z.enum(["received", "duplicate"]),
      })).min(1),
    }),
  }),
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("command_result"),
    payload: z.object({
      commandId: z.string().min(1),
      channelId: z.string().min(1),
      state: z.enum(["started", "completed", "failed"]),
      result: z.unknown().optional(),
      errorCode: z.string().min(1).optional(),
      errorMessage: z.string().min(1).optional(),
    }).superRefine((payload, ctx) => {
      if (payload.state === "failed") {
        if (!payload.errorCode) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Failed command results must include errorCode",
            path: ["errorCode"],
          });
        }
        if (!payload.errorMessage) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Failed command results must include errorMessage",
            path: ["errorMessage"],
          });
        }
      }
    }),
  }),
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("provider_request"),
    payload: z.object({
      requestId: z.union([z.string().min(1), z.number()]),
      method: z.string().min(1),
      params: z.unknown().optional(),
      providerId: z.string().min(1).optional(),
      normalizedMethod: z.string().min(1).optional(),
      channelId: z.string().min(1).optional(),
      toolCall: z.object({
        requestId: z.union([z.string().min(1), z.number()]),
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        callId: z.string().min(1),
        tool: z.string().min(1),
        arguments: z.unknown(),
      }).optional(),
    }),
  }),
  environmentAgentSessionMessageBaseSchema.extend({
    type: z.literal("session_close"),
    payload: z.object({
      reason: z.enum(["agent_shutdown", "server_shutdown", "migration", "internal_error"]),
    }),
  }),
]);

function toEnvironmentAgentSessionDebugView(
  session: EnvironmentAgentSessionRecord,
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
  environmentAgentSessionService: EnvironmentAgentSessionService;
  environmentRepo: EnvironmentRepository;
}) {
  const { environmentAgentSessionService, environmentRepo } = opts;

  return new Hono()
    .get("/:id/env-daemon/status", async (c) => {
      try {
        const environmentId = c.req.param("id");
        const environment = environmentRepo.getById(environmentId);
        if (!environment) {
          return sendRouteError(c, environmentNotFoundError(environmentId));
        }
        const status = environmentAgentSessionService.getEnvironmentStatus(
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
        const sessions = environmentAgentSessionService
          .listSessions(environmentId)
          .map(toEnvironmentAgentSessionDebugView);
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
      zValidator("json", environmentAgentSessionOpenBodySchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const body = c.req.valid("json") as EnvironmentAgentSessionOpenPayload;
          const opened = environmentAgentSessionService.openSession({
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
      zValidator("query", environmentAgentSessionCommandsQuerySchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const query = c.req.valid("query");
          const response = await environmentAgentSessionService.waitForCommands({
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
      zValidator("json", environmentAgentSessionMessageBodySchema),
      async (c) => {
        try {
          const environmentId = c.req.param("id");
          const environment = environmentRepo.getById(environmentId);
          if (!environment) {
            return sendRouteError(c, environmentNotFoundError(environmentId));
          }
          const body = c.req.valid("json") as Exclude<
            EnvironmentAgentSessionClientMessage,
            { type: "session_open" }
          >;
          switch (body.type) {
            case "heartbeat":
              environmentAgentSessionService.recordHeartbeat({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionHeartbeatPayload,
              });
              return c.body(null, 204);
            case "event_batch": {
              const response = await environmentAgentSessionService.applyEventBatch({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionEventBatchPayload,
              });
              return c.json(response);
            }
            case "command_ack":
              environmentAgentSessionService.recordCommandAck({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionCommandAckPayload,
              });
              return c.body(null, 204);
            case "command_result":
              environmentAgentSessionService.recordCommandResult({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionCommandResultPayload,
              });
              return c.body(null, 204);
            case "provider_request": {
              const response = await environmentAgentSessionService.handleProviderRequest({
                environmentId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionProviderRequestPayload,
              });
              return c.json(response);
            }
            case "session_close":
              environmentAgentSessionService.closeSession({
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
