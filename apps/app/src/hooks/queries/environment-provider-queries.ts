import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type {
  SystemEnvironmentProvider,
  SystemEnvironmentProvidersQuery,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { SERVER_SESSION_QUERY_POLICY } from "./query-policies";

const SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY = "systemEnvironmentProviders";

export function systemEnvironmentProvidersQueryKey(): readonly [
  typeof SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY,
];
export function systemEnvironmentProvidersQueryKey(
  query: SystemEnvironmentProvidersQuery,
): readonly [
  typeof SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY,
  string | null,
  string | null,
];
export function systemEnvironmentProvidersQueryKey(
  query?: SystemEnvironmentProvidersQuery,
):
  | readonly [typeof SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY]
  | readonly [
      typeof SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY,
      string | null,
      string | null,
    ] {
  if (query === undefined) return [SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY];
  return [
    SYSTEM_ENVIRONMENT_PROVIDERS_QUERY_KEY,
    query.projectId ?? null,
    query.hostId ?? null,
  ];
}

const NO_ENVIRONMENT_PROVIDERS: readonly SystemEnvironmentProvider[] = [];

function environmentProvidersQueryOptions(
  query: SystemEnvironmentProvidersQuery,
) {
  return {
    queryKey: systemEnvironmentProvidersQueryKey(query),
    queryFn: () => sdk.environments.listProviders(query),
    ...SERVER_SESSION_QUERY_POLICY,
  };
}

export function useSystemEnvironmentProviders(
  query: SystemEnvironmentProvidersQuery = {},
): {
  providers: readonly SystemEnvironmentProvider[] | undefined;
} {
  const result = useQuery(environmentProvidersQueryOptions(query));
  return {
    providers: result.isError ? NO_ENVIRONMENT_PROVIDERS : result.data,
  };
}

export function useSystemEnvironmentProvidersByHost(
  projectId: string,
  hostIds: readonly string[],
): ReadonlyMap<string, readonly SystemEnvironmentProvider[] | undefined> {
  const results = useQueries({
    queries: hostIds.map((hostId) =>
      environmentProvidersQueryOptions({ projectId, hostId }),
    ),
  });
  return useMemo(
    () =>
      new Map(
        hostIds.map((hostId, index) => {
          const result = results[index];
          return [
            hostId,
            result?.isError ? NO_ENVIRONMENT_PROVIDERS : result?.data,
          ] as const;
        }),
      ),
    [hostIds, results],
  );
}
