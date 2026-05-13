import path from "node:path";
import { updateEnvironmentMetadata } from "@bb/db";
import {
  environmentActionRequestSchema,
  environmentDiffFileQuerySchema,
  environmentDiffQuerySchema,
  environmentStatusQuerySchema,
  updateEnvironmentRequestSchema,
  typedRoutes,
  type EnvironmentDiffFileQuery,
  type EnvironmentDiffQuery,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import {
  COMMAND_TIMEOUT_MS,
  WORKSPACE_DIFF_MAX_DIFF_BYTES,
  WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
} from "../constants.js";
import { ApiError } from "../errors.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
} from "../services/lib/entity-lookup.js";
import { queueCommandAndWait } from "../services/hosts/command-wait.js";
import { requireSourceForHost } from "../services/threads/thread-create-helpers.js";
import { generateCommitMessage } from "../services/ai/commit-message.js";
import {
  queueEnvironmentDemote,
  readEnvironmentPromotionResponse,
} from "../services/environments/environment-promotion.js";

const COMMIT_FALLBACK_MESSAGE = "bb: automated commit";
const SQUASH_MERGE_FALLBACK_MESSAGE = "bb: squash merge";
const PRE_MERGE_COMMIT_MESSAGE = "bb: pre-merge commit";

/** Caps for diffs sent to the inference model for commit message generation. */
const AI_MAX_DIFF_BYTES = 32_000;
const AI_MAX_FILE_LIST_BYTES = 4_000;

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

/**
 * Pick the git ref to read for the requested side of a diff. Returns
 * `undefined` when the side should be read from the working tree (no ref —
 * `host.read_file` falls back to its disk-read path).
 *
 * Only `uncommitted` and `all` have a working-tree side; the others read
 * from refs on both sides. `branch_committed` and `all` use the merge-base
 * SHA the diff was computed against as their old side (passed in by the
 * client from `workspace.diff`'s response — reading from the branch tip
 * instead would diverge from the diff's hunk coordinates whenever the
 * branch has moved past the merge-base). `commit` uses the parent commit
 * (`<sha>^`); on a root commit that ref is missing, but the daemon's
 * `git cat-file` fallback already returns empty content for missing
 * objects, so we don't special-case the root-commit edge here.
 */
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

