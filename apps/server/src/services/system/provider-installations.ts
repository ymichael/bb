import type {
  ProviderCliStatus,
  ProviderCliStatusResponse,
} from "@bb/host-daemon-contract";
import { ZodError } from "zod";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { ApiError } from "../../errors.js";
import {
  callHostRetryableOnlineRpc,
  isHostUnavailableApiError,
} from "../hosts/online-rpc.js";
import { listSystemProviderInfos } from "./execution-options.js";
import { resolveBridgeLaunchForProviderId } from "./provider-bridge-launch.js";
import { mapProviderMaintenanceRequests } from "./provider-maintenance-concurrency.js";

const PROVIDER_INSTALLATION_STATUS_TIMEOUT_MS = 70_000;

function canOmitProviderInstallationStatusError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  return (
    error instanceof ApiError &&
    !isHostUnavailableApiError(error) &&
    (error.status === 502 || error.status === 504)
  );
}

export async function getProviderInstallations(
  deps: AppDeps,
  args: { hostId: string },
): Promise<ProviderCliStatusResponse> {
  const deadline = Date.now() + PROVIDER_INSTALLATION_STATUS_TIMEOUT_MS;
  const providers = await listSystemProviderInfos(deps, {
    hostId: args.hostId,
    capability: "installation",
  });
  const entries = await mapProviderMaintenanceRequests(
    providers,
    async (provider): Promise<[string, ProviderCliStatus] | null> => {
      const bridgeLaunch = resolveBridgeLaunchForProviderId(deps, provider.id);
      if (bridgeLaunch === null) {
        deps.logger.warn(
          {
            failure: "bridge_unavailable",
            hostId: args.hostId,
            providerId: provider.id,
          },
          "Failed to load provider installation status; omitting provider",
        );
        return null;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        deps.logger.warn(
          {
            failure: "aggregate_deadline_exceeded",
            hostId: args.hostId,
            providerId: provider.id,
          },
          "Failed to load provider installation status; omitting provider",
        );
        return null;
      }
      try {
        const status = await callHostRetryableOnlineRpc(deps, {
          hostId: args.hostId,
          timeoutMs: Math.min(COMMAND_TIMEOUT_MS, remainingMs),
          command: {
            type: "provider.installation.status",
            providerId: provider.id,
            bridgeLaunch,
          },
        });
        return [provider.id, { displayName: provider.displayName, ...status }];
      } catch (error) {
        if (!canOmitProviderInstallationStatusError(error)) {
          throw error;
        }
        deps.logger.warn(
          {
            failure: "status_request_failed",
            hostId: args.hostId,
            providerId: provider.id,
          },
          "Failed to load provider installation status; omitting provider",
        );
        return null;
      }
    },
  );
  return Object.fromEntries(
    entries.filter(
      (entry): entry is [string, ProviderCliStatus] => entry !== null,
    ),
  );
}
