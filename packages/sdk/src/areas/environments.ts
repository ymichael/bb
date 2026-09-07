import { environmentSchema, type Environment } from "@bb/domain";
import {
  commitActionResponseSchema,
  pullRequestDraftActionResponseSchema,
  pullRequestMergeActionResponseSchema,
  pullRequestReadyActionResponseSchema,
  updateEnvironmentRequestSchema,
} from "@bb/server-contract";
import type {
  CommitActionResponse,
  EnvironmentArchiveThreadsResponse,
  EnvironmentDiffBranchesQuery,
  EnvironmentDiffBranchesResponse,
  EnvironmentDiffFileQuery,
  EnvironmentDiffFileResponse,
  EnvironmentDiffPatchRequest,
  EnvironmentDiffPatchResponse,
  EnvironmentDiffQuery,
  EnvironmentDiffResponse,
  EnvironmentDiffFilesResponse,
  EnvironmentPathsQuery,
  EnvironmentPullRequestResponse,
  EnvironmentStatusResponse,
  PullRequestMergeMethod,
  PullRequestDraftActionResponse,
  PullRequestMergeActionResponse,
  PullRequestReadyActionResponse,
  EnvironmentStatusQuery,
  UpdateEnvironmentRequest,
  WorkspacePathListResponse,
} from "@bb/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export interface EnvironmentActionArgs {
  environmentId: string;
}

export interface EnvironmentGetArgs extends EnvironmentActionArgs {
  signal?: AbortSignal;
}

type EnvironmentMergeBaseBranchUpdateValue = Exclude<
  UpdateEnvironmentRequest["mergeBaseBranch"],
  undefined
>;

type EnvironmentNameUpdateValue = Exclude<
  UpdateEnvironmentRequest["name"],
  undefined
>;

interface EnvironmentMergeBaseBranchUpdate {
  mergeBaseBranch: EnvironmentMergeBaseBranchUpdateValue;
  name?: EnvironmentNameUpdateValue;
}

interface EnvironmentNameUpdate {
  mergeBaseBranch?: EnvironmentMergeBaseBranchUpdateValue;
  name: EnvironmentNameUpdateValue;
}

type EnvironmentUpdateFields =
  | EnvironmentMergeBaseBranchUpdate
  | EnvironmentNameUpdate;

export type EnvironmentUpdateArgs = EnvironmentUpdateFields & {
  environmentId: string;
};

export interface EnvironmentStatusArgs extends EnvironmentStatusQuery {
  environmentId: string;
  signal?: AbortSignal;
}

export type EnvironmentDiffArgs = EnvironmentDiffQuery & {
  environmentId: string;
  signal?: AbortSignal;
};

export type EnvironmentDiffFileArgs = EnvironmentDiffFileQuery & {
  environmentId: string;
  signal?: AbortSignal;
};

export interface EnvironmentDiffBranchesArgs extends EnvironmentDiffBranchesQuery {
  environmentId: string;
  signal?: AbortSignal;
}

export interface EnvironmentCommitArgs {
  environmentId: string;
}

export interface EnvironmentPullRequestMergeArgs {
  environmentId: string;
  method: PullRequestMergeMethod;
}

export type EnvironmentDiffPatchArgs = EnvironmentDiffPatchRequest & {
  environmentId: string;
  signal?: AbortSignal;
};

export interface EnvironmentPathsArgs extends EnvironmentPathsQuery {
  environmentId: string;
  signal?: AbortSignal;
}

export type EnvironmentArchiveThreadsResult = EnvironmentArchiveThreadsResponse;
export type EnvironmentCommitResult = CommitActionResponse;
export type EnvironmentDiffResult = EnvironmentDiffResponse;
export type EnvironmentDiffBranchesResult = EnvironmentDiffBranchesResponse;
export type EnvironmentDiffFileResult = EnvironmentDiffFileResponse;
export type EnvironmentDiffFilesResult = EnvironmentDiffFilesResponse;
export type EnvironmentDiffPatchResult = EnvironmentDiffPatchResponse;
export type EnvironmentGetResult = Environment;
export type EnvironmentMarkPullRequestDraftResult =
  PullRequestDraftActionResponse;
export type EnvironmentMarkPullRequestReadyResult =
  PullRequestReadyActionResponse;
export type EnvironmentMergePullRequestResult = PullRequestMergeActionResponse;
export type EnvironmentPathsResult = WorkspacePathListResponse;
export type EnvironmentPullRequestResult = EnvironmentPullRequestResponse;
export type EnvironmentStatusResult = EnvironmentStatusResponse;
export type EnvironmentUpdateResult = Environment;

export interface EnvironmentsArea {
  archiveThreads(
    args: EnvironmentActionArgs,
  ): Promise<EnvironmentArchiveThreadsResult>;
  commit(args: EnvironmentCommitArgs): Promise<EnvironmentCommitResult>;
  diff(args: EnvironmentDiffArgs): Promise<EnvironmentDiffResult>;
  diffBranches(
    args: EnvironmentDiffBranchesArgs,
  ): Promise<EnvironmentDiffBranchesResult>;
  diffFile(args: EnvironmentDiffFileArgs): Promise<EnvironmentDiffFileResult>;
  diffFiles(args: EnvironmentDiffArgs): Promise<EnvironmentDiffFilesResult>;
  diffPatch(
    args: EnvironmentDiffPatchArgs,
  ): Promise<EnvironmentDiffPatchResult>;
  get(args: EnvironmentGetArgs): Promise<EnvironmentGetResult>;
  pullRequest(args: EnvironmentGetArgs): Promise<EnvironmentPullRequestResult>;
  markPullRequestDraft(
    args: EnvironmentActionArgs,
  ): Promise<EnvironmentMarkPullRequestDraftResult>;
  markPullRequestReady(
    args: EnvironmentActionArgs,
  ): Promise<EnvironmentMarkPullRequestReadyResult>;
  mergePullRequest(
    args: EnvironmentPullRequestMergeArgs,
  ): Promise<EnvironmentMergePullRequestResult>;
  paths(args: EnvironmentPathsArgs): Promise<EnvironmentPathsResult>;
  status(args: EnvironmentStatusArgs): Promise<EnvironmentStatusResult>;
  update(args: EnvironmentUpdateArgs): Promise<EnvironmentUpdateResult>;
}

