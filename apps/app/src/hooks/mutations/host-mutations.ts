import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Host, PermissionMode } from "@bb/domain";
import { apiClient } from "@/lib/api-server";
import { request } from "@/lib/api";
import { sdk } from "@/lib/sdk";
import { invalidateHostListQueries } from "../cache-owners/mutation-cache-effects";

interface RenameHostRequest {
  hostId: string;
  name: string;
}

export function useRenameHost() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      showErrorToast: false,
    },
    mutationFn: ({ hostId, name }: RenameHostRequest) =>
      sdk.hosts.update({ hostId, name }),
    onSuccess: () => {
      invalidateHostListQueries({ queryClient });
    },
  });
}

export function useRemoveHost() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      showErrorToast: false,
    },
    mutationFn: async (hostId: string) => {
      await sdk.hosts.delete({ hostId });
    },
    onSuccess: () => {
      invalidateHostListQueries({ queryClient });
    },
  });
}

interface UpdateHostPermissionCeilingRequest {
  hostId: string;
  maxPermissionMode: PermissionMode;
}

export function useUpdateHostPermissionCeiling() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      showErrorToast: false,
    },
    mutationFn: ({
      hostId,
      maxPermissionMode,
    }: UpdateHostPermissionCeilingRequest) =>
      request<Host>(
        apiClient.hosts[":id"]["permission-ceiling"].$patch({
          param: { id: hostId },
          json: { maxPermissionMode },
        }),
      ),
    onSuccess: () => {
      invalidateHostListQueries({ queryClient });
    },
  });
}

export function useRetryHostUpdate() {
  return useMutation({
    mutationFn: (hostId: string) => sdk.hosts.retryUpdate({ hostId }),
  });
}
