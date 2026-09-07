import { getNonDestroyedHost, updateHost } from "@bb/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@bb/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { getProviderInstallations } from "../services/system/provider-installations.js";
import { resolveBridgeLaunchForProviderId } from "../services/system/provider-bridge-launch.js";
import type { PluginService } from "../services/plugins/plugin-service.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  getGateAuthKind,
  type GateAuthHeaderReader,
} from "../request-context.js";
import {
  listPublicHostsWithStatus,
  requireNonDestroyedHostWithStatus,
  requirePublicStandardProject,
} from "../services/lib/entity-lookup.js";
import {
  assertUsableHostId,
  resolvePrimaryHostId,
} from "../services/hosts/primary-host.js";
import { issuePersistentHostEnrollKey } from "../services/hosts/host-enrollment.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../services/hosts/online-rpc.js";
import { handleHostRemoved } from "../internal/session-owner-side-effects.js";

const PROVIDER_CLI_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

function providerCliInstallEventsToNdjson(events: readonly unknown[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

function requireMutableHost(deps: AppDeps, hostId: string) {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return host;
}

function assertHostManagementAllowed(context: GateAuthHeaderReader): void {
  if (getGateAuthKind(context) === "machine") {
    throw new ApiError(
      403,
      "machine_host_management_forbidden",
      "Machine credentials cannot manage hosts",
    );
  }
}

async function revokeConnectMachineCredential(
  deps: AppDeps,
  plugins: PluginService,
  machineId: string,
): Promise<void> {
  try {
    const connectPlugin = plugins
      .list()
      .find((plugin) => plugin.source === "builtin:connect");
    if (!connectPlugin) throw new Error("connect plugin is not installed");
    const handler = plugins.getRpcHandler(connectPlugin.id, "revokeMachine");
    if (handler.outcome !== "found") {
      throw new Error(`connect plugin revoke handler is ${handler.outcome}`);
    }
    const result = await plugins.invokeRpcHandler(
      connectPlugin.id,
      "revokeMachine",
      handler.value,
      { machineId },
    );
    if (!result.ok) throw new Error(result.error.message);
  } catch (error) {
    deps.logger.error(
      { err: error, machineId },
      "Host was removed locally, but its bb connect machine credential could not be revoked. Revoke this machine manually from the getbb.app dashboard.",
    );
  }
}

export function registerHostRoutes(
  app: Hono,
  deps: AppDeps,
  plugins: PluginService,
): void {
  const { del, get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.hosts;

  post(routes.createJoinCode, async (context) => {
    assertHostManagementAllowed(context);
    const issued = await issuePersistentHostEnrollKey(deps, {
      enrollSource: "public-multi-machine",
    });
    return context.json(
      {
        joinCode: issued.enrollKey.key,
        hostId: issued.hostId,
        expiresAt: issued.enrollKey.expiresAt,
      },
      201,
    );
  });

  get(routes.list, (context) => context.json(listPublicHostsWithStatus(deps)));

  get(routes.get, (context) =>
    context.json(
      requireNonDestroyedHostWithStatus(deps, context.req.param("id")),
    ),
  );

  patch(routes.update, (context, payload) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      name: payload.name,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  patch(routes.updatePermissionCeiling, (context, payload) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      maxPermissionMode: payload.maxPermissionMode,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  post(routes.retryUpdate, (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (host.lastRejectedProtocolVersion === null) {
      throw new ApiError(
        409,
        "host_update_not_needed",
        "The machine is not waiting for a protocol update",
      );
    }
    if (host.lastRejectedProtocolVersion >= HOST_DAEMON_PROTOCOL_VERSION) {
      throw new ApiError(
        409,
        "host_cannot_self_update",
        "The machine daemon is not older than this server",
      );
    }
    deps.hub.requestHostProtocolUpdateRetry(hostId);
    return context.json({ ok: true as const });
  });

  del(routes.delete, async (context) => {
    assertHostManagementAllowed(context);
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (resolvePrimaryHostId(deps) === hostId) {
      throw new ApiError(
        400,
        "primary_host_removal_refused",
        "The primary host cannot be removed",
      );
    }

    await deps.machineAuth.revokeHostAuthKeys({
      hostId,
      hostType: host.type,
    });
    const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
    if (sessionId) {
      handleHostRemoved(deps, { hostId, sessionId });
    }
    updateHost(deps.db, deps.hub, hostId, { destroyedAt: Date.now() });
    if (host.connectMachineId !== null) {
      await revokeConnectMachineCredential(
        deps,
        plugins,
        host.connectMachineId,
      );
    }
    return context.json({ ok: true });
  });

  get(routes.directory, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.browse_directory",
        ...(query.path ? { path: query.path } : {}),
      },
    });
    return context.json(result);
  });

  get(routes.cloneDefaultPath, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const project = requirePublicStandardProject(deps.db, query.projectId);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "project.clone_default_path",
        projectSlug: project.name,
      },
    });
    return context.json(result);
  });

  post(routes.pathsExist, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.paths_exist",
        paths: payload.paths,
      },
    });
    return context.json(result);
  });

  post(routes.pickFolder, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    if (payload.clientHostId !== hostId) {
      throw new ApiError(
        409,
        "native_picker_unavailable",
        "Native folder picker is only available when the browser helper and work host are on the same machine",
      );
    }
    const result = await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: FOLDER_PICKER_TIMEOUT_MS,
      command: {
        type: "host.pick_folder",
      },
    });
    return context.json(result);
  });

  get(routes.providerCliStatus, async (context) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await getProviderInstallations(deps, { hostId });
    return context.json(result);
  });

  post(routes.providerCliInstall, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    await deps.providerRegistry.whenProviderRegistered(payload.provider);
    const registration = deps.providerRegistry.get(payload.provider);
    if (registration === null || !registration.info.maintenance.installation) {
      throw new ApiError(
        404,
        "provider_installation_unavailable",
        `Provider installation is unavailable for ${payload.provider}`,
      );
    }
    const bridgeLaunch = resolveBridgeLaunchForProviderId(
      deps,
      payload.provider,
    );
    if (bridgeLaunch === null) {
      throw new ApiError(
        409,
        "provider_bridge_unavailable",
        `Provider bridge is unavailable for ${payload.provider}`,
      );
    }
    const result = await callHostOnlineRpc(deps, {
      hostId,
      timeoutMs: PROVIDER_CLI_INSTALL_TIMEOUT_MS,
      command: {
        type: "provider.installation.run",
        providerId: payload.provider,
        action: payload.actionKind,
        bridgeLaunch,
      },
    });
    if (
      result.events.some((event) => event.type === "completed" && event.success)
    ) {
      deps.providerRegistry.forgetInstalledKey({
        hostId,
        providerId: payload.provider,
      });
    }
    return new Response(providerCliInstallEventsToNdjson(result.events), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });
}
