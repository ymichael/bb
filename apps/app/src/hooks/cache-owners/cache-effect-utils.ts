import type { QueryKeysArg } from "../cache-effect-types";

export function invalidateQueryKeys({
  queryClient,
  queryKeys,
}: QueryKeysArg): void {
  for (const queryKey of queryKeys) {
    queryClient.invalidateQueries({ queryKey });
  }
}

export function refetchFailedActiveQueryKeys({
  queryClient,
  queryKeys,
}: QueryKeysArg): void {
  for (const queryKey of queryKeys) {
    void queryClient
      .refetchQueries({
        queryKey,
        type: "active",
        predicate: (query) =>
          query.state.status === "error" && query.state.fetchStatus === "idle",
      })
      .catch(() => {});
  }
}
