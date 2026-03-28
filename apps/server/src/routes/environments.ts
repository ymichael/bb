import { archiveThread, getDefaultProjectSource } from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import {
  environmentActionRequestSchema,
  environmentDiffQuerySchema,
  environmentStatusQuerySchema,
  typedRoutes,
  type EnvironmentDiffQuery,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { maybeCleanupEnvironment } from "../services/environment-cleanup.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
  requireThreadInEnvironment,
} from "../services/entity-lookup.js";
import { queueCommandAndWait } from "../services/command-wait.js";

function toWorkspaceDiffSelection(query: EnvironmentDiffQuery) {
  if (query.selection === "commit") {
    return {
      type: "commit" as const,
      sha: query.commitSha,
    };
  }
  return { type: "combined" as const };
}

export function registerEnvironmentRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, { onValidationError: (msg) => new ApiError(400, "invalid_request", msg) });

  get("/environments/:id", (context) =>
    context.json(requireEnvironment(deps.db, context.req.param("id"))),
  );

  get("/environments/:id/status", environmentStatusQuerySchema, async (context, query) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.status",
        environmentId: environment.id,
        environmentStatus: environment.status,
        workspacePath: environment.path,
        mergeBaseBranch: query.mergeBaseBranch,
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
        environmentStatus: environment.status,
        workspacePath: environment.path,
        selection: toWorkspaceDiffSelection(query),
        mergeBaseBranch: query.mergeBaseBranch,
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
        environmentStatus: environment.status,
        workspacePath: environment.path,
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.list_branches"].parse(rawResult).branches,
    );
  });

  post("/environments/:id/actions", environmentActionRequestSchema, async (context, payload) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const actingThread = requireThreadInEnvironment(
      deps.db,
      environment.id,
      payload.threadId,
    );

    switch (payload.action) {
      case "commit": {
        const rawResult = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.commit",
            environmentId: environment.id,
            environmentStatus: environment.status,
            workspacePath: environment.path,
            message: payload.options?.message ?? "Checkpoint changes",
          },
        });
        const result = hostDaemonCommandResultSchemaByType["workspace.commit"].parse(rawResult);
        const autoArchiveRequested = Boolean(payload.options?.autoArchiveOnSuccess);
        const archivedThread = autoArchiveRequested
          ? archiveThread(deps.db, deps.hub, actingThread.id)
          : null;
        if (archivedThread) {
          await maybeCleanupEnvironment(deps, archivedThread.environmentId);
        }
        return context.json({
          ok: true,
          action: "commit",
          commitCreated: true,
          message: `Created commit ${result.commitSha}`,
          autoArchived: Boolean(archivedThread),
          commitSha: result.commitSha,
          commitSubject: result.commitSubject,
        });
      }
      case "squash_merge": {
        if (!actingThread.mergeBaseBranch) {
          throw new ApiError(409, "invalid_request", "Environment has no merge base branch");
        }
        const rawResult = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.squash_merge",
            environmentId: environment.id,
            environmentStatus: environment.status,
            workspacePath: environment.path,
            targetBranch: payload.options?.mergeBaseBranch ?? actingThread.mergeBaseBranch,
          },
        });
        const result = hostDaemonCommandResultSchemaByType["workspace.squash_merge"].parse(rawResult);
        const autoArchiveRequested = Boolean(payload.options?.autoArchiveOnSuccess);
        const archivedThread = autoArchiveRequested
          ? archiveThread(deps.db, deps.hub, actingThread.id)
          : null;
        if (archivedThread) {
          await maybeCleanupEnvironment(deps, archivedThread.environmentId);
        }
        return context.json({
          ok: true,
          action: "squash_merge",
          merged: result.merged,
          message: "Squash merge completed",
          autoArchived: Boolean(archivedThread),
          commitSha: result.commitSha,
        });
      }
      case "promote": {
        const source = getDefaultProjectSource(deps.db, environment.projectId);
        if (!source?.path || source.hostId !== environment.hostId) {
          throw new ApiError(409, "invalid_request", "Environment cannot be promoted");
        }
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.promote",
            environmentId: environment.id,
            environmentStatus: environment.status,
            workspacePath: environment.path,
            threadId: actingThread.id,
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
        const source = getDefaultProjectSource(deps.db, environment.projectId);
        if (
          !source?.path ||
          source.hostId !== environment.hostId ||
          !environment.branchName ||
          !actingThread.mergeBaseBranch
        ) {
          throw new ApiError(409, "invalid_request", "Environment cannot be demoted");
        }
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.demote",
            environmentId: environment.id,
            environmentStatus: environment.status,
            workspacePath: environment.path,
            threadId: actingThread.id,
            primaryPath: source.path,
            defaultBranch: actingThread.mergeBaseBranch,
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
