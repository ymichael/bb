import fs from "node:fs/promises";
import path from "node:path";
import { createProviderForId } from "@bb/agent-runtime";
import type { AvailableModel } from "@bb/domain";
import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
  HostDaemonExecutionOptions,
  environmentProvisionCommandSchema,
} from "@bb/host-daemon-contract";
import { RuntimeManager, type RuntimeEntry } from "./runtime-manager.js";

export type CommandOf<TType extends HostDaemonCommand["type"]> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

export interface ThreadRuntimeResolution {
  workspacePath: string;
  projectId?: string;
  providerId?: string;
  providerThreadId?: string;
  options?: HostDaemonExecutionOptions;
  dynamicTools?: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
  }>;
}

export interface CommandDispatchOptions {
  runtimeManager: RuntimeManager;
  resolveThreadRuntime?: (args: {
    environmentId: string;
    threadId: string;
  }) => Promise<ThreadRuntimeResolution | null>;
  listModels?: (providerId: string) => Promise<AvailableModel[]>;
}

export class CommandDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandDispatchError";
  }
}

export function getErrorCode(error: unknown): string {
  if (error instanceof CommandDispatchError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "command_failed";
}

export async function startThread(
  command: CommandOf<"thread.start">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"thread.start">> {
  const entry = await options.runtimeManager.ensureEnvironment({
    environmentId: command.environmentId,
    workspacePath: command.workspacePath,
  });
  const result = await entry.runtime.startThread({
    threadId: command.threadId,
    projectId: command.projectId,
    providerId: command.providerId,
    input: command.input,
    options: command.options,
    dynamicTools: command.dynamicTools,
  });
  options.runtimeManager.markThreadActive(
    command.environmentId,
    command.threadId,
    result.providerThreadId,
  );
  return result;
}

export async function resumeThread(
  command: CommandOf<"thread.resume">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"thread.resume">> {
  const entry = await options.runtimeManager.ensureEnvironment({
    environmentId: command.environmentId,
    workspacePath: command.workspacePath,
  });
  const result = await entry.runtime.resumeThread({
    threadId: command.threadId,
    projectId: command.projectId,
    providerThreadId: command.providerThreadId,
    providerId: command.providerId,
    options: command.options,
    resumePath: command.workspacePath,
    dynamicTools: command.dynamicTools,
  });
  options.runtimeManager.markThreadActive(
    command.environmentId,
    command.threadId,
    result.providerThreadId ?? command.providerThreadId,
  );
  return result;
}

export async function provisionEnvironment(
  command: CommandOf<"environment.provision">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.provision">> {
  const ranSetup = await detectSetupScript(command);
  const entry = await options.runtimeManager.ensureEnvironment({
    environmentId: command.environmentId,
    provision: toProvisionWorkspaceOptions(command),
  });
  return {
    path: entry.workspace.path,
    isGitRepo: entry.workspace.isGitRepo,
    isWorktree: entry.workspace.isWorktree,
    branchName: await entry.workspace.currentBranch(),
    ranSetup,
  };
}

export async function squashMerge(
  command: CommandOf<"workspace.squash_merge">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.squash_merge">> {
  const entry = await requireExistingEnvironment(command.environmentId, runtimeManager);
  const result = await entry.workspace.squashMergeInto({
    targetBranch: command.targetBranch,
    commitMessage: command.commitMessage,
  });
  return {
    merged: result.merged,
    commitSha: result.commitSha,
  };
}

export async function promoteWorkspace(
  command: CommandOf<"workspace.promote">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.promote">> {
  const entry = await requireExistingEnvironment(command.environmentId, runtimeManager);
  const primaryWorkspace = await runtimeManager.openWorkspace(command.primaryPath);
  await entry.workspace.promote(primaryWorkspace);
  return { ok: true };
}

export async function demoteWorkspace(
  command: CommandOf<"workspace.demote">,
  runtimeManager: RuntimeManager,
): Promise<HostDaemonCommandResult<"workspace.demote">> {
  const entry = await requireExistingEnvironment(command.environmentId, runtimeManager);
  const primaryWorkspace = await runtimeManager.openWorkspace(command.primaryPath);
  await entry.workspace.demote(primaryWorkspace, command.defaultBranch);
  return { ok: true };
}

export async function requireExistingEnvironment(
  environmentId: string,
  runtimeManager: RuntimeManager,
): Promise<RuntimeEntry> {
  const entry = await runtimeManager.getOrAwait(environmentId);
  if (!entry) {
    throw new CommandDispatchError(
      "unknown_environment",
      `No runtime exists for environment ${environmentId}`,
    );
  }
  return entry;
}

export async function ensureThreadRuntime(
  environmentId: string,
  threadId: string,
  options: CommandDispatchOptions,
): Promise<RuntimeEntry> {
  let entry = options.runtimeManager.get(environmentId);
  let resolution: ThreadRuntimeResolution | null = null;

  if (!entry || !options.runtimeManager.hasThread(environmentId, threadId)) {
    resolution = (await options.resolveThreadRuntime?.({
      environmentId,
      threadId,
    })) ?? null;
  }
  if (!entry) {
    if (!resolution?.workspacePath) {
      throw new CommandDispatchError(
        "unknown_environment",
        `No workspace path available for environment ${environmentId}`,
      );
    }
    entry = await options.runtimeManager.ensureEnvironment({
      environmentId,
      workspacePath: resolution.workspacePath,
    });
  }
  if (!options.runtimeManager.hasThread(environmentId, threadId)) {
    if (!resolution) {
      resolution = (await options.resolveThreadRuntime?.({
        environmentId,
        threadId,
      })) ?? null;
    }
    if (!resolution?.workspacePath) {
      throw new CommandDispatchError(
        "unknown_environment",
        `No runtime metadata available for thread ${threadId}`,
      );
    }
    await entry.runtime.resumeThread({
      threadId,
      projectId: resolution.projectId,
      providerThreadId: resolution.providerThreadId,
      providerId: resolution.providerId,
      options: resolution.options,
      resumePath: resolution.workspacePath,
      dynamicTools: resolution.dynamicTools,
    });
    options.runtimeManager.markThreadActive(
      environmentId,
      threadId,
      resolution.providerThreadId,
    );
  }
  return entry;
}

export async function detectSetupScript(
  command: typeof environmentProvisionCommandSchema._type,
): Promise<boolean> {
  const scriptName = command.scriptName ?? ".bb-env-setup.sh";
  const scriptParentPath =
    command.workspaceProvisionType === "unmanaged"
      ? command.path
      : command.sourcePath;
  if (!scriptParentPath) {
    return false;
  }
  try {
    await fs.access(path.join(scriptParentPath, scriptName));
    return true;
  } catch {
    return false;
  }
}

export function toProvisionWorkspaceOptions(
  command: typeof environmentProvisionCommandSchema._type,
) {
  switch (command.workspaceProvisionType) {
    case "unmanaged": {
      const sourcePath = command.sourcePath ?? command.path;
      if (!sourcePath) {
        throw new CommandDispatchError(
          "invalid_command",
          `Unmanaged provision missing source path for environment ${command.environmentId}`,
        );
      }
      return {
        workspaceProvisionType: "unmanaged" as const,
        path: sourcePath,
      };
    }
    case "managed-worktree":
    case "managed-clone": {
      if (!command.sourcePath || !command.targetPath || !command.branchName) {
        throw new CommandDispatchError(
          "invalid_command",
          `Managed provision missing sourcePath/targetPath/branchName for environment ${command.environmentId}`,
        );
      }
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        sourcePath: command.sourcePath,
        targetPath: command.targetPath,
        branchName: command.branchName,
        scriptName: command.scriptName,
        timeoutMs: command.timeoutMs,
      };
    }
  }
}

export async function defaultListModels(
  providerId: string,
): Promise<AvailableModel[]> {
  return createProviderForId(providerId).listModels();
}
