import { z } from "zod";
import {
  createEnvironment,
  createEventId,
  findProjectEnvironmentByHostPath,
  getEnvironment,
  getThread,
  updateThread,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import type {
  DynamicTool,
  Environment,
  Thread,
  ToolCallResponse,
} from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { runLiveHostCommand } from "../hosts/live-command.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { buildEnvironmentProvisionCommand } from "./thread-create-helpers.js";
import { findHostDataDir } from "../lib/entity-lookup.js";
import { unmanagedAttachRefusal } from "./workspace-path-claims.js";

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME =
  "update_environment_directory";

const UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS = 5 * 60 * 1000;

const updateEnvironmentDirectoryInputSchema = z
  .object({
    path: z.string().trim().min(1),
  })
  .strict();

export const UPDATE_ENVIRONMENT_DIRECTORY_TOOL: DynamicTool = {
  name: UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
  description:
    "Move this bb thread to a different working directory for subsequent turns. Use this when the user asks to switch to a new checkout, worktree, or local directory. The path must be an absolute existing directory on the current host. The tool reuses this project's existing bb environment for that host/path, otherwise it creates an unmanaged environment after validating the path. Another project may hold its own environment for the same directory; that is allowed, except for a bb-managed worktree owned by another project, which this tool refuses. After a successful switch, stop the current turn because the running provider cwd will not change until the next turn.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Absolute path to an existing directory on the current host.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  presentation: {
    label: {
      pending: "Moving the thread directory",
      completed: "Moved the thread directory",
    },
    icon: { glyph: "FolderOpen" },
  },
};

interface HandleUpdateEnvironmentDirectoryToolCallArgs {
  currentEnvironment: Environment;
  input: unknown;
  thread: Thread;
  turnId: string;
}

type ReadyEnvironment = Environment & { path: string; status: "ready" };

type AttachEnvironmentResult =
  | { kind: "attached"; changed: boolean }
  | { kind: "environment_changed" }
  | { kind: "thread_unavailable"; message: string };

function toolCallTextResponse(
  success: boolean,
  text: string,
): ToolCallResponse {
  return {
    success,
    contentItems: [{ type: "inputText", text }],
  };
}

function toolCallFailure(text: string): ToolCallResponse {
  return toolCallTextResponse(false, text);
}

function toolCallSuccess(text: string): ToolCallResponse {
  return toolCallTextResponse(true, text);
}

function normalizeDirectoryPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/u, "");
}

function validateDirectoryPath(path: string): string | null {
  if (!path.startsWith("/")) {
    return "Path must be an absolute path on the current host.";
  }
  if (path === "/") {
    return "Path must name a project directory, not the filesystem root.";
  }
  if (path.includes("\0")) {
    return "Path must not contain NUL bytes.";
  }
  return null;
}

function threadWritableFailure(thread: Thread): string | null {
  if (thread.deletedAt !== null) {
    return "Cannot update the environment directory for a deleted thread.";
  }
  if (thread.archivedAt !== null) {
    return "Cannot update the environment directory for an archived thread.";
  }
  return null;
}

function resolveReadyEnvironment(
  environment: Environment,
): ReadyEnvironment | { failure: string } {
  if (environment.status !== "ready") {
    return {
      failure: `Environment at this path is ${environment.status}, not ready.`,
    };
  }
  if (!environment.path) {
    return {
      failure: "Environment at this path does not have a resolved directory.",
    };
  }
  return {
    ...environment,
    path: environment.path,
    status: environment.status,
  };
}

function successMessage(path: string): string {
  return `Environment directory updated to ${path}. This applies to future turns; stop work in this turn so the next turn can run from the updated directory.`;
}

function attachReadyEnvironment(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    currentEnvironment: Environment;
    createdEnvironment: boolean;
    targetEnvironment: ReadyEnvironment;
    thread: Thread;
    turnId: string;
  },
): AttachEnvironmentResult {
  const result = deps.db.transaction(
    (tx): AttachEnvironmentResult => {
      const latestThread = getThread(tx, args.thread.id);
      if (!latestThread || latestThread.deletedAt !== null) {
        return {
          kind: "thread_unavailable",
          message: "Thread no longer exists.",
        };
      }

      const writableFailure = threadWritableFailure(latestThread);
      if (writableFailure) {
        return { kind: "thread_unavailable", message: writableFailure };
      }

      if (latestThread.environmentId === args.targetEnvironment.id) {
        return { kind: "attached", changed: false };
      }

      if (latestThread.environmentId !== args.currentEnvironment.id) {
        return { kind: "environment_changed" };
      }

      updateThread(tx, deps.hub, latestThread.id, {
        environmentId: args.targetEnvironment.id,
      });
      appendThreadEventInTransaction(tx, {
        threadId: latestThread.id,
        environmentId: args.targetEnvironment.id,
        type: "system/operation",
        scope: turnScope(args.turnId),
        data: {
          operation: "environment_directory_update",
          operationId: createEventId(),
          status: "completed",
          message: `Updated environment directory to ${args.targetEnvironment.path}`,
          metadata: {
            createdEnvironment: args.createdEnvironment,
            previousEnvironmentId: args.currentEnvironment.id,
            previousPath: args.currentEnvironment.path,
            nextEnvironmentId: args.targetEnvironment.id,
            nextPath: args.targetEnvironment.path,
            workspaceProvisionType:
              args.targetEnvironment.workspaceProvisionType,
          },
        },
      });
      return { kind: "attached", changed: true };
    },
    { behavior: "immediate" },
  );

  if (result.kind === "attached" && result.changed) {
    deps.hub.notifyThread(args.thread.id, ["events-appended"], {
      eventTypes: ["system/operation"],
    });
  }

  return result;
}

