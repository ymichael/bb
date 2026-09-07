import path from "node:path";
import { updateEnvironmentMetadata } from "@bb/db";
import {
  resolveEnvironmentWorkspaceDisplayKind,
  type Environment,
  type ThreadPullRequest,
} from "@bb/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type DiffPatchEntry,
  type EnvironmentDiffFileQuery,
  type EnvironmentDiffQuery,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import {
  COMMAND_TIMEOUT_MS,
  DIFF_FILE_PATCH_MAX_BYTES,
  WORKSPACE_DIFF_MAX_FILES,
  WORKSPACE_DIFF_MAX_DIFF_BYTES,
  WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
} from "../constants.js";
import { ApiError } from "../errors.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
} from "../services/lib/entity-lookup.js";
import { runLiveCommandAndWait } from "../services/hosts/live-command-wait.js";
import { callHostRetryableOnlineRpc } from "../services/hosts/online-rpc.js";
import { generateCommitMessage } from "../services/ai/commit-message.js";
import { archiveEnvironmentThreads } from "../services/threads/thread-archive.js";
import {
  normalizeBranchQuery,
  parseBranchListLimit,
} from "./branch-list-query.js";
import { parseFileListLimit } from "./file-list-query.js";
import { parsePathKindInclusion } from "./path-list-inclusion.js";
import {
  requireWorkspaceCommandTarget,
  type WorkspaceCommandTarget,
} from "../services/environments/workspace-command-target.js";
import { callEnvironmentWorkspaceStatus } from "../services/environments/workspace-status.js";
import { assembleThreadPullRequest } from "../services/environments/pull-request.js";
import {
  requireAvailableWorkspaceDiff,
  requireAvailableWorkspaceStatus,
} from "../services/environments/workspace-rpc-results.js";
import {
  rawDiffFileStatToEntry,
  selectInitialPatchPaths,
} from "./diff-tiering.js";

const COMMIT_FALLBACK_MESSAGE = "bb: automated commit";

const AI_MAX_DIFF_BYTES = 32_000;
const AI_MAX_FILE_LIST_BYTES = 4_000;

async function mapNoChangesTo409<TResult>(
  conflictMessage: string,
  run: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApiError && error.body.code === "no_changes") {
      throw new ApiError(409, "no_changes", conflictMessage);
    }
    throw error;
  }
}

async function mapPullRequestActionFailureTo409<TResult>(
  run: () => Promise<TResult>,
): Promise<TResult> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.body.code === "git_host_command_failed" ||
        error.body.code === "git_host_cli_unavailable" ||
        error.body.code === "invalid_request")
    ) {
      throw new ApiError(409, "pull_request_action_failed", error.body.message);
    }
    throw error;
  }
}

function toWorkspaceDiffTarget(query: EnvironmentDiffQuery) {
  switch (query.target) {
    case "uncommitted":
      return { type: "uncommitted" as const };
    case "branch_committed":
      return {
        type: "branch_committed" as const,
        mergeBaseBranch: query.mergeBaseBranch,
      };
    case "all":
      return {
        type: "all" as const,
        mergeBaseBranch: query.mergeBaseBranch,
      };
    case "commit":
      return {
        type: "commit" as const,
        sha: query.sha,
      };
    default: {
      const _exhaustive: never = query;
      return _exhaustive;
    }
  }
}

function workspaceReadCacheKey(target: WorkspaceCommandTarget): string {
  return JSON.stringify(target.workspaceContext);
}

function workspaceStatusCacheKey(
  target: WorkspaceCommandTarget,
  mergeBaseBranch: string | undefined,
): string {
  return `${workspaceReadCacheKey(target)} ${mergeBaseBranch ?? ""}`;
}

function isWorktreeEnvironment(environment: Environment): boolean {
  return resolveEnvironmentWorkspaceDisplayKind({ environment }) !== "other";
}

