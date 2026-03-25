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

export async function ensureThreadRuntime(
  environmentId: string,
  threadId: string,
  options: CommandDispatchOptions,
): Promise<RuntimeEntry> {
  let entry = options.runtimeManager.get(environmentId);
  let resolution: import("../command-dispatch-support.js").ThreadRuntimeResolution | null = null;

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
