import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Environment } from "@bb/domain";
import type {
  EnvironmentActionResponse,
  UpdateEnvironmentRequest,
} from "@bb/server-contract";
import * as api from "@/lib/api";
import type { RequestEnvironmentActionMutationRequest } from "./mutation-request-types";
import {
  getEnvironmentActionInvalidationQueryKeys,
  getEnvironmentWorkspaceStateInvalidationQueryKeys,
} from "../queries/query-cache";
import {
  environmentQueryKey,
} from "../queries/query-keys";
type UpdateEnvironmentMutationRequest = { id: string } & UpdateEnvironmentRequest;

export function useRequestEnvironmentAction() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to run environment action.",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      ...request
    }: RequestEnvironmentActionMutationRequest): Promise<EnvironmentActionResponse> =>
      api.requestEnvironmentAction(id, request),
    onSuccess: (_response, variables) => {
      for (const queryKey of getEnvironmentActionInvalidationQueryKeys({
        environmentId: variables.id,
      })) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}

export function useUpdateEnvironment() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update environment.",
      showErrorToast: false,
    },
    mutationFn: ({ id, ...request }: UpdateEnvironmentMutationRequest) =>
      api.updateEnvironment(id, request),
    onSuccess: (environment: Environment) => {
      queryClient.setQueryData<Environment>(
        environmentQueryKey(environment.id),
        environment,
      );
      for (const queryKey of getEnvironmentWorkspaceStateInvalidationQueryKeys({
        environmentId: environment.id,
      })) {
        queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
