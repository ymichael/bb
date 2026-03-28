import type { HostDaemonCommandResult } from "@bb/host-daemon-contract";
import type { RuntimeEntry } from "../runtime-manager.js";
import { CommandDispatchError, type CommandDispatchOptions, type CommandOf } from "../command-dispatch-support.js";

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
    instructions: command.instructions,
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
    instructions: command.instructions,
    resumePath: command.workspacePath,
    dynamicTools: command.dynamicTools,
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
  let entry = options.runtimeManager.get(command.environmentId);
  if (!entry) {
    entry = await options.runtimeManager.ensureEnvironment({
      environmentId: command.environmentId,
      workspacePath: command.workspacePath,
    });
  }

  if (!options.runtimeManager.hasThread(command.environmentId, command.threadId)) {
    if (!command.providerThreadId) {
      throw new CommandDispatchError(
        "unknown_thread_runtime",
        `No provider thread id available for thread ${command.threadId}`,
      );
    }
    const result = await entry.runtime.resumeThread({
      threadId: command.threadId,
      projectId: command.projectId,
      providerThreadId: command.providerThreadId,
      providerId: command.providerId,
      options: command.options,
      instructions: command.instructions,
      resumePath: command.workspacePath,
      dynamicTools: command.dynamicTools,
    });
    options.runtimeManager.markThreadActive(
      command.environmentId,
      command.threadId,
      result.providerThreadId,
    );
  }
  return entry;
}
