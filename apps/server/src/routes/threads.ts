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
  tellThreadSchema,
  updateThreadSchema,
  type PromptInput,
  type ThreadGitDiffSelection,
  type Thread,
} from "@bb/core";
import { z } from "zod";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  EnvironmentDaemonStatusSnapshot,
} from "@bb/environment-daemon";
import { invalidRequestError, threadNotFoundError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import { openPathInEditor } from "./system.js";
import type {
  EnvironmentRepository,
  ThreadEnvironmentAttachmentRepository,
} from "@bb/db";
import { resolveManagerWorkspacePath } from "../manager-thread.js";

const listThreadsQuerySchema = z.object({
  projectId: z.string().optional(),
  type: z.enum(["standard", "manager"]).optional(),
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

type RouteEnvironmentDaemonCapableOrchestrator = ThreadOrchestrator & {
  getEnvironmentDaemonStatus?: (
    threadId: string,
  ) => Promise<EnvironmentDaemonStatusSnapshot>;
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

export function createThreadRoutes(
  threadManager: ThreadOrchestrator,
  opts?: {
    environmentRepo?: EnvironmentRepository;
    threadEnvironmentAttachmentRepo?: ThreadEnvironmentAttachmentRepository;
    openPath?: OpenPathFn;
    runtimeEnv?: NodeJS.ProcessEnv;
  },
) {
  const openPath = opts?.openPath ?? openPathInEditor;
  const environmentRepo = opts?.environmentRepo;
  const threadEnvironmentAttachmentRepo = opts?.threadEnvironmentAttachmentRepo;
  const runtimeEnv = opts?.runtimeEnv ?? process.env;
  const environmentDaemonAccessor =
    threadManager as RouteEnvironmentDaemonCapableOrchestrator;
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
      environmentId: attachment.environmentId,
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
          environmentId: attachedEnvironment.id,
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
          ...(filters.type ? { type: filters.type } : {}),
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
    .get("/:id/environment-daemon/status", async (c) => {
      try {
        const threadId = c.req.param("id");
        const thread = await getThreadForRouteLookup(threadManager, threadId);
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(threadId));
        }
        if (!environmentDaemonAccessor.getEnvironmentDaemonStatus) {
          throw invalidRequestError("Env-daemon status is unavailable");
        }
        const status = await environmentDaemonAccessor.getEnvironmentDaemonStatus(
          threadId,
        );
        return c.json(status);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
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
          return c.json(hydrateThread(updated));
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
            await threadManager.demoteThreadEnvironmentFromPrimaryCheckout(threadId);
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
        return c.json(hydrateThread(updated));
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
        return c.json(hydrateThread(updated));
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
