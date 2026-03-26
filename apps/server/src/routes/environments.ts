import { archiveThread, getDefaultProjectSource } from "@bb/db";
import { hostDaemonCommandResultSchemaByType } from "@bb/host-daemon-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import { maybeCleanupEnvironment } from "../services/environment-cleanup.js";
import {
  requireEnvironment,
  requireReadyEnvironment,
  selectPrimaryThreadForEnvironment,
} from "../services/entity-lookup.js";
import { queueCommandAndWait } from "../services/command-wait.js";
import { parseJsonBody } from "../services/validation.js";
import { environmentActionRequestSchema } from "@bb/server-contract";

function resolveDiffSelection(query: Record<string, string | undefined>) {
  if (query.selection === "commit" && query.commitSha) {
    return {
      type: "commit" as const,
      sha: query.commitSha,
    };
  }
  if (query.selection === "combined") {
    return { type: "combined" as const };
  }
  return undefined;
}

export function registerEnvironmentRoutes(app: Hono, deps: AppDeps): void {
  app.get("/environments/:id", (context) =>
    context.json(requireEnvironment(deps.db, context.req.param("id"))),
  );

  app.get("/environments/:id/status", async (context) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.status",
        environmentId: environment.id,
        ...(context.req.query("mergeBaseBranch")
          ? { mergeBaseBranch: context.req.query("mergeBaseBranch") }
          : {}),
      },
    });
    const result = hostDaemonCommandResultSchemaByType["workspace.status"].parse(rawResult);
    return context.json({ workspace: result.workspaceStatus });
  });

  app.get("/environments/:id/diff", async (context) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.diff",
        environmentId: environment.id,
        ...(resolveDiffSelection(context.req.query()) ? { selection: resolveDiffSelection(context.req.query()) } : {}),
        ...(context.req.query("mergeBaseBranch")
          ? { mergeBaseBranch: context.req.query("mergeBaseBranch") }
          : {}),
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.diff"].parse(rawResult).diff,
    );
  });

  app.get("/environments/:id/diff/branches", async (context) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const rawResult = await queueCommandAndWait(deps, {
      hostId: environment.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "workspace.list_branches",
        environmentId: environment.id,
      },
    });
    return context.json(
      hostDaemonCommandResultSchemaByType["workspace.list_branches"].parse(rawResult).branches,
    );
  });

  app.post("/environments/:id/actions", async (context) => {
    const environment = requireReadyEnvironment(deps.db, context.req.param("id"));
    const payload = await parseJsonBody(context, environmentActionRequestSchema);
    const primaryThread = selectPrimaryThreadForEnvironment(deps.db, environment.id);

    switch (payload.action) {
      case "commit": {
        const rawResult = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.commit",
            environmentId: environment.id,
            message: payload.options?.message ?? "Checkpoint changes",
            ...(payload.options?.includeUnstaged !== undefined
              ? { includeUnstaged: payload.options.includeUnstaged }
              : {}),
          },
        });
        const result = hostDaemonCommandResultSchemaByType["workspace.commit"].parse(rawResult);
        const autoArchiveRequested = Boolean(payload.options?.autoArchiveOnSuccess && primaryThread);
        const archivedThread = autoArchiveRequested && primaryThread
          ? archiveThread(deps.db, deps.hub, primaryThread.id)
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
        if (!primaryThread?.mergeBaseBranch) {
          throw new ApiError(409, "invalid_request", "Environment has no merge base branch");
        }
        const rawResult = await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.squash_merge",
            environmentId: environment.id,
            targetBranch: payload.options?.mergeBaseBranch ?? primaryThread.mergeBaseBranch,
            commitMessage:
              payload.options?.squashMessage ??
              payload.options?.commitMessage ??
              "bb squash merge",
          },
        });
        const result = hostDaemonCommandResultSchemaByType["workspace.squash_merge"].parse(rawResult);
        const autoArchiveRequested = Boolean(payload.options?.autoArchiveOnSuccess && primaryThread);
        const archivedThread = autoArchiveRequested && primaryThread
          ? archiveThread(deps.db, deps.hub, primaryThread.id)
          : null;
        if (archivedThread) {
          await maybeCleanupEnvironment(deps, archivedThread.environmentId);
        }
        return context.json({
          ok: true,
          action: "squash_merge",
          merged: result.merged,
          message: result.message ?? "Squash merge completed",
          autoArchived: Boolean(archivedThread),
          commitSha: result.commitSha,
        });
      }
      case "promote": {
        const source = getDefaultProjectSource(deps.db, environment.projectId);
        if (!source?.path || source.hostId !== environment.hostId || !primaryThread) {
          throw new ApiError(409, "invalid_request", "Environment cannot be promoted");
        }
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.promote",
            environmentId: environment.id,
            threadId: primaryThread.id,
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
          !primaryThread ||
          !environment.branchName ||
          !primaryThread.mergeBaseBranch
        ) {
          throw new ApiError(409, "invalid_request", "Environment cannot be demoted");
        }
        await queueCommandAndWait(deps, {
          hostId: environment.hostId,
          timeoutMs: COMMAND_TIMEOUT_MS,
          command: {
            type: "workspace.demote",
            environmentId: environment.id,
            threadId: primaryThread.id,
            primaryPath: source.path,
            defaultBranch: primaryThread.mergeBaseBranch,
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
