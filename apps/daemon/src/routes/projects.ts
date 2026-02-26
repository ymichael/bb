import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { createProjectSchema, type ProjectFileSuggestion } from "@beanbag/agent-core";
import { z } from "zod";
import type { ProjectRepository } from "@beanbag/db";
import { searchProjectFiles } from "../project-file-search.js";

const projectFileQuerySchema = z.object({
  query: z.string().default(""),
  limit: z
    .string()
    .optional()
    .transform((value) => {
      if (!value) return undefined;
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }),
});

type SearchProjectFilesFn = (
  rootPath: string,
  query: string,
  limit?: number,
) => Promise<ProjectFileSuggestion[]>;

export function createProjectRoutes(
  projectRepo: ProjectRepository,
  findProjectFiles: SearchProjectFilesFn = searchProjectFiles,
) {
  return new Hono()
    .post("/", zValidator("json", createProjectSchema), async (c) => {
      try {
        const { name, rootPath } = c.req.valid("json");
        const project = projectRepo.create({ name, rootPath });
        return c.json(project, 201);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    })
    .get("/", async (c) => {
      try {
        const projects = projectRepo.list();
        return c.json(projects);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    })
    .get("/:id/files", zValidator("query", projectFileQuerySchema), async (c) => {
      try {
        const project = projectRepo.getById(c.req.param("id"));
        if (!project) {
          return c.json({ error: "Project not found" }, 404);
        }

        const { query, limit } = c.req.valid("query");
        if (query.trim().length === 0) {
          return c.json([]);
        }
        const files = await findProjectFiles(project.rootPath, query, limit);
        return c.json(files);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return c.json({ error: message }, 500);
      }
    });
}