async function getPullRequestForWorkspaceTarget(
  deps: AppDeps,
  target: ReturnType<typeof requireWorkspaceCommandTarget>,
): Promise<ThreadPullRequest | null> {
  const result = await callHostRetryableOnlineRpc(deps, {
    hostId: target.hostId,
    timeoutMs: COMMAND_TIMEOUT_MS,
    command: {
      type: "workspace.pull_request",
      environmentId: target.environmentId,
      workspaceContext: target.workspaceContext,
    },
  });
  return result.outcome === "available"
    ? assembleThreadPullRequest(result.pullRequest)
    : null;
}

function assertCanMarkPullRequestReady(
  pullRequest: ThreadPullRequest | null,
): void {
  if (!pullRequest) {
    throw new ApiError(
      409,
      "pull_request_unavailable",
      "No pull request found",
    );
  }
  if (pullRequest.state !== "draft") {
    throw new ApiError(409, "invalid_request", "Pull request is not a draft");
  }
}

function assertCanConvertPullRequestToDraft(
  pullRequest: ThreadPullRequest | null,
): void {
  if (!pullRequest) {
    throw new ApiError(
      409,
      "pull_request_unavailable",
      "No pull request found",
    );
  }
  if (pullRequest.state !== "open") {
    throw new ApiError(409, "invalid_request", "Pull request is not open");
  }
}

function assertCanMergePullRequest(
  pullRequest: ThreadPullRequest | null,
): void {
  if (!pullRequest) {
    throw new ApiError(
      409,
      "pull_request_unavailable",
      "No pull request found",
    );
  }
  if (
    pullRequest.state !== "open" ||
    pullRequest.mergeability.state !== "mergeable"
  ) {
    throw new ApiError(
      409,
      "pull_request_not_mergeable",
      "Pull request is not currently mergeable",
    );
  }
}

function resolveDiffFileRef(
  query: EnvironmentDiffFileQuery,
): string | undefined {
  switch (query.target) {
    case "uncommitted":
      return query.side === "old" ? "HEAD" : undefined;
    case "branch_committed":
      return query.side === "old" ? query.mergeBaseRef : "HEAD";
    case "all":
      return query.side === "old" ? query.mergeBaseRef : undefined;
    case "commit":
      return query.side === "old" ? `${query.sha}^` : query.sha;
    default: {
      const _exhaustive: never = query;
      return _exhaustive;
    }
  }
}

const NON_GIT_DIFF_NOT_APPLICABLE = {
  outcome: "not_applicable",
  reason: "non_git_environment",
  message: "Workspace diff is not available for non-git environments",
} as const;

function resolveGitDiffWorkspaceTarget(deps: AppDeps, environmentId: string) {
  const environment = requireReadyEnvironment(deps.db, environmentId);
  if (!environment.isGitRepo) {
    return null;
  }
  return requireWorkspaceCommandTarget(environment);
}

