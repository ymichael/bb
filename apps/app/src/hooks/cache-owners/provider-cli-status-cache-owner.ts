import type { QueryClient } from "@tanstack/react-query";
import { hostProviderCliStatusQueryKey } from "../queries/query-keys";

interface InvalidateHostProviderCliStatusArgs {
  queryClient: QueryClient;
  hostId: string;
}

export function invalidateHostProviderCliStatus(
  args: InvalidateHostProviderCliStatusArgs,
): Promise<void> {
  return args.queryClient.invalidateQueries({
    queryKey: hostProviderCliStatusQueryKey(args.hostId),
  });
}
