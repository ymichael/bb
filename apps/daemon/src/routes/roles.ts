import { Hono } from "hono";
import { listAgentRoleDefinitions } from "../agent-roles.js";

export function createRoleRoutes() {
  return new Hono().get("/", async (c) => {
    return c.json(listAgentRoleDefinitions());
  });
}
