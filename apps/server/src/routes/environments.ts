import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { EnvironmentRepository } from "@bb/db";
import { sendRouteError } from "./error-response.js";

const listEnvironmentsQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});

export function createEnvironmentRoutes(
  environmentRepo?: EnvironmentRepository,
) {
  return new Hono()
    .get("/", zValidator("query", listEnvironmentsQuerySchema), async (c) => {
      try {
        if (!environmentRepo) {
          return c.json([]);
        }
        const query = c.req.valid("query");
        return c.json(
          environmentRepo.list(
            query.projectId ? { projectId: query.projectId } : undefined,
          ),
        );
      } catch (err) {
        return sendRouteError(c, err);
      }
    })
    .get("/:id", async (c) => {
      try {
        if (!environmentRepo) {
          return c.json(null, 404);
        }
        const environment = environmentRepo.getById(c.req.param("id"));
        return environment ? c.json(environment) : c.json(null, 404);
      } catch (err) {
        return sendRouteError(c, err);
      }
    });
}
