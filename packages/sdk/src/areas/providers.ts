import type {
  SystemExecutionOptionsResponse,
  SystemProviderInfo,
  SystemProvidersQuery,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ProviderHostRoutingArgs =
  | { environmentId: string; hostId?: never }
  | { environmentId?: never; hostId: string }
  | { environmentId?: never; hostId?: never };

export type ProviderListArgs = ProviderHostRoutingArgs & {
  capability?: SystemProvidersQuery["capability"];
  signal?: AbortSignal;
};
export type ProviderModelsArgs = ProviderHostRoutingArgs & {
  providerId?: string;
  signal?: AbortSignal;
};

export type ProviderListResult = SystemProviderInfo[];
export type ProviderModelsResult = SystemExecutionOptionsResponse;

export interface ProvidersArea {
  list(args?: ProviderListArgs): Promise<ProviderListResult>;
  models(args?: ProviderModelsArgs): Promise<ProviderModelsResult>;
}

export function createProvidersArea(args: CreateSdkAreaArgs): ProvidersArea {
  const { transport } = args;
  return {
    async list(input = {}) {
      return transport.readJson(
        transport.api.v1.system.providers.$get(
          {
            query: {
              capability: input.capability,
              environmentId: input.environmentId,
              hostId: input.hostId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async models(input = {}) {
      return transport.readJson(
        transport.api.v1.system["execution-options"].$get(
          {
            query: {
              environmentId: input.environmentId,
              hostId: input.hostId,
              providerId: input.providerId,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
  };
}
