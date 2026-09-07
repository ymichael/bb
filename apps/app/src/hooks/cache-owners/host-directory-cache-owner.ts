import type { QueryClient } from "@tanstack/react-query";
import { hostDirectoryQueryKey } from "../queries/query-keys";

interface InvalidateHostDirectoryListingArgs {
  queryClient: QueryClient;
  hostId: string;
  directory: string;
}

export function invalidateHostDirectoryListing({
  queryClient,
  hostId,
  directory,
}: InvalidateHostDirectoryListingArgs): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: hostDirectoryQueryKey(hostId, directory),
    refetchType: "none",
  });
}
