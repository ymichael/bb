import type {
  ProviderUsage,
  ProviderUsageResponse,
} from "@bb/host-daemon-contract";
import type { SystemUsageLimitsQuery } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { callHostRetryableOnlineRpc } from "../hosts/online-rpc.js";
import {
  assertUsableHostId,
  requirePrimaryHostId,
} from "../hosts/primary-host.js";
import { listSystemProviderInfos } from "./execution-options.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";

export async function getProviderUsageLimits(
  deps: AppDeps,
  query: SystemUsageLimitsQuery,
): Promise<ProviderUsageResponse> {
  const hostId = query.hostId ?? requirePrimaryHostId(deps);
  assertUsableHostId(deps, { hostId });
  const providers = (
    await listSystemProviderInfos(deps, { hostId, capability: "usage" })
  ).filter(
    (provider) =>
      query.providerId === undefined || provider.id === query.providerId,
  );
  const entries = await mapProviderMaintenanceRequests(
    providers,
    async (provider): Promise<[string, ProviderUsage] | null> => {
      if (!provider.maintenance.usage) return null;
      const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, provider.id);
      if (bridgeLaunch === null) return null;
      try {
        const result = await callHostRetryableOnlineRpc(deps, {
          hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "provider.usage",
            providerId: provider.id,
            bridgeLaunch,
          },
        });
        return result.supported ? [provider.id, result.usage] : null;
      } catch {
        return [
          provider.id,
          {
            status: "error",
            message: "Provider usage could not be loaded.",
            planLabel: null,
            accountEmail: null,
          },
        ];
      }
    },
  );
  return Object.fromEntries(
    entries.filter((entry): entry is [string, ProviderUsage] => entry !== null),
  );
}
