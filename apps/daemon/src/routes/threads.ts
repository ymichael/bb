import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  commitThreadSchema,
  squashMergeThreadSchema,
  spawnThreadSchema,
  tellThreadSchema,
  updateThreadSchema,
  type PromptInput,
  type ThreadOrchestrator,
} from "@beanbag/agent-core";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { invalidRequestError, threadNotFoundError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";

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

const archiveThreadBodySchema = z.object({
  force: z.boolean().optional(),
});

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
) {
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
          const { input, model, reasoningLevel, sandboxMode, mode } = c.req.valid("json");
          validatePromptInputAttachments(input);
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
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
        if (!force && thread.environmentId === "worktree") {
          const workStatus = threadManager.getWorkStatus(thread.id);
          if (
            workStatus &&
            (
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
        return c.json(
          threadManager.getWorkStatus(c.req.param("id"), query.mergeBaseBranch) ?? null,
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
      "/:id/commit",
      zValidator("json", commitThreadSchema.optional()),
      async (c) => {
        try {
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const body = c.req.valid("json");
          const result = await threadManager.commitThread(c.req.param("id"), body ?? undefined);
          return c.json(result);
        } catch (err) {
          return sendRouteError(c, err);
        }
      },
    )
    .post(
      "/:id/squash-merge",
      zValidator("json", squashMergeThreadSchema.optional()),
      async (c) => {
        try {
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }
          const body = c.req.valid("json");
          const result = await threadManager.squashMergeThread(c.req.param("id"), body ?? undefined);
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
