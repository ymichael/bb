import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  assertNever,
  type EnvironmentRecord,
  type OpenPathRequest,
  type ThreadOrchestrator,
  enqueueThreadMessageSchema,
  sendQueuedThreadMessageSchema,
  spawnThreadSchema,
  threadOperationSchema,
  tellThreadSchema,
  updateThreadSchema,
  type PromptInput,
  type ThreadGitDiffSelection,
  type Thread,
} from "@bb/core";
import { z } from "zod";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  EnvironmentAgentEventEnvelope,
  EnvironmentAgentSessionClientMessage,
  EnvironmentAgentSessionCommandAckPayload,
  EnvironmentAgentSessionCommandResultPayload,
  EnvironmentAgentSessionEventBatchPayload,
  EnvironmentAgentSessionHeartbeatPayload,
  EnvironmentAgentSessionOpenPayload,
  EnvironmentAgentSessionProviderRequestPayload,
  EnvironmentAgentStatusSnapshot,
} from "@bb/environment-daemon";
import {
  ENVIRONMENT_AGENT_SESSION_PROTOCOL,
} from "@bb/environment-daemon";
import { invalidRequestError, threadNotFoundError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import { openPathInEditor } from "./system.js";
import type { EnvironmentAgentSessionService } from "../environment-agent-session-service.js";
import type {
  EnvironmentAgentSessionRecord,
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";
import { resolveManagerWorkspacePath } from "../manager-thread.js";

const listThreadsQuerySchema = z.object({
  projectId: z.string().optional(),
  parentThreadId: z.string().optional(),
  includeArchived: z.enum(["true", "false"]).optional(),
  includeWorkStatus: z.enum(["true", "false"]).optional(),
});

const eventsQuerySchema = z.object({
  afterSeq: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      return parsed;
    }),
});

const environmentAgentSessionCursorSchema = z.object({
  generation: z.number().int().min(0),
  sequence: z.number().int().min(0),
});

const environmentAgentSessionChannelBootstrapSchema = z.object({
  channelId: z.string().min(1),
  generation: z.number().int().min(0),
  lastDaemonAcked: environmentAgentSessionCursorSchema.optional(),
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
      reason: z.enum(["agent_shutdown", "daemon_shutdown", "migration", "internal_error"]),
    }),
  }),
]);

const workStatusQuerySchema = z.object({
  mergeBaseBranch: z.string().trim().min(1).optional(),
});

const timelineQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
      return parsed;
    }),
  includeToolGroupMessages: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  includeManagerDebugView: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const toolGroupMessagesQuerySchema = z.object({
  turnId: z.string().min(1),
  sourceSeqStart: z
    .string()
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().positive()),
  sourceSeqEnd: z
    .string()
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().positive()),
  includeManagerDebugView: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

const managerWorkspaceFileQuerySchema = z.object({
  path: z.string().min(1),
});

function isPathWithinDirectory(path: string, directory: string): boolean {
  const normalizedDirectory = directory.endsWith(sep) ? directory : `${directory}${sep}`;
  return path === directory || path.startsWith(normalizedDirectory);
}