export function registerEnvironmentRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/environments/:id", (context) =>
    context.json(requireEnvironment(deps.db, context.req.param("id"))),
  );

  patch(
    "/environments/:id",
    updateEnvironmentRequestSchema,
    (context, payload) => {
      const environment = requireEnvironment(deps.db, context.req.param("id"));
      const updated = updateEnvironmentMetadata(
        deps.db,
        deps.hub,
        environment.id,
        payload,
      );
      if (!updated) {
        throw new ApiError(
          404,
          "environment_not_found",
          "Environment not found",
        );
      }
      return context.json(updated);
    },
  );

  get(
    "/environments/:id/status",
    environmentStatusQuerySchema,
    async (context, query) => {
      const environment = requireReadyEnvironment(
        deps.db,
        context.req.param("id"),
      );
      if (!environment.isGitRepo) {
        return context.json({ workspace: null });
      }
      const result = await queueCommandAndWait(deps, {
        hostId: environment.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "workspace.status",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          ...(query.mergeBaseBranch
            ? { mergeBaseBranch: query.mergeBaseBranch }
            : {}),
        },
      });
      return context.json({ workspace: result.workspaceStatus });
    },
  );

  get("/environments/:id/promotion", async (context) => {
    const environment = requireEnvironment(deps.db, context.req.param("id"));
    return context.json(
      await readEnvironmentPromotionResponse(deps, { environment }),
    );
  });

  get(
    "/environments/:id/diff",
    environmentDiffQuerySchema,
    async (context, query) => {
      const environment = requireReadyEnvironment(
        deps.db,
        context.req.param("id"),
      );
      const result = await queueCommandAndWait(deps, {
        hostId: environment.hostId,
        timeoutMs: COMMAND_TIMEOUT_MS,
        command: {
          type: "workspace.diff",
          environmentId: environment.id,
          workspaceContext: {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          },
          target: toWorkspaceDiffTarget(query),
          maxDiffBytes: WORKSPACE_DIFF_MAX_DIFF_BYTES,
          maxFileListBytes: WORKSPACE_DIFF_MAX_FILE_LIST_BYTES,
        },
      });
      return context.json(result.diff);
    },
  );

  get(
    "/environments/:id/diff/file",
    environmentDiffFileQuerySchema,
    async (context, query) => {
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
      const result = await queueCommandAndWait(deps, {
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
    },
  );

  get("/environments/:id/diff/branches", async (context) => {
    const environment = requireReadyEnvironment(
      deps.db,
      context.req.param("id"),
    );
    const result = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.list_branches",
        path: environment.path,
      },
    });
    return context.json(result.branches);
  });

  post(
    "/environments/:id/actions",
    environmentActionRequestSchema,
    async (context, payload) => {
      const environment = requireReadyEnvironment(
        deps.db,
        context.req.param("id"),
      );

      switch (payload.action) {
        case "commit": {
          const workspaceContext = {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          };

          const [statusResult, diffResult] = await Promise.all([
            queueCommandAndWait(deps, {
              hostId: environment.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.status",
                environmentId: environment.id,
                workspaceContext,
              },
            }),
            queueCommandAndWait(deps, {
              hostId: environment.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.diff",
                environmentId: environment.id,
                workspaceContext,
                target: { type: "uncommitted" },
                maxDiffBytes: AI_MAX_DIFF_BYTES,
                maxFileListBytes: AI_MAX_FILE_LIST_BYTES,
              },
            }),
          ]);
          if (!statusResult.workspaceStatus.workingTree.hasUncommittedChanges) {
            throw new ApiError(
              409,
              "no_changes",
              "No uncommitted changes to commit",
            );
          }

          const aiMessage = await generateCommitMessage(deps, {
            diffDescription: "uncommitted changes",
            shortstat: diffResult.diff.shortstat,
            files: diffResult.diff.files,
            patch: diffResult.diff.diff,
          });
          const commitMessage = aiMessage ?? COMMIT_FALLBACK_MESSAGE;

          const result = await queueCommandAndWait(deps, {
            hostId: environment.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "workspace.commit",
              environmentId: environment.id,
              workspaceContext,
              message: commitMessage,
            },
          });
          return context.json({
            ok: true,
            action: "commit",
            message: `Created commit ${result.commitSha}`,
            commitSha: result.commitSha,
            commitSubject: result.commitSubject,
          });
        }
        case "squash_merge": {
          const workspaceContext = {
            workspacePath: environment.path,
            workspaceProvisionType: environment.workspaceProvisionType,
          };
          const targetBranch = payload.options.mergeBaseBranch;

          const statusResult = await queueCommandAndWait(deps, {
            hostId: environment.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "workspace.status",
              environmentId: environment.id,
              workspaceContext,
            },
          });

          const currentBranch =
            statusResult.workspaceStatus.branch.currentBranch;
          if (!currentBranch) {
            throw new ApiError(
              409,
              "invalid_request",
              "Cannot squash merge from a detached workspace",
            );
          }

          if (statusResult.workspaceStatus.workingTree.hasUncommittedChanges) {
            await queueCommandAndWait(deps, {
              hostId: environment.hostId,
              timeoutMs: COMMAND_TIMEOUT_MS,
              command: {
                type: "workspace.commit",
                environmentId: environment.id,
                workspaceContext,
                message: PRE_MERGE_COMMIT_MESSAGE,
              },
            });
          }

          const diffResult = await queueCommandAndWait(deps, {
            hostId: environment.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "workspace.diff",
              environmentId: environment.id,
              workspaceContext,
              target: {
                type: "branch_committed",
                mergeBaseBranch: targetBranch,
              },
              maxDiffBytes: AI_MAX_DIFF_BYTES,
              maxFileListBytes: AI_MAX_FILE_LIST_BYTES,
            },
          });

          const aiMessage = await generateCommitMessage(deps, {
            diffDescription: `squash merge of ${currentBranch} into ${targetBranch}`,
            shortstat: diffResult.diff.shortstat,
            files: diffResult.diff.files,
            patch: diffResult.diff.diff,
          });
          const commitMessage = aiMessage ?? SQUASH_MERGE_FALLBACK_MESSAGE;

          const result = await queueCommandAndWait(deps, {
            hostId: environment.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "workspace.squash_merge",
              environmentId: environment.id,
              workspaceContext,
              targetBranch,
              commitMessage,
            },
          });
          return context.json({
            ok: true,
            action: "squash_merge",
            merged: result.merged,
            message: "Squash merge completed",
            commitSha: result.commitSha,
            commitSubject: result.commitSubject,
          });
        }
        case "promote": {
          const source = requireSourceForHost(
            deps,
            environment.projectId,
            environment.hostId,
          );
          await queueCommandAndWait(deps, {
            hostId: environment.hostId,
            timeoutMs: COMMAND_TIMEOUT_MS,
            command: {
              type: "workspace.promote",
              environmentId: environment.id,
              workspaceContext: {
                workspacePath: environment.path,
                workspaceProvisionType: environment.workspaceProvisionType,
              },
              primaryPath: source.path,
            },
          });
          return context.json({
            ok: true,
            action: "promote",
            message: "Environment promoted to primary checkout",
          });
        }
        case "demote": {
          await queueEnvironmentDemote(deps, { environment });
          return context.json({
            ok: true,
            action: "demote",
            message: "Environment restored to default branch",
          });
        }
        default: {
          const _exhaustive: never = payload;
          throw new Error(`Unhandled environment action: ${_exhaustive}`);
        }
      }
    },
  );
}
