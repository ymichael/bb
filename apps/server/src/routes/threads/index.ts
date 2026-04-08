import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { registerThreadActionRoutes } from "./actions.js";
import { registerThreadBaseRoutes } from "./base.js";
import { registerThreadDataRoutes } from "./data.js";
import { registerThreadInteractionRoutes } from "./interactions.js";

export function registerThreadRoutes(app: Hono, deps: AppDeps): void {
  registerThreadBaseRoutes(app, deps);
  registerThreadActionRoutes(app, deps);
  registerThreadDataRoutes(app, deps);
  registerThreadInteractionRoutes(app, deps);
}
