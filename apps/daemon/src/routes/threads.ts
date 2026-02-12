import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { spawnThreadSchema, tellThreadSchema } from "@beanbag/core";
import { z } from "zod";
import type { ThreadManager } from "../thread-manager.js";
import { threadNotFoundError } from "../domain-errors.js";
import { sendRouteError } from "./error-response.js";

const listThreadsQuerySchema = z.object({
  projectId: z.string().optional(),
});

const eventsQuerySchema = z.object({
  afterSeq: z.string().optional(),
});

export function createThreadRoutes(threadManager: ThreadManager) {
  return new Hono()
    .post("/", zValidator("json", spawnThreadSchema), async (c) => {
      try {
        const body = c.req.valid("json");
        const thread = await threadManager.spawn(body);
        return c.json(thread, 201);
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/", zValidator("query", listThreadsQuerySchema), async (c) => {
      try {
        const filters = c.req.valid("query");
        const threads = threadManager.list(filters);
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
    .post(
      "/:id/tell",
      zValidator("json", tellThreadSchema),
      async (c) => {
        try {
          const { input, model, reasoningLevel, sandboxMode, mode } = c.req.valid("json");
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
        threadManager.archive(c.req.param("id"));
        return c.json({ ok: true });
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get(
      "/:id/events",
      zValidator("query", eventsQuerySchema),
      async (c) => {
        try {
          const thread = threadManager.getById(c.req.param("id"));
          if (!thread) {
            return sendRouteError(c, threadNotFoundError(c.req.param("id")));
          }

          const { afterSeq } = c.req.valid("query");
          const afterSeqNum = afterSeq ? parseInt(afterSeq, 10) : undefined;

          const events = threadManager.getEvents(
            c.req.param("id"),
            afterSeqNum,
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
