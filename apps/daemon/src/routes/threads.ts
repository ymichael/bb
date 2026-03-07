import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  type OpenPathRequest,
  enqueueThreadMessageSchema,
  sendQueuedThreadMessageSchema,
  spawnThreadSchema,
  threadOperationSchema,
  tellThreadSchema,
  updateThreadSchema,
  type PromptInput,
  type ThreadGitDiffSelection,
  type ThreadOrchestrator,
} from "@beanbag/agent-core";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { invalidRequestError, threadNotFoundError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";
import { openPathInEditor } from "./system.js";

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
});

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

export function createThreadRoutes(
  threadManager: ThreadOrchestrator,
  opts?: {
    openPath?: OpenPathFn;
  },
) {
  const openPath = opts?.openPath ?? openPathInEditor;
  return new Hono()
    .post("/", zValidator("json", spawnThreadSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        if (body.input) {
          validatePromptInputAttachments(body.input);
        }
        const thread = await threadManager.spawn({
          projectId: body.projectId,
          ...(body.title ? { title: body.title } : {}),
          ...(body.input ? { input: body.input } : {}),
          ...(body.model ? { model: body.model } : {}),
          ...(body.reasoningLevel ? { reasoningLevel: body.reasoningLevel } : {}),
          ...(body.sandboxMode ? { sandboxMode: body.sandboxMode } : {}),
          ...(body.environmentId ? { environmentId: body.environmentId } : {}),
          ...(body.parentThreadId ? { parentThreadId: body.parentThreadId } : {}),
          ...(body.developerInstructions !== undefined
            ? { developerInstructions: body.developerInstructions }
            : {}),
        });
        return c.json(thread, 201);
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
        const threads = threadManager.list({
          ...(filters.projectId ? { projectId: filters.projectId } : {}),
          ...(filters.parentThreadId
            ? { parentThreadId: filters.parentThreadId }
            : {}),
          ...(includeArchived !== undefined ? { includeArchived } : {}),
          ...(includeWorkStatus !== undefined ? { includeWorkStatus } : {}),
        });
        return c.json(threads);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        return c.json(thread);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/default-execution-options", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
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
    .patch(
      "/:id",
      zValidator("json", updateThreadSchema),
      async (c) => {
        try {
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const { title } = c.req.valid("json");
          const updated = threadManager.updateThread(c.req.param("id"), { title });
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
          const {
            input,
            model,
            reasoningLevel,
            sandboxMode,
            mode,
            demotePrimaryIfNeeded,
          } = c.req.valid("json");
          validatePromptInputAttachments(input);
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          if (
            demotePrimaryIfNeeded === true &&
            mode !== "steer" &&
            thread.primaryCheckout?.isActive === true
          ) {
            await threadManager.demotePrimaryCheckout(c.req.param("id"));
          }
          const tellRequest = mode ? { input, mode } : { input };
          const options =
            model || reasoningLevel || sandboxMode
              ? { model, reasoningLevel, sandboxMode }
              : undefined;
          if (options) {
            await threadManager.tell(c.req.param("id"), tellRequest, options);
          } else {
            await threadManager.tell(c.req.param("id"), tellRequest);
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
          const { input, model, reasoningLevel, sandboxMode } = c.req.valid("json");
          validatePromptInputAttachments(input);
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }

          const updatedThread = threadManager.enqueueFollowUp(c.req.param("id"), {
            input,
            model,
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const body = c.req.valid("json");
          const response = await threadManager.sendQueuedFollowUp(
            c.req.param("id"),
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
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        threadManager.removeQueuedFollowUp(
          c.req.param("id"),
          c.req.param("queuedMessageId"),
        );
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/stop", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        threadManager.stop(c.req.param("id"));
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/archive", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const bodyRaw = await c.req.json<unknown>().catch(() => ({}));
        const parsedBody = archiveThreadBodySchema.safeParse(bodyRaw);
        if (!parsedBody.success) {
          throw invalidRequestError("Invalid archive request body");
        }
        const force = parsedBody.data.force === true;
        if (!force && threadManager.requiresForceArchive(thread.id)) {
          const workStatus = threadManager.getWorkStatus(thread.id);
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
        threadManager.archive(c.req.param("id"));
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/unarchive", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        threadManager.unarchive(c.req.param("id"));
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/read", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const updated = threadManager.markRead(c.req.param("id"));
        return c.json(updated);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .post("/:id/unread", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const updated = threadManager.markUnread(c.req.param("id"));
        return c.json(updated);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/work-status", zValidator("query", workStatusQuerySchema), async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
        if (!thread) {
          return sendRouteError(c, threadNotFoundError(c.req.param("id")));
        }
        const query = c.req.valid("query");
        const asyncWorkStatusAccessor = threadManager as ThreadOrchestrator & {
          getWorkStatusAsync?: (
            threadId: string,
            mergeBaseBranch?: string,
          ) => Promise<ReturnType<ThreadOrchestrator["getWorkStatus"]>>;
        };
        const workStatus = asyncWorkStatusAccessor.getWorkStatusAsync
          ? await asyncWorkStatusAccessor.getWorkStatusAsync(
              c.req.param("id"),
              query.mergeBaseBranch,
            )
          : threadManager.getWorkStatus(c.req.param("id"), query.mergeBaseBranch);
        return c.json(
          workStatus ?? null,
        );
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id/primary-status", async (c) => {
      try {
        const thread = threadManager.getById(c.req.param("id"));
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const { limit, includeToolGroupMessages } = c.req.valid("query");
          const timeline = threadManager.getTimeline(
            c.req.param("id"),
            limit,
            includeToolGroupMessages,
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const { turnId, sourceSeqStart, sourceSeqEnd } = c.req.valid("query");
          const messages = threadManager.getToolGroupMessages(
            c.req.param("id"),
            {
              turnId,
              sourceSeqStart,
              sourceSeqEnd,
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
          const thread = threadManager.getById(c.req.param("id"));
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
          const result = threadManager.getGitDiff(
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const result = await threadManager.promoteThread(c.req.param("id"));
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const result = await threadManager.demotePrimaryCheckout(c.req.param("id"));
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
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const body = c.req.valid("json");
          const result = await threadManager.requestThreadOperation(c.req.param("id"), body);
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
          const thread = threadManager.getById(c.req.param("id"));
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
        const thread = threadManager.getById(c.req.param("id"));
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