function environmentUpdateJson(
  args: EnvironmentUpdateArgs,
): UpdateEnvironmentRequest {
  const request: UpdateEnvironmentRequest = {};
  if (args.mergeBaseBranch !== undefined) {
    request.mergeBaseBranch = args.mergeBaseBranch;
  }
  if (args.name !== undefined) {
    request.name = args.name;
  }
  return updateEnvironmentRequestSchema.parse(request);
}

function environmentStatusQuery(
  args: EnvironmentStatusArgs,
): EnvironmentStatusQuery {
  return {
    mergeBaseBranch: args.mergeBaseBranch,
  };
}

function environmentDiffQuery(args: EnvironmentDiffArgs): EnvironmentDiffQuery {
  switch (args.target) {
    case "uncommitted":
      return { target: args.target };
    case "branch_committed":
    case "all":
      return { target: args.target, mergeBaseBranch: args.mergeBaseBranch };
    case "commit":
      return { target: args.target, sha: args.sha };
  }
}

function environmentDiffFileQuery(
  args: EnvironmentDiffFileArgs,
): EnvironmentDiffFileQuery {
  switch (args.target) {
    case "uncommitted":
      return {
        path: args.path,
        side: args.side,
        target: args.target,
      };
    case "branch_committed":
    case "all":
      return {
        mergeBaseRef: args.mergeBaseRef,
        path: args.path,
        side: args.side,
        target: args.target,
      };
    case "commit":
      return {
        path: args.path,
        sha: args.sha,
        side: args.side,
        target: args.target,
      };
  }
}

function environmentDiffBranchesQuery(
  args: EnvironmentDiffBranchesArgs,
): EnvironmentDiffBranchesQuery {
  return {
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
    ...(args.selectedBranch !== undefined
      ? { selectedBranch: args.selectedBranch }
      : {}),
  };
}

function environmentPathsQuery(
  args: EnvironmentPathsArgs,
): EnvironmentPathsQuery {
  return {
    includeDirectories: args.includeDirectories,
    includeFiles: args.includeFiles,
    limit: args.limit,
    query: args.query,
  };
}

export function createEnvironmentsArea(
  args: CreateSdkAreaArgs,
): EnvironmentsArea {
  const { transport } = args;
  return {
    async archiveThreads(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"]["archive-threads"].$post({
          param: { id: input.environmentId },
        }),
      );
    },
    async commit(input) {
      const body = await transport.readJson(
        transport.api.v1.environments[":id"].actions.$post({
          param: { id: input.environmentId },
          json: {
            action: "commit",
          },
        }),
      );
      return commitActionResponseSchema.parse(body);
    },
    async diff(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].diff.$get(
          {
            param: { id: input.environmentId },
            query: environmentDiffQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async diffBranches(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].diff.branches.$get(
          {
            param: { id: input.environmentId },
            query: environmentDiffBranchesQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async diffFile(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].diff.file.$get(
          {
            param: { id: input.environmentId },
            query: environmentDiffFileQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async diffFiles(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].diff.files.$get(
          {
            param: { id: input.environmentId },
            query: environmentDiffQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async diffPatch(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].diff.patch.$post(
          {
            param: { id: input.environmentId },
            json: {
              paths: input.paths,
              target: input.target,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async get(input) {
      const body = await transport.readJson(
        transport.api.v1.environments[":id"].$get(
          {
            param: { id: input.environmentId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
      return environmentSchema.parse(body);
    },
    async pullRequest(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"]["pull-request"].$get(
          {
            param: { id: input.environmentId },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async markPullRequestDraft(input) {
      const body = await transport.readJson(
        transport.api.v1.environments[":id"].actions.$post({
          param: { id: input.environmentId },
          json: { action: "pull_request_draft" },
        }),
      );
      return pullRequestDraftActionResponseSchema.parse(body);
    },
    async markPullRequestReady(input) {
      const body = await transport.readJson(
        transport.api.v1.environments[":id"].actions.$post({
          param: { id: input.environmentId },
          json: { action: "pull_request_ready" },
        }),
      );
      return pullRequestReadyActionResponseSchema.parse(body);
    },
    async mergePullRequest(input) {
      const body = await transport.readJson(
        transport.api.v1.environments[":id"].actions.$post({
          param: { id: input.environmentId },
          json: {
            action: "pull_request_merge",
            options: { method: input.method },
          },
        }),
      );
      return pullRequestMergeActionResponseSchema.parse(body);
    },
    async paths(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].paths.$get(
          {
            param: { id: input.environmentId },
            query: environmentPathsQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async status(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].status.$get(
          {
            param: { id: input.environmentId },
            query: environmentStatusQuery(input),
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async update(input) {
      return transport.readJson(
        transport.api.v1.environments[":id"].$patch({
          param: { id: input.environmentId },
          json: environmentUpdateJson(input),
        }),
      );
    },
  };
}
