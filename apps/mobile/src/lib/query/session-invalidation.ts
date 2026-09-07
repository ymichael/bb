import type { QueryClient } from "@tanstack/react-query";

export function refetchQueriesRejectedBeforeSession(
  queryClient: QueryClient,
): void {
  void queryClient.invalidateQueries(
    {
      predicate: (query) =>
        query.state.status === "error" || query.state.dataUpdatedAt === 0,
    },
    { cancelRefetch: true },
  );
}
