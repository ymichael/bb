import type { SystemExecutionOptionsResponse } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import { queueCommandAndWait } from "../hosts/command-wait.js";
import { resolveSystemLookupHostId } from "./host-lookup.js";

export interface SystemExecutionOptionsRequest {
  environmentId?: string;
  hostId?: string;
  providerId?: string;
}

export async function resolveSystemExecutionOptions(
  deps: AppDeps,
  query: SystemExecutionOptionsRequest,
): Promise<SystemExecutionOptionsResponse> {
  const hostId = resolveSystemLookupHostId(deps, query);
  const { providers } = await queueCommandAndWait(deps, {
    hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: { type: "provider.list" },
  });
  const requestedProvider = query.providerId
    ? providers.find((provider) => provider.id === query.providerId)
    : undefined;
  const modelsProviderId = requestedProvider?.id ?? providers[0]?.id;

  if (!modelsProviderId) {
    return {
      providers,
      models: [],
      selectedOnlyModels: [],
    };
  }

  const { models, selectedOnlyModels } = await queueCommandAndWait(deps, {
    hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "provider.list_models",
      providerId: modelsProviderId,
    },
  });

  return {
    providers,
    models,
    selectedOnlyModels,
  };
}
