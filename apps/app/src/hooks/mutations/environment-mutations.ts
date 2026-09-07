import {
  rollbackArchiveThreadsTransaction,
  settleArchiveThreadsTransaction,
  type ArchiveThreadsTransaction,
} from "../cache-owners/thread-state-cache-owner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Environment } from "@bb/domain";
import type {
  EnvironmentArchiveThreadsResponse,
  EnvironmentActionResponse,
  UpdateEnvironmentRequest,
} from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import type { RequestEnvironmentActionMutationRequest } from "./mutation-request-types";
import { invalidateEnvironmentActionQueries } from "../cache-owners/environment-cache-effects";
import { applyEnvironmentUpdateResult } from "../cache-owners/environment-workspace-cache-owner";
import { beginArchiveEnvironmentThreadsTransaction } from "../cache-owners/thread-list-cache-owner";
type UpdateEnvironmentMutationRequest = {
  id: string;
} & UpdateEnvironmentRequest;

interface ArchiveEnvironmentThreadsMutationRequest {
  id: string;
}

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
    }: RequestEnvironmentActionMutationRequest): Promise<EnvironmentActionResponse> => {
      switch (request.action) {
        case "commit":
          return sdk.environments.commit({ environmentId: id });
        case "pull_request_ready":
          return sdk.environments.markPullRequestReady({ environmentId: id });
        case "pull_request_merge":
          return sdk.environments.mergePullRequest({
            environmentId: id,
            method: request.options.method,
          });
        case "pull_request_draft":
          return sdk.environments.markPullRequestDraft({ environmentId: id });
      }
    },
    onSuccess: (_response, variables) => {
      invalidateEnvironmentActionQueries({
        environmentId: variables.id,
        queryClient,
      });
    },
  });
}

export function useArchiveEnvironmentThreads() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to archive threads.",
    },
    mutationFn: ({
      id,
    }: ArchiveEnvironmentThreadsMutationRequest): Promise<EnvironmentArchiveThreadsResponse> =>
      sdk.environments.archiveThreads({ environmentId: id }),
    onMutate: async ({ id }): Promise<ArchiveThreadsTransaction> =>
      beginArchiveEnvironmentThreadsTransaction({
        environmentId: id,
        queryClient,
      }),
    onError: (_error, _variables, context) => {
      rollbackArchiveThreadsTransaction({
        queryClient,
        transaction: context,
      });
    },
    onSettled: (data, _error, variables, context) => {
      invalidateEnvironmentActionQueries({
        environmentId: variables.id,
        queryClient,
      });
      settleArchiveThreadsTransaction({
        queryClient,
        response: data,
        transaction: context,
      });
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
    mutationFn: ({ id, ...request }: UpdateEnvironmentMutationRequest) => {
      if (request.name !== undefined) {
        return sdk.environments.update({
          environmentId: id,
          name: request.name,
          ...(request.mergeBaseBranch !== undefined
            ? { mergeBaseBranch: request.mergeBaseBranch }
            : {}),
        });
      }
      if (request.mergeBaseBranch !== undefined) {
        return sdk.environments.update({
          environmentId: id,
          mergeBaseBranch: request.mergeBaseBranch,
        });
      }
      throw new Error("Environment update requires at least one field");
    },
    onSuccess: (environment: Environment) => {
      applyEnvironmentUpdateResult({ environment, queryClient });
    },
  });
}
