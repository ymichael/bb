import {
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import { ApiError } from "../errors.js";
import type { AppDeps } from "../types.js";
import { hostArtifactFileResponse } from "./host-artifact-response.js";

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

export function registerInternalPluginHostArtifactRoutes(
  app: Hono,
  deps: Pick<AppDeps, "pluginHostArtifacts">,
): void {
  const { get } = typedRoutes<HostDaemonInternalSchema>(app);
  get("/plugins/:pluginId/host/:digest", async (context) => {
    const notFound = new ApiError(
      404,
      "plugin_host_artifact_not_found",
      "Host artifact not found",
    );
    const pluginId = context.req.param("pluginId");
    const digest = context.req.param("digest");
    if (!DIGEST_PATTERN.test(digest)) {
      throw notFound;
    }
    const artifact = deps.pluginHostArtifacts.get(pluginId);
    if (artifact === undefined || artifact.digest !== digest) {
      throw notFound;
    }
    const response = await hostArtifactFileResponse({
      path: artifact.path,
      byteLength: artifact.byteLength,
      digest,
    });
    if (response === null) {
      throw notFound;
    }
    return response;
  });
}
