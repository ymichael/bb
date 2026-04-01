import { updateEnvironmentMetadata } from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  environmentActionRequestSchema,
  environmentDiffQuerySchema,
  environmentStatusQuerySchema,
  updateEnvironmentRequestSchema,
  typedRoutes,
  type EnvironmentDiffQuery,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
} from "../services/entity-lookup.js";
import { queueCommandAndWait } from "../services/command-wait.js";
import { requireSourceForHost } from "../services/thread-create-helpers.js";
import { generateCommitMessage } from "../services/commit-message.js";

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

export function registerEnvironmentRoutes(app: Hono, deps: AppDeps): void {
  const { get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  get("/environments/:id", (context) =>
    context.json(requireEnvironment(deps.db, context.req.param("id"))),
  );

  patch("/environments/:id", updateEnvironmentRequestSchema, (context, payload) => {
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

  get("/environments/:id/status", environmentStatusQuerySchema, async (context, query) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
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
    const result = hostDaemonCommandResultSchemaByType["workspace.status"].parse(rawResult);
    return context.json({ workspace: result.workspaceStatus });
  });

  get("/environments/:id/diff", environmentDiffQuerySchema, async (context, query) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
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
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.diff"].parse(rawResult).diff,
    );
  });

  get("/environments/:id/diff/branches", async (context) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.list_branches",
        environmentId: environment.id,
        workspaceContext: {
          workspacePath: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        },
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.list_branches"].parse(rawResult).branches,
    );
  });

  post("/environments/:id/actions", environmentActionRequestSchema, async (context, payload) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));

    switch (payload.action) {
      case "commit": {
        const workspaceContext = {
          workspacePath: environment.path,
          workspaceProvisionType: environment.workspaceProvisionType,
        };

        const [statusRaw, diffRaw] = await Promise.all([
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
        const statusResult = hostDaemonCommandResultSchemaByType["workspace.status"].parse(statusRaw);
        if (!statusResult.workspaceStatus.workingTree.hasUncommittedChanges) {
          throw new ApiError(409, "no_changes", "No uncommitted changes to commit");
        }
        const diffResult = hostDaemonCommandResultSchemaByType["workspace.diff"].parse(diffRaw);

        const aiMessage = await generateCommitMessage(deps, {
          diffDescription: "uncommitted changes",
          shortstat: diffResult.diff.shortstat,
          files: diffResult.diff.files,
          patch: diffResult.diff.diff,
        });
        const commitMessage = aiMessage ?? COMMIT_FALLBACK_MESSAGE;

        const rawResult = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.commit",
            environmentId: environment.id,
            workspaceContext,
            message: commitMessage,
          },
        });
        const result = hostDaemonCommandResultSchemaByType["workspace.commit"].parse(rawResult);
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

        const statusRaw = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.status",
            environmentId: environment.id,
            workspaceContext,
          },
        });
        const statusResult = hostDaemonCommandResultSchemaByType["workspace.status"].parse(statusRaw);

        const currentBranch = statusResult.workspaceStatus.branch.currentBranch;
        if (!currentBranch) {
          throw new ApiError(409, "invalid_request", "Cannot squash merge from a detached workspace");
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

        const diffRaw = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.diff",
            environmentId: environment.id,
            workspaceContext,
            target: { type: "branch_committed", mergeBaseBranch: targetBranch },
            maxDiffBytes: AI_MAX_DIFF_BYTES,
            maxFileListBytes: AI_MAX_FILE_LIST_BYTES,
          },
        });
        const diffResult = hostDaemonCommandResultSchemaByType["workspace.diff"].parse(diffRaw);

        const aiMessage = await generateCommitMessage(deps, {
          diffDescription: `squash merge of ${currentBranch} into ${targetBranch}`,
          shortstat: diffResult.diff.shortstat,
          files: diffResult.diff.files,
          patch: diffResult.diff.diff,
        });
        const commitMessage = aiMessage ?? SQUASH_MERGE_FALLBACK_MESSAGE;

        const rawResult = await queueCommandAndWait(deps, {
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
        const result = hostDaemonCommandResultSchemaByType["workspace.squash_merge"].parse(rawResult);
        return context.json({
          ok: true,
          action: "squash_merge",
          merged: result.merged,
          message: "Squash merge completed",
          commitSha: result.commitSha,
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
        const source = requireSourceForHost(
          deps,
          environment.projectId,
          environment.hostId,
        );
        const mergeBaseBranch = environment.mergeBaseBranch ?? environment.defaultBranch;
        if (!environment.branchName || !mergeBaseBranch) {
          throw new ApiError(409, "invalid_request", "Environment cannot be demoted");
        }
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.demote",
            environmentId: environment.id,
            workspaceContext: {
              workspacePath: environment.path,
              workspaceProvisionType: environment.workspaceProvisionType,
            },
            primaryPath: source.path,
            defaultBranch: mergeBaseBranch,
            envBranch: environment.branchName,
          },
        });
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
  });
}