async function provisionUnmanagedEnvironmentForPath(
  deps: AppDeps,
  args: {
    currentEnvironment: Environment;
    path: string;
    thread: Thread;
  },
): Promise<ReadyEnvironment | ToolCallResponse> {
  const environment = createEnvironment(deps.db, deps.hub, {
    projectId: args.thread.projectId,
    hostId: args.currentEnvironment.hostId,
    workspaceProvisionType: "unmanaged",
    managed: false,
    status: "provisioning",
  });
  const command = buildEnvironmentProvisionCommand({
    workspaceProvisionType: "unmanaged",
    environmentId: environment.id,
    hostId: args.currentEnvironment.hostId,
    initiator: null,
    path: args.path,
  });

  try {
    await runLiveHostCommand(deps, {
      hostId: args.currentEnvironment.hostId,
      command,
      timeoutMs: UPDATE_ENVIRONMENT_DIRECTORY_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolCallFailure(
      `Could not update environment directory to ${args.path}: ${message}`,
    );
  }

  const readyEnvironment = getEnvironment(deps.db, environment.id);
  if (!readyEnvironment) {
    return toolCallFailure("Prepared environment no longer exists.");
  }
  const ready = resolveReadyEnvironment(readyEnvironment);
  if ("failure" in ready) {
    return toolCallFailure(ready.failure);
  }
  return ready;
}

export async function handleUpdateEnvironmentDirectoryToolCall(
  deps: AppDeps,
  args: HandleUpdateEnvironmentDirectoryToolCallArgs,
): Promise<ToolCallResponse> {
  const input = updateEnvironmentDirectoryInputSchema.safeParse(args.input);
  if (!input.success) {
    return toolCallFailure(
      "Invalid arguments. Provide an object with an absolute path string.",
    );
  }

  const normalizedPath = normalizeDirectoryPath(input.data.path);
  const pathFailure = validateDirectoryPath(normalizedPath);
  if (pathFailure) {
    return toolCallFailure(pathFailure);
  }

  const writableFailure = threadWritableFailure(args.thread);
  if (writableFailure) {
    return toolCallFailure(writableFailure);
  }

  if (args.currentEnvironment.path === normalizedPath) {
    return toolCallSuccess(
      `This thread is already using ${normalizedPath} as its environment directory.`,
    );
  }

  const refusal = unmanagedAttachRefusal(deps.db, {
    checksOutBranch: false,
    dataDir: findHostDataDir(deps, args.currentEnvironment.hostId),
    hostId: args.currentEnvironment.hostId,
    path: normalizedPath,
    projectId: args.thread.projectId,
  });
  if (refusal) {
    return toolCallFailure(`${refusal.message}. Use a different directory.`);
  }

  const existingEnvironment = findProjectEnvironmentByHostPath(
    deps.db,
    args.thread.projectId,
    args.currentEnvironment.hostId,
    normalizedPath,
  );
  let createdEnvironment = false;
  let targetEnvironment: ReadyEnvironment;

  if (existingEnvironment) {
    const ready = resolveReadyEnvironment(existingEnvironment);
    if ("failure" in ready) {
      return toolCallFailure(ready.failure);
    }
    targetEnvironment = ready;
  } else {
    const provisionedEnvironment = await provisionUnmanagedEnvironmentForPath(
      deps,
      {
        currentEnvironment: args.currentEnvironment,
        path: normalizedPath,
        thread: args.thread,
      },
    );

    if ("success" in provisionedEnvironment) {
      return provisionedEnvironment;
    }
    targetEnvironment = provisionedEnvironment;
    createdEnvironment = true;
  }

  const attachResult = attachReadyEnvironment(deps, {
    currentEnvironment: args.currentEnvironment,
    createdEnvironment,
    targetEnvironment,
    thread: args.thread,
    turnId: args.turnId,
  });

  switch (attachResult.kind) {
    case "attached":
      return toolCallSuccess(successMessage(targetEnvironment.path));
    case "environment_changed":
      return toolCallFailure(
        "Thread environment changed while preparing the new directory. Try again with the desired path.",
      );
    case "thread_unavailable":
      return toolCallFailure(attachResult.message);
  }
}