function listManagerWorkspaceFiles(rootPath: string, currentPath = ""): Array<{
  path: string;
  size: number;
}> {
  const directoryPath = currentPath ? resolve(rootPath, currentPath) : rootPath;
  const entries = readdirSync(directoryPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: Array<{ path: string; size: number }> = [];

  for (const entry of entries) {
    const entryPath = resolve(directoryPath, entry.name);
    const relativePath = relative(rootPath, entryPath).split(sep).join("/");
    if (entry.isDirectory()) {
      files.push(...listManagerWorkspaceFiles(rootPath, relativePath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      path: relativePath,
      size: statSync(entryPath).size,
    });
  }

  return files;
}

const gitDiffQuerySchema = z.object({
  selection: z.enum(["combined", "commit"]).optional(),
  commitSha: z.string().trim().min(1).optional(),
  mergeBaseBranch: z.string().trim().min(1).optional(),
});

const archiveThreadBodySchema = z.object({
  force: z.boolean().optional(),
});

const openThreadPathBodySchema = z.object({
  relativePath: z.string().min(1),
  target: z.enum(["file", "directory"]).optional(),
  editor: z.enum(["system_default", "vscode", "cursor", "zed", "windsurf"]).optional(),
  command: z.string().min(1).optional(),
});

type OpenPathFn = (args: OpenPathRequest) => void;

const MAX_PROMPT_ATTACHMENT_INPUTS = 12;

type RouteEnvironmentAgentCapableOrchestrator = ThreadOrchestrator & {
  getEnvironmentAgentStatus?: (
    threadId: string,
  ) => Promise<EnvironmentAgentStatusSnapshot>;
};

function validatePromptInputAttachments(input: PromptInput[]): void {
  let attachmentCount = 0;
  for (const chunk of input) {
    if (chunk.type !== "localImage" && chunk.type !== "localFile") {
      continue;
    }
    attachmentCount += 1;
    const normalizedPath = chunk.path.trim();
    if (normalizedPath.length === 0) {
      throw invalidRequestError("Attachment path cannot be empty");
    }
    if (!isAbsolute(normalizedPath)) {
      throw invalidRequestError("Attachment path must be absolute");
    }
  }

  if (attachmentCount > MAX_PROMPT_ATTACHMENT_INPUTS) {
    throw invalidRequestError(
      `A single request can include at most ${MAX_PROMPT_ATTACHMENT_INPUTS} local attachments`,
    );
  }
}

async function getThreadForRouteLookup(
  threadManager: ThreadOrchestrator,
  threadId: string,
): Promise<Thread | undefined> {
  return threadManager.getRawById(threadId);
}

function toEnvironmentAgentSessionDebugView(
  session: EnvironmentAgentSessionRecord,
): Record<string, unknown> {
  return {
    id: session.id,
    threadId: session.threadId,
    ...(session.environmentId ? { environmentId: session.environmentId } : {}),
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

export function createThreadRoutes(
  threadManager: ThreadOrchestrator,
  opts?: {
    environmentRepo?: EnvironmentRepository;
    threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository;
    openPath?: OpenPathFn;
    environmentAgentSessionService?: EnvironmentAgentSessionService;
    runtimeEnv?: NodeJS.ProcessEnv;
  },
) {
  const openPath = opts?.openPath ?? openPathInEditor;
  const environmentAgentSessionService = opts?.environmentAgentSessionService;
  const environmentRepo = opts?.environmentRepo;
  const threadEnvironmentAttachmentRepo = opts?.threadEnvironmentAttachmentRepo;
  const runtimeEnv = opts?.runtimeEnv ?? process.env;
  const environmentAgentAccessor =
    threadManager as RouteEnvironmentAgentCapableOrchestrator;
  const hydrateThread = <TThread extends Thread>(thread: TThread): TThread => {
    if (!environmentRepo || !threadEnvironmentAttachmentRepo) {
      return thread;
    }
    const attachment = threadEnvironmentAttachmentRepo.getByThreadId(thread.id);
    if (!attachment) {
      return thread;
    }
    const attachedEnvironment = environmentRepo.getById(attachment.environmentId);
    if (!attachedEnvironment) {
      return thread;
    }
    return {
      ...thread,
      attachedEnvironment,
    };
  };
  const hydrateThreads = <TThread extends Thread>(threads: readonly TThread[]): TThread[] => {
    if (!environmentRepo || !threadEnvironmentAttachmentRepo || threads.length === 0) {
      return [...threads];
    }
    const attachments = threadEnvironmentAttachmentRepo.listByThreadIds(
      threads.map((thread) => thread.id),
    );
    if (attachments.length === 0) {
      return [...threads];
    }
    const environmentIds = Array.from(new Set(attachments.map((attachment) => attachment.environmentId)));
    const environmentById = new Map<string, EnvironmentRecord>();
    for (const environmentId of environmentIds) {
      const environment = environmentRepo.getById(environmentId);
      if (environment) {
        environmentById.set(environment.id, environment);
      }
    }
    const attachmentByThreadId = new Map(
      attachments.map((attachment) => [attachment.threadId, attachment] as const),
    );
    return threads.map((thread) => {
      const attachment = attachmentByThreadId.get(thread.id);
      const attachedEnvironment =
        attachment ? environmentById.get(attachment.environmentId) : undefined;
      return attachedEnvironment
        ? {
          ...thread,
          attachedEnvironment,
        }
        : thread;
    });
  };
  return new Hono()
    .post("/", zValidator("json", spawnThreadSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        if (body.input) {
          validatePromptInputAttachments(body.input);
        }
        const thread = await threadManager.spawn({
          projectId: body.projectId,
          ...(body.providerId ? { providerId: body.providerId } : {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.input ? { input: body.input } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.serviceTier ? { serviceTier: body.serviceTier } : {}),
          ...(body.reasoningLevel ? { reasoningLevel: body.reasoningLevel } : {}),
          ...(body.sandboxMode ? { sandboxMode: body.sandboxMode } : {}),
          ...(body.environmentId ? { environmentId: body.environmentId } : {}),
          ...(body.environmentDescriptor
            ? { environmentDescriptor: body.environmentDescriptor }
            : {}),
          ...(body.environmentCreationArgs
            ? { environmentCreationArgs: body.environmentCreationArgs }
            : {}),
          ...(body.parentThreadId ? { parentThreadId: body.parentThreadId } : {}),
          ...(body.developerInstructions !== undefined
            ? { developerInstructions: body.developerInstructions }
            : {}),
        });
        return c.json(hydrateThread(thread), 201);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post(
      "/:id/open-path",
      zValidator("json", openThreadPathBodySchema),
      async (c) => {
        try {
          const body = c.req.valid("json");
          const path = threadManager.resolveThreadOpenPath(
            c.req.param("id"),
            body.relativePath,
          );
          openPath({
            path,
            ...(body.target ? { target: body.target } : {}),
            ...(body.editor ? { editor: body.editor } : {}),
            ...(body.command ? { command: body.command } : {}),
          });
          return c.json({ ok: true });
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get("/", zValidator("query", listThreadsQuerySchema), async (c) => {
      try {
        const filters = c.req.valid("query");
        const includeArchived =
          filters.includeArchived === "true"
            ? true
            : filters.includeArchived === "false"
              ? false
              : undefined;
        const includeWorkStatus =
          filters.includeWorkStatus === "true"
            ? true
            : filters.includeWorkStatus === "false"
              ? false
              : undefined;
        const threadFilters = {
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.parentThreadId
            ? { parentThreadId: filters.parentThreadId }
            : {}),
          ...(includeArchived !== undefined ? { includeArchived } : {}),
          ...(includeWorkStatus !== undefined ? { includeWorkStatus } : {}),
        };
        const asyncListAccessor = threadManager as ThreadOrchestrator & {
          listAsync?: (
            filters?: Parameters<ThreadOrchestrator["list"]>[0],
          ) => Promise<ReturnType<ThreadOrchestrator["list"]>>;
        };
        const threads =
          includeWorkStatus && asyncListAccessor.listAsync
            ? await asyncListAccessor.listAsync(threadFilters)
            : threadManager.list(threadFilters);
        return c.json(hydrateThreads(threads));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id", async (c) => {
      try {
        const thread = await threadManager.getHydratedByIdAsync(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        return c.json(hydrateThread(thread));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/default-execution-options", async (c) => {
      try {
        const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const options = threadManager.getDefaultExecutionOptions(
          c.req.param("id"),
        );
        return c.json(options ?? null);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/manager-workspace/files", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (thread.type !== "manager") {
          throw invalidRequestError("Manager workspace is only available for manager threads");
        }

        const workspacePath = resolveManagerWorkspacePath(runtimeEnv, thread.id);
        const files = existsSync(workspacePath)
          ? listManagerWorkspaceFiles(workspacePath)
          : [];
        return c.json({ files });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get(
      "/:id/manager-workspace/file",
      zValidator("query", managerWorkspaceFileQuerySchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (thread.type !== "manager") {
            throw invalidRequestError("Manager workspace is only available for manager threads");
          }

          const workspacePath = resolveManagerWorkspacePath(runtimeEnv, thread.id);
          const { path } = c.req.valid("query");
          const requestedPath = resolve(workspacePath, path);
          if (!isPathWithinDirectory(requestedPath, workspacePath)) {
            throw invalidRequestError("Manager workspace path is outside thread scope");
          }
          if (!existsSync(requestedPath)) {
            throw invalidRequestError("Manager workspace file not found");
          }
          return c.json({
            path,
            content: readFileSync(requestedPath, "utf8"),
          });
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get("/:id/env-daemon/status", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (!environmentAgentAccessor.getEnvironmentAgentStatus) {
          throw invalidRequestError("Env-daemon status is unavailable");
        }
        const status = await environmentAgentAccessor.getEnvironmentAgentStatus(
          threadId,
        );
        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/manager-workspace/files", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (thread.type !== "manager") {
          throw invalidRequestError("Manager workspace is only available for manager threads");
        }

        const workspacePath = resolveManagerWorkspacePath(runtimeEnv, thread.id);
        const files = existsSync(workspacePath)
          ? listManagerWorkspaceFiles(workspacePath)
          : [];
        return c.json({ files });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get(
      "/:id/manager-workspace/file",
      zValidator("query", managerWorkspaceFileQuerySchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (thread.type !== "manager") {
            throw invalidRequestError("Manager workspace is only available for manager threads");
          }

          const workspacePath = resolveManagerWorkspacePath(runtimeEnv, thread.id);
          const { path } = c.req.valid("query");
          const requestedPath = resolve(workspacePath, path);
          if (!isPathWithinDirectory(requestedPath, workspacePath)) {
            throw invalidRequestError("Manager workspace path is outside thread scope");
          }
          if (!existsSync(requestedPath)) {
            throw invalidRequestError("Manager workspace file not found");
          }
          return c.json({
            path,
            content: readFileSync(requestedPath, "utf8"),
          });
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get("/:id/environment-agent/status", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (!environmentAgentAccessor.getEnvironmentAgentStatus) {
          throw invalidRequestError("Env-daemon status is unavailable");
        }
        const status = await environmentAgentAccessor.getEnvironmentAgentStatus(
          threadId,
        );
        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/env-daemon/sessions", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (!environmentAgentSessionService) {
          throw invalidRequestError("Env-daemon session inspection is unavailable");
        }
        const sessions = environmentAgentSessionService
          .listSessions(threadId)
          .map(toEnvironmentAgentSessionDebugView);
        return c.json({
          threadId,
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
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (!environmentAgentSessionService) {
            throw invalidRequestError("Env-daemon session open is unavailable");
          }
          const body = c.req.valid("json") as EnvironmentAgentSessionOpenPayload;
          const opened = environmentAgentSessionService.openSession({
            threadId,
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
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (!environmentAgentSessionService) {
            throw invalidRequestError("Env-daemon session command pull is unavailable");
          }
          const query = c.req.valid("query");
          const response = await environmentAgentSessionService.waitForCommands({
            threadId,
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
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (!environmentAgentSessionService) {
            throw invalidRequestError("Env-daemon session message handling is unavailable");
          }
          const body = c.req.valid("json") as Exclude<
            EnvironmentAgentSessionClientMessage,
            { type: "session_open" }
          >;
          switch (body.type) {
            case "heartbeat":
              environmentAgentSessionService.recordHeartbeat({
                threadId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionHeartbeatPayload,
              });
              return c.body(null, 204);
            case "event_batch": {
              const response = await environmentAgentSessionService.applyEventBatch({
                threadId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionEventBatchPayload,
              });
              return c.json(response);
            }
            case "command_ack":
              environmentAgentSessionService.recordCommandAck({
                threadId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionCommandAckPayload,
              });
              return c.body(null, 204);
            case "command_result":
              environmentAgentSessionService.recordCommandResult({
                threadId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionCommandResultPayload,
              });
              return c.body(null, 204);
            case "provider_request": {
              const response = await environmentAgentSessionService.handleProviderRequest({
                threadId,
                sessionId: body.sessionId,
                payload: body.payload as EnvironmentAgentSessionProviderRequestPayload,
              });
              return c.json(response);
            }
            case "session_close":
              environmentAgentSessionService.closeSession({
                threadId,
                sessionId: body.sessionId,
                reason: (body.payload as { reason: "agent_shutdown" | "daemon_shutdown" | "migration" | "internal_error" }).reason,
              });
              return c.body(null, 204);
            default:
              assertNever(body);
          }
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .patch(
      "/:id",
      zValidator("json", updateThreadSchema),
      async (c) => {
        try {
          const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const { title, mergeBaseBranch, parentThreadId } = c.req.valid("json");
          const updated = threadManager.updateThread(c.req.param("id"), {
            title,
            mergeBaseBranch,
            parentThreadId,
          });
          return c.json(updated);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/tell",
      zValidator("json", tellThreadSchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const {
            input,
            model,
            serviceTier,
            reasoningLevel,
            sandboxMode,
            mode,
            demotePrimaryIfNeeded,
          } = c.req.valid("json");
          validatePromptInputAttachments(input);
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          if (
            demotePrimaryIfNeeded === true &&
            mode !== "steer" &&
            threadManager.isPrimaryCheckoutActive(threadId)
          ) {
            await threadManager.demotePrimaryCheckout(threadId);
          }
          const tellRequest = mode ? { input, mode } : { input };
          const options =
            model || serviceTier || reasoningLevel || sandboxMode
              ? { model, serviceTier, reasoningLevel, sandboxMode }
              : undefined;
          if (options) {
            await threadManager.tell(threadId, tellRequest, options);
          } else {
            await threadManager.tell(threadId, tellRequest);
          }
          return c.json({ ok: true });
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/queue",
      zValidator("json", enqueueThreadMessageSchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const { input, model, serviceTier, reasoningLevel, sandboxMode } = c.req.valid("json");
          validatePromptInputAttachments(input);
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }

          const updatedThread = threadManager.enqueueFollowUp(threadId, {
            input,
            model,
            serviceTier,
            reasoningLevel,
            sandboxMode,
          });
          const queuedMessages = updatedThread.queuedMessages ?? [];
          const queuedMessage =
            queuedMessages[queuedMessages.length - 1];
          if (!queuedMessage) {
            throw invalidRequestError("Failed to queue follow-up");
          }
          return c.json(queuedMessage, 201);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/queue/:queuedMessageId/send",
      zValidator("json", sendQueuedThreadMessageSchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          const body = c.req.valid("json");
          const response = await threadManager.sendQueuedFollowUp(
            threadId,
            c.req.param("queuedMessageId"),
            body,
          );
          return c.json(response);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .delete("/:id/queue/:queuedMessageId", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        threadManager.removeQueuedFollowUp(
          threadId,
          c.req.param("queuedMessageId"),
        );
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .delete("/:id", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        await threadManager.deleteThread(threadId);
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/stop", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        threadManager.stop(threadId);
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/archive", zValidator("json", archiveThreadBodySchema), async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        const { force } = c.req.valid("json");
        if (!force && threadManager.requiresForceArchive(thread.id)) {
          const workStatus = await threadManager.getWorkStatusAsync(thread.id);
          if (
            workStatus &&
            (
              workStatus.state === "untracked" ||
              workStatus.state === "dirty_uncommitted" ||
              workStatus.state === "committed_unmerged" ||
              workStatus.state === "dirty_and_committed_unmerged"
            )
          ) {
            return c.json({
              error:
                "Thread workspace has uncommitted or unmerged work. Archiving may lose work; retry with force=true.",
              code: "worktree_not_clean",
              workStatusState: workStatus.state,
            }, 409);
          }
        }
        await threadManager.archive(threadId);
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/unarchive", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        threadManager.unarchive(threadId);
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/read", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        const updated = threadManager.markRead(threadId);
        return c.json(updated);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/unread", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        const updated = threadManager.markUnread(threadId);
        return c.json(updated);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/work-status", zValidator("query", workStatusQuerySchema), async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        const query = c.req.valid("query");
        const workStatus = await threadManager.getWorkStatusAsync(
          threadId,
          query.mergeBaseBranch,
        );
        return c.json(
          workStatus ?? null,
        );
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/merge-base-branches", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        const mergeBaseBranches = await threadManager.getMergeBaseBranchesAsync(threadId);
        return c.json(mergeBaseBranches ?? []);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/primary-status", async (c) => {
      try {
        const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        return c.json(threadManager.getPrimaryCheckoutStatus(thread.projectId));
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get(
      "/:id/timeline",
      zValidator("query", timelineQuerySchema),
      async (c) => {
        try {
          const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const { limit, includeToolGroupMessages, includeManagerDebugView } = c.req.valid("query");
          const timeline = threadManager.getTimeline(
            c.req.param("id"),
            limit,
            includeToolGroupMessages,
            includeManagerDebugView,
          );
          return c.json(timeline);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get(
      "/:id/tool-group-messages",
      zValidator("query", toolGroupMessagesQuerySchema),
      async (c) => {
        try {
          const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const {
            turnId,
            sourceSeqStart,
            sourceSeqEnd,
            includeManagerDebugView,
          } = c.req.valid("query");
          const messages = threadManager.getToolGroupMessages(
            c.req.param("id"),
            {
              turnId,
              sourceSeqStart,
              sourceSeqEnd,
              includeManagerDebugView,
            },
          );
          return c.json(messages);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get(
      "/:id/git-diff",
      zValidator("query", gitDiffQuerySchema),
      async (c) => {
        try {
          const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const query = c.req.valid("query");
          const selectionType =
            query.selection ??
            (query.commitSha ? "commit" : "combined");
          let selection: ThreadGitDiffSelection;
          if (selectionType === "commit") {
            if (!query.commitSha) {
              throw invalidRequestError(
                "commitSha is required when selection=commit",
              );
            }
            selection = { type: "commit", sha: query.commitSha };
          } else {
            selection = { type: "combined" };
          }
          const result = await threadManager.getGitDiffAsync(
            c.req.param("id"),
            selection,
            query.mergeBaseBranch,
          );
          return c.json(result);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/promote",
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          const result = await threadManager.promoteThread(threadId);
          return c.json(result);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/demote-primary",
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          const result = await threadManager.demotePrimaryCheckout(threadId);
          return c.json(result);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/operations",
      zValidator("json", threadOperationSchema),
      async (c) => {
        try {
          const threadId = c.req.param("id");
          const thread = await getThreadForRouteLookup(threadManager, threadId);
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(threadId));
          }
          const body = c.req.valid("json");
          const result = await threadManager.requestThreadOperation(threadId, body);
          return c.json(result, 202);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get(
      "/:id/events",
      zValidator("query", eventsQuerySchema),
      async (c) => {
        try {
          const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }

          const { afterSeq, limit } = c.req.valid("query");
          const afterSeqNum = afterSeq ? parseInt(afterSeq, 10) : undefined;

          const events = threadManager.getEvents(
            c.req.param("id"),
            afterSeqNum,
            limit,
          );
          return c.json(events);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .get("/:id/output", async (c) => {
      try {
        const thread = await getThreadForRouteLookup(threadManager, c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const output = threadManager.getOutput(c.req.param("id"));
        return c.json({ output: output ?? null });
      } catch (err) {
        return sendRouteError(c, err);
      }
    });
}
