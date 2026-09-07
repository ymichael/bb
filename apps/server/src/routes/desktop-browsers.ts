import { browserRequestProblem } from "../browser-request-guard.js";
import type { Hono } from "hono";
import {
  desktopBrowserCreateRequestSchema,
  desktopBrowserAcquireRequestSchema,
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  acquireDesktopBrowserControl,
  captureDesktopBrowserTab,
  createDesktopBrowserTab,
  desktopBrowserTabAction,
  listDesktopBrowserInstances,
  listDesktopBrowserTabs,
  openDesktopBrowserConnection,
  releaseDesktopBrowserControl,
} from "../services/desktop-browsers.js";

export function registerDesktopBrowserRoutes(app: Hono, deps: AppDeps) {
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.desktopBrowsers;
  for (const route of Object.values(routes)) {
    app.use(route.path, async (context, next) => {
      const problem = browserRequestProblem(context, deps, {
        requireJsonForMutation: true,
      });
      if (problem)
        throw new ApiError(
          problem.status,
          problem.status === 403
            ? "forbidden_origin"
            : "unsupported_media_type",
          problem.error,
        );
      await next();
    });
  }
  post(routes.listInstances, async (c, input) =>
    c.json(await listDesktopBrowserInstances(deps, input.hostId)),
  );
  post(routes.listTabs, async (c, input) =>
    c.json(await listDesktopBrowserTabs(deps, input)),
  );
  post(routes.createTab, async (c, input) =>
    c.json(
      await createDesktopBrowserTab(
        deps,
        desktopBrowserCreateRequestSchema.parse(input),
      ),
    ),
  );
  post(routes.acquireControl, async (c, input) =>
    c.json(
      await acquireDesktopBrowserControl(
        deps,
        desktopBrowserAcquireRequestSchema.parse(input),
      ),
    ),
  );
  post(routes.openConnection, async (c, input) => {
    c.header("Cache-Control", "no-store");
    return c.json(await openDesktopBrowserConnection(deps, input));
  });
  post(routes.releaseControl, async (c, input) =>
    c.json(await releaseDesktopBrowserControl(deps, input)),
  );
  post(routes.captureTab, async (c, input) => {
    c.header("Cache-Control", "no-store");
    return c.json(await captureDesktopBrowserTab(deps, input));
  });
  post(routes.revealTab, async (c, input) =>
    c.json(await desktopBrowserTabAction(deps, input, "reveal")),
  );
  post(routes.closeTab, async (c, input) =>
    c.json(await desktopBrowserTabAction(deps, input, "close")),
  );
}
