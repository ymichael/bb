import type {
  SystemProviderState,
  SystemProviderStatesResponse,
  SystemProvidersQuery,
} from "@bb/server-contract";
import type { ProviderInfo } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import { requireEnvironment } from "../lib/entity-lookup.js";
import { listSystemProviderInfos } from "./execution-options.js";
import { resolveSystemLookupHostId } from "./host-lookup.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";
import { resolvePluginProviderEnvHealth } from "../plugins/plugin-agent-contributions.js";

function unknownProviderState(
  provider: ProviderInfo,
  statusMessage: string,
): SystemProviderState {
  return {
    providerId: provider.id,
    displayName: provider.displayName,
    status: "unknown",
    statusMessage,
    accountEmail: null,
    planLabel: null,
    installedVersion: null,
    minimumSupportedVersion: null,
    canInstall: false,
    canUpdate: false,
    loginCommand: null,
  };
}

async function getProviderState(
  deps: AppDeps,
  args: { cwd?: string; hostId: string; provider: ProviderInfo },
): Promise<SystemProviderState> {
  if (!args.provider.maintenance.health) {
    return unknownProviderState(
      args.provider,
      "This provider does not report readiness.",
    );
  }
  const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, args.provider.id);
  if (bridgeLaunch === null) {
    return unknownProviderState(
      args.provider,
      "The provider bridge is unavailable.",
    );
  }

  try {
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "provider.health",
        providerId: args.provider.id,
        bridgeLaunch,
        ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      },
    });
    if (!result.supported) {
      return unknownProviderState(
        args.provider,
        "Provider readiness was not reported.",
      );
    }
    const health = {
      providerId: args.provider.id,
      displayName: args.provider.displayName,
      ...result.health,
    };
    if (health.status !== "unauthenticated" && health.status !== "expired") {
      return health;
    }
    const contributed = await resolvePluginProviderEnvHealth({
      providerId: args.provider.id,
      hostId: args.hostId,
    });
    if (contributed === null) return health;
    return {
      ...health,
      status: "ready",
      statusMessage: contributed.statusMessage,
      accountEmail: null,
      planLabel: contributed.label,
      loginCommand: null,
    };
  } catch {
    return unknownProviderState(
      args.provider,
      "Provider readiness could not be checked.",
    );
  }
}

export async function getProviderStates(
  deps: AppDeps,
  query: SystemProvidersQuery,
): Promise<SystemProviderStatesResponse> {
  const hostId = resolveSystemLookupHostId(deps, query);
  const cwd =
    query.environmentId === undefined
      ? undefined
      : (requireEnvironment(deps.db, query.environmentId).path ?? undefined);
  const providers = await listSystemProviderInfos(deps, { hostId });
  return {
    providers: await mapProviderMaintenanceRequests(providers, (provider) =>
      getProviderState(deps, {
        hostId,
        provider,
        ...(cwd === undefined ? {} : { cwd }),
      }),
    ),
  };
}
