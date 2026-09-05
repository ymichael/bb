import { useQuery } from "@tanstack/react-query";
import type {
  SystemMachineProvider,
  SystemMachineProvidersQuery,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { SERVER_SESSION_QUERY_POLICY } from "./query-policies";

const SYSTEM_MACHINE_PROVIDERS_QUERY_KEY = "systemMachineProviders";
const NO_MACHINE_PROVIDERS: readonly SystemMachineProvider[] = [];

export function systemMachineProvidersQueryKey(
  query: SystemMachineProvidersQuery = {},
) {
  return [SYSTEM_MACHINE_PROVIDERS_QUERY_KEY, query.projectId ?? null] as const;
}

export function useSystemMachineProviders(
  query: SystemMachineProvidersQuery = {},
): { providers: readonly SystemMachineProvider[] | undefined } {
  const result = useQuery({
    queryKey: systemMachineProvidersQueryKey(query),
    queryFn: () => sdk.hosts.listProviders(query),
    ...SERVER_SESSION_QUERY_POLICY,
  });
  return {
    providers: result.isError ? NO_MACHINE_PROVIDERS : result.data,
  };
}
