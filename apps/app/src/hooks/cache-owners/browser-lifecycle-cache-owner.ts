import type { Query, QueryClient } from "@tanstack/react-query";

interface BrowserLifecycleFetchController {
  suspend: () => void;
  resume: () => void;
}

export function createBrowserLifecycleFetchController(
  queryClient: QueryClient,
): BrowserLifecycleFetchController {
  let cancelledOnSuspend = new Set<Query>();
  return {
    suspend: () => {
      for (const query of queryClient
        .getQueryCache()
        .findAll({ fetchStatus: "fetching", type: "active" })) {
        cancelledOnSuspend.add(query);
      }
      void queryClient.cancelQueries({
        fetchStatus: "fetching",
        type: "active",
      });
    },
    resume: () => {
      if (cancelledOnSuspend.size === 0) {
        return;
      }
      const cancelled = cancelledOnSuspend;
      cancelledOnSuspend = new Set<Query>();
      void queryClient.refetchQueries(
        {
          predicate: (query) => cancelled.has(query),
          type: "active",
        },
        { cancelRefetch: false },
      );
    },
  };
}