export function registerEnvironmentRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.environments;

  get(routes.get, (context) =>
    context.json(requireEnvironment(deps.db, context.req.param("id"))),
  );

  patch(routes.update, (context, payload) => {
    const environment = requireEnvironment(deps.db, context.req.param("id"));
    const updated = updateEnvironmentMetadata(
      deps.db,
      deps.hub,
      environment.id,
      payload,
    );
    if (!updated) {
      throw new ApiError(404, "environment_not_found", "Environment not found");
    }
    return context.json(updated);
  });

  post(routes.archiveThreads, (context) => {
    const environment = requireEnvironment(deps.db, context.req.param("id"));
    if (!isWorktreeEnvironment(environment)) {
      throw new ApiError(
        409,
        "invalid_request",
        "Only worktree environments can be archived as a group",
      );
    }

    const archivedThreadIds = archiveEnvironmentThreads(deps, { environment });
    return context.json({
      ok: true,
      archivedThreadIds,
    });
  });

  get(routes.status, async (context, query) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    if (!environment.isGitRepo) {
      return context.json({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace status is not available for non-git environments",
      });
    }
    const target = requireWorkspaceCommandTarget(environment);
    const result = await deps.workspaceReadCaches.status.read({
      environmentId: environment.id,
      hostId: target.hostId,
      key: workspaceStatusCacheKey(target, query.mergeBaseBranch),
      load: () =>
        callEnvironmentWorkspaceStatus(deps, {
          environment,
          target,
          ...(query.mergeBaseBranch
            ? { mergeBaseBranch: query.mergeBaseBranch }
            : {}),
        }),
    });
    if (result.outcome === "unavailable") {
      return context.json({
        outcome: "unavailable",
        failure: result.failure,
      });
    }
    return context.json({
      outcome: "available",
      workspace: result.workspaceStatus,
    });
  });

  get(routes.pullRequest, async (context) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    if (!environment.isGitRepo) {
      return context.json({ outcome: "absent" });
    }
    const target = requireWorkspaceCommandTarget(environment);
    const result = await deps.workspaceReadCaches.pullRequest.read({
      environmentId: environment.id,
      hostId: target.hostId,
      key: workspaceReadCacheKey(target),
      load: () =>
        callHostRetryableOnlineRpc(deps, {
          hostId: target.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.pull_request",
            environmentId: target.environmentId,
            workspaceContext: target.workspaceContext,
          },
        }),
    });
    if (result.outcome === "available") {
      return context.json({
        outcome: "available",
        pullRequest: assembleThreadPullRequest(result.pullRequest),
      });
    }
    if (result.outcome === "unavailable") {
      return context.json({ outcome: "unavailable", message: result.message });
    }
    return context.json({ outcome: "absent" });
  });

  get(routes.diff, async (context, query) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    if (!environment.isGitRepo) {
      return context.json({
        outcome: "not_applicable",
        reason: "non_git_environment",
        message: "Workspace diff is not available for non-git environments",
      });
    }
    const target = requireWorkspaceCommandTarget(environment);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.diff",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        target: toWorkspaceDiffTarget(query),
        maxDiffBytes: WORKSPACE_DIFF_MAX_DIFF_BYTES,
        maxFileListBytes: WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
        maxUntrackedFiles: WORKSPACE_DIFF_MAX_FILES,
      },
    });
    if (result.outcome === "unavailable") {
      return context.json({
        outcome: "unavailable",
        failure: result.failure,
      });
    }
    return context.json({
      outcome: "available",
      diff: result.diff,
    });
  });

  get(routes.diffFiles, async (context, query) => {
    const target = resolveGitDiffWorkspaceTarget(deps, context.req.param("id"));
    if (target === null) {
      return context.json(NON_GIT_DIFF_NOT_APPLICABLE);
    }
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.diffFiles",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        target: toWorkspaceDiffTarget(query),
        maxFiles: WORKSPACE_DIFF_MAX_FILES,
      },
    });
    if (result.outcome === "unavailable") {
      return context.json({
        outcome: "unavailable",
        failure: result.failure,
      });
    }
    const files = result.files.map(rawDiffFileStatToEntry);
    const initialPatchPaths = selectInitialPatchPaths(files);
    let initialPatches: DiffPatchEntry[] = [];
    if (initialPatchPaths.length > 0) {
      const patchResult = await callHostRetryableOnlineRpc(deps, {
        hostId: target.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "workspace.diffPatch",
          environmentId: target.environmentId,
          workspaceContext: target.workspaceContext,
          target: toWorkspaceDiffTarget(query),
          paths: initialPatchPaths,
          maxBytesPerFile: DIFF_FILE_PATCH_MAX_BYTES,
        },
      });
      if (patchResult.outcome === "available") {
        initialPatches = patchResult.patches;
      }
    }
    return context.json({
      outcome: "available",
      files,
      shortstat: result.shortstat,
      mergeBaseRef: result.mergeBaseRef,
      initialPatches,
      truncated: result.truncated,
    });
  });

  post(routes.diffPatch, async (context, payload) => {
    const target = resolveGitDiffWorkspaceTarget(deps, context.req.param("id"));
    if (target === null) {
      return context.json(NON_GIT_DIFF_NOT_APPLICABLE);
    }
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.diffPatch",
        environmentId: target.environmentId,
        workspaceContext: target.workspaceContext,
        target: payload.target,
        paths: payload.paths,
        maxBytesPerFile: DIFF_FILE_PATCH_MAX_BYTES,
      },
    });
    if (result.outcome === "unavailable") {
      return context.json({
        outcome: "unavailable",
        failure: result.failure,
      });
    }
    return context.json({
      outcome: "available",
      patches: result.patches,
    });
  });

  get(routes.diffFile, async (context, query) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    const repoRelativePath = query.path.replace(/^\/+/u, "");
    if (
      repoRelativePath.length === 0 ||
      repoRelativePath.split("/").includes("..")
    ) {
      throw new ApiError(400, "invalid_request", "Invalid path");
    }
    const absolutePath = path.join(environment.path, repoRelativePath);
    const ref = resolveDiffFileRef(query);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file",
        path: absolutePath,
        rootPath: environment.path,
        ...(ref !== undefined ? { ref } : {}),
      },
    });
    return context.json({
      path: result.path,
      content: result.content,
      contentEncoding: result.contentEncoding,
      ...(result.mimeType ? { mimeType: result.mimeType } : {}),
      sizeBytes: result.sizeBytes,
    });
  });

  get(routes.diffBranches, async (context, query) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    const branchQuery = normalizeBranchQuery(query.query);
    const selectedBranch = normalizeBranchQuery(query.selectedBranch);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_branch_options",
        path: environment.path,
        ...(branchQuery ? { query: branchQuery } : {}),
        ...(selectedBranch ? { selectedBranch } : {}),
        limit: parseBranchListLimit(query.limit),
        remoteRefresh: "background",
      },
    });
    return context.json({
      branches: result.branches,
      branchesTruncated: result.branchesTruncated,
      remoteBranches: result.remoteBranches,
      remoteBranchesTruncated: result.remoteBranchesTruncated,
      selectedBranch: result.selectedBranch,
    });
  });

  get(routes.paths, async (context, query) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    const limit = parseFileListLimit(query.limit);
    const inclusion = parsePathKindInclusion({
      includeFiles: query.includeFiles,
      includeDirectories: query.includeDirectories,
    });

    try {
      const result = await callHostRetryableOnlineRpc(deps, {
        hostId: environment.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "host.list_paths",
          path: environment.path,
          ...(query.query ? { query: query.query } : {}),
          limit,
          includeFiles: inclusion.includeFiles,
          includeDirectories: inclusion.includeDirectories,
        },
      });
      return context.json({
        paths: result.paths,
        truncated: result.truncated,
      });
    } catch (error) {
      if (error instanceof ApiError && error.body.code === "ENOENT") {
        return context.json({ paths: [], truncated: false });
      }
      throw error;
    }
  });

  post(routes.actions, async (context, payload) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );

    try {
      switch (payload.action) {
        case "commit": {
          const target = requireWorkspaceCommandTarget(environment);
          const { workspaceContext } = target;

          const [statusResult, diffResult] = await Promise.all([
            callEnvironmentWorkspaceStatus(deps, {
              environment,
              target,
            }),
            callHostRetryableOnlineRpc(deps, {
              hostId: target.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.diff",
                environmentId: target.environmentId,
                workspaceContext,
                target: { type: "uncommitted" },
                maxDiffBytes: AI_MAX_DIFF_BYTES,
                maxFileListBytes: AI_MAX_FILE_LIST_BYTES,
                maxUntrackedFiles: WORKSPACE_DIFF_MAX_FILES,
              },
            }),
          ]);
          const workspaceStatus = requireAvailableWorkspaceStatus(statusResult);
          const workspaceDiff = requireAvailableWorkspaceDiff(diffResult);
          if (!workspaceStatus.workingTree.hasUncommittedChanges) {
            throw new ApiError(
              409,
              "no_changes",
              "No uncommitted changes to commit",
            );
          }

          const aiMessage = await generateCommitMessage(deps, {
            diffDescription: "uncommitted changes",
            shortstat: workspaceDiff.shortstat,
            files: workspaceDiff.files,
            patch: workspaceDiff.diff,
          });
          const commitMessage = aiMessage ?? COMMIT_FALLBACK_MESSAGE;

          const result = await mapNoChangesTo409(
            "No uncommitted changes to commit",
            () =>
              runLiveCommandAndWait(deps, {
                hostId: target.hostId,
                timeoutMs: COMMAND_TIMEOUT_MS,
                command: {
                  type: "workspace.commit",
                  environmentId: target.environmentId,
                  workspaceContext,
                  message: commitMessage,
                },
              }),
          );
          return context.json({
            ok: true,
            action: "commit",
            message: `Created commit ${result.commitSha}`,
            commitSha: result.commitSha,
            commitSubject: result.commitSubject,
          });
        }
        case "pull_request_ready": {
          if (!environment.isGitRepo) {
            throw new ApiError(
              409,
              "invalid_request",
              "Pull request actions require a git environment",
            );
          }
          const target = requireWorkspaceCommandTarget(environment);
          const pullRequest = await getPullRequestForWorkspaceTarget(
            deps,
            target,
          );
          assertCanMarkPullRequestReady(pullRequest);

          await mapPullRequestActionFailureTo409(() =>
            runLiveCommandAndWait(deps, {
              hostId: target.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.pull_request_action",
                operation: "ready",
                environmentId: target.environmentId,
                workspaceContext: target.workspaceContext,
              },
            }),
          );
          return context.json({
            ok: true,
            action: "pull_request_ready",
            message: "Pull request marked ready",
          });
        }
        case "pull_request_draft": {
          if (!environment.isGitRepo) {
            throw new ApiError(
              409,
              "invalid_request",
              "Pull request actions require a git environment",
            );
          }
          const target = requireWorkspaceCommandTarget(environment);
          const pullRequest = await getPullRequestForWorkspaceTarget(
            deps,
            target,
          );
          assertCanConvertPullRequestToDraft(pullRequest);

          await mapPullRequestActionFailureTo409(() =>
            runLiveCommandAndWait(deps, {
              hostId: target.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.pull_request_action",
                operation: "draft",
                environmentId: target.environmentId,
                workspaceContext: target.workspaceContext,
              },
            }),
          );
          return context.json({
            ok: true,
            action: "pull_request_draft",
            message: "Pull request converted to draft",
          });
        }
        case "pull_request_merge": {
          if (!environment.isGitRepo) {
            throw new ApiError(
              409,
              "invalid_request",
              "Pull request actions require a git environment",
            );
          }
          const target = requireWorkspaceCommandTarget(environment);
          const pullRequest = await getPullRequestForWorkspaceTarget(
            deps,
            target,
          );
          assertCanMergePullRequest(pullRequest);

          await mapPullRequestActionFailureTo409(() =>
            runLiveCommandAndWait(deps, {
              hostId: target.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.pull_request_action",
                operation: "merge",
                method: payload.options.method,
                environmentId: target.environmentId,
                workspaceContext: target.workspaceContext,
              },
            }),
          );
          return context.json({
            ok: true,
            action: "pull_request_merge",
            method: payload.options.method,
            message: "Pull request merge started",
          });
        }
        default: {
          const _exhaustive: never = payload;
          throw new Error(`Unhandled environment action: ${_exhaustive}`);
        }
      }
    } finally {
      deps.workspaceReadCaches.invalidateEnvironment(environment.id);
    }
  });
}
