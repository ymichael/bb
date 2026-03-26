import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { listHostsWithStatus, requireHostWithStatus } from "../services/entity-lookup.js";

export function registerHostRoutes(app: Hono, deps: AppDeps): void {
  app.get("/hosts", (context) => context.json(listHostsWithStatus(deps.db)));

  app.get("/hosts/:id", (context) =>
    context.json(requireHostWithStatus(deps.db, context.req.param("id"))),
  );
}
