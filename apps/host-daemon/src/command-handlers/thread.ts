import fs from "node:fs/promises";
import path from "node:path";
import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import { resolveContainedPath } from "@bb/process-utils";
import type { RuntimeEntry } from "../runtime-manager.js";
import { CommandDispatchError, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

function requireConfinedPath(rootPath: string, candidatePath: string): string {
  const resolved = resolveContainedPath({
    rootPath,
    candidatePath,
  });
  if (!resolved) {
    throw new CommandDispatchError(
      "invalid_path",
      "Thread storage path escapes the storage root",
    );
  }
  return resolved;
}

function resolveThreadStorageDir(
  threadStorageRootPath: string,
  threadId: string,
): string {
  return requireConfinedPath(
    threadStorageRootPath,
    path.join(threadStorageRootPath, threadId),
  );
}

export async function startThread(
  command: CommandOf<"thread.start">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"thread.start">> {
  if (command.threadStoragePath) {
    const confined = requireConfinedPath(
      options.threadStorageRootPath,
      command.threadStoragePath,
    );
    await fs.mkdir(confined, { recursive: true });
  }
  const entry = await options.runtimeManager.ensureEnvironment({
    environmentId: command.environmentId,
    workspacePath: command.workspaceContext.workspacePath,
    workspaceProvisionType: command.workspaceContext.workspaceProvisionType,
  });
  const result = await entry.runtime.startThread({
    environmentId: command.environmentId,
    threadId: command.threadId,
    projectId: command.projectId,
    providerId: command.providerId,
    input: command.input,
    options: command.options,
    instructions: command.instructions,
    dynamicTools: command.dynamicTools,
    instructionMode: command.instructionMode,
  });
  options.runtimeManager.markThreadActive(
    command.environmentId,
    command.threadId,
    result.providerThreadId,
  );
  return result;
}



export async function ensureThreadRuntime(
  command: CommandOf<"turn.run"> | CommandOf<"turn.steer">,
  options: CommandDispatchOptions,
): Promise<RuntimeEntry> {
  const { resumeContext } = command;
  let providerThreadId = resumeContext.providerThreadId;
  let entry = options.runtimeManager.get(command.environmentId);
  if (!entry) {
    entry = await options.runtimeManager.ensureEnvironment({
      environmentId: command.environmentId,
      workspacePath: resumeContext.workspaceContext.workspacePath,
      workspaceProvisionType: resumeContext.workspaceContext.workspaceProvisionType,
    });
  }

  if (!options.runtimeManager.hasThread(command.environmentId, command.threadId)) {
    if (!resumeContext.providerThreadId) {
      throw new CommandDispatchError(
        "unknown_thread_runtime",
        `No provider thread id available for thread ${command.threadId}`,
      );
    }
    const result = await entry.runtime.resumeThread({
      environmentId: command.environmentId,
      threadId: command.threadId,
      projectId: resumeContext.projectId,
      providerThreadId: resumeContext.providerThreadId,
      providerId: resumeContext.providerId,
      options: command.options,
      instructions: resumeContext.instructions,
      resumePath: resumeContext.workspaceContext.workspacePath,
      dynamicTools: resumeContext.dynamicTools,
      instructionMode: resumeContext.instructionMode,
    });
    providerThreadId = result.providerThreadId;
  }
  options.runtimeManager.markThreadActive(
    command.environmentId,
    command.threadId,
    providerThreadId,
  );
  return entry;
}

export async function handleThreadDeleted(
  command: CommandOf<"thread.deleted">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"thread.deleted">> {
  const threadDir = resolveThreadStorageDir(
    options.threadStorageRootPath,
    command.threadId,
  );
  await fs.rm(threadDir, { recursive: true, force: true });
  return {};
}
