import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import {
  defaultListModels,
  demoteWorkspace,
  ensureThreadRuntime,
  promoteWorkspace,
  provisionEnvironment,
  requireExistingEnvironment,
  resumeThread,
  squashMerge,
  startThread,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

export {
  CommandDispatchError,
  getErrorCode,
  type CommandDispatchOptions,
  type ThreadRuntimeResolution,
} from "./command-dispatch-support.js";

export async function dispatchCommand<TCommand extends HostDaemonCommand>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TCommand["type"]>> {
  switch (command.type) {
    case "thread.start":
      return startThread(command, options) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    case "thread.resume":
      return resumeThread(command, options) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    case "turn.run": {
      const entry = await ensureThreadRuntime(
        command.environmentId,
        command.threadId,
        options,
      );
      await entry.runtime.runTurn({
        threadId: command.threadId,
        input: command.input,
        options: command.options,
      });
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "turn.steer": {
      const entry = await ensureThreadRuntime(
        command.environmentId,
        command.threadId,
        options,
      );
      await entry.runtime.steerTurn({
        threadId: command.threadId,
        expectedTurnId: command.expectedTurnId,
        input: command.input,
      });
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "thread.stop": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      await entry.runtime.stopThread({ threadId: command.threadId });
      options.runtimeManager.markThreadInactive(
        command.environmentId,
        command.threadId,
      );
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "thread.rename": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      await entry.runtime.renameThread({
        threadId: command.threadId,
        title: command.title,
      });
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "provider.list_models":
      return {
        models: await (options.listModels ?? defaultListModels)(command.providerId),
      } as HostDaemonCommandResult<TCommand["type"]>;
    case "environment.provision":
      return provisionEnvironment(command, options) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "environment.destroy": {
      const existing = options.runtimeManager.get(command.environmentId);
      if (existing) {
        await options.runtimeManager.destroyEnvironment(command.environmentId);
      }
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.status": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      return {
        workspaceStatus: await entry.workspace.getStatus(),
      } as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.diff": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      return {
        diff: await entry.workspace.getDiff({
          mergeBaseBranch: command.mergeBaseBranch,
          selection: command.selection,
        }),
      } as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.commit": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      return entry.workspace.commit({
        message: command.message,
        includeUnstaged: command.includeUnstaged,
      }) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    }
    case "workspace.squash_merge":
      return squashMerge(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "workspace.reset": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      await entry.workspace.reset();
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.checkpoint": {
      const entry = await requireExistingEnvironment(
        command.environmentId,
        options.runtimeManager,
      );
      return entry.workspace.checkpoint({
        commitMessage: command.commitMessage,
        remoteName: command.remoteName,
      }) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    }
    case "workspace.promote":
      return promoteWorkspace(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "workspace.demote":
      return demoteWorkspace(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled command type: ${String(_exhaustive)}`);
    }
  }
}
