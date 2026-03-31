import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import {
  defaultListModels,
  defaultListProviders,
  requireExistingEnvironment,
  requireWorkspaceEnvironment,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";
import { provisionEnvironment } from "./command-handlers/environment.js";
import { readHostFile } from "./command-handlers/host-files.js";
import { ensureThreadRuntime, startThread } from "./command-handlers/thread.js";
import { WorkspaceError } from "@bb/workspace";
import { demoteWorkspace, promoteWorkspace, squashMerge } from "./command-handlers/workspace.js";
import { listBranches, listWorkspaceFiles, readWorkspaceFile } from "./command-handlers/workspace-files.js";

export {
  CommandDispatchError,
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

function seedThreadHighWaterMarkIfPresent(
  command:
    | Extract<HostDaemonCommand, { type: "thread.start" }>
    | Extract<HostDaemonCommand, { type: "turn.run" }>
    | Extract<HostDaemonCommand, { type: "turn.steer" }>,
  options: CommandDispatchOptions,
): void {
  if (command.eventSequence === undefined) {
    return;
  }
  options.seedThreadHighWaterMark?.({
    threadId: command.threadId,
    sequence: command.eventSequence,
  });
}

export async function dispatchCommand<TCommand extends HostDaemonCommand>(
  command: TCommand,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TCommand["type"]>> {
  switch (command.type) {
    case "thread.start":
      seedThreadHighWaterMarkIfPresent(command, options);
      return startThread(command, options) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    case "turn.run": {
      seedThreadHighWaterMarkIfPresent(command, options);
      const entry = await ensureThreadRuntime(command, options);
      await entry.runtime.runTurn({
        threadId: command.threadId,
        input: command.input,
        options: command.options,
        instructions: command.resumeContext.instructions,
      });
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "turn.steer": {
      seedThreadHighWaterMarkIfPresent(command, options);
      const entry = await ensureThreadRuntime(command, options);
      await entry.runtime.steerTurn({
        threadId: command.threadId,
        expectedTurnId: command.expectedTurnId,
        input: command.input,
        options: command.options,
        instructions: command.resumeContext.instructions,
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
    case "host.read_file":
      return readHostFile(command) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "provider.list":
      return {
        providers: (options.listProviders ?? defaultListProviders)(),
      } as HostDaemonCommandResult<TCommand["type"]>;
    case "provider.list_models":
      return {
        models: await (options.listModels ?? defaultListModels)(command.providerId),
      } as HostDaemonCommandResult<TCommand["type"]>;
    case "environment.provision":
      return provisionEnvironment(command, options) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "environment.destroy": {
      try {
        await requireWorkspaceEnvironment(command, options.runtimeManager);
        await options.runtimeManager.destroyEnvironment(command.environmentId);
      } catch (error) {
        // Treat already-missing workspaces as successful destroy (idempotent retry).
        if (error instanceof WorkspaceError && error.code === "path_not_found") {
          return {} as HostDaemonCommandResult<TCommand["type"]>;
        }
        throw error;
      }
      return {} as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.status": {
      const entry = await requireWorkspaceEnvironment(command, options.runtimeManager);
      return {
        workspaceStatus: await entry.workspace.getStatus({
          mergeBaseBranch: command.mergeBaseBranch,
        }),
      } as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.diff": {
      const entry = await requireWorkspaceEnvironment(command, options.runtimeManager);
      return {
        diff: await entry.workspace.getDiff({
          target: command.target,
        }),
      } as HostDaemonCommandResult<TCommand["type"]>;
    }
    case "workspace.commit": {
      const entry = await requireWorkspaceEnvironment(command, options.runtimeManager);
      return entry.workspace.commit({
        message: command.message,
      }) as Promise<HostDaemonCommandResult<TCommand["type"]>>;
    }
    case "workspace.squash_merge":
      return squashMerge(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "workspace.checkpoint": {
      const entry = await requireWorkspaceEnvironment(command, options.runtimeManager);
      return entry.workspace.checkpoint({
        commitMessage: command.commitMessage,
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
    case "workspace.list_files":
      return listWorkspaceFiles(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "workspace.read_file":
      return readWorkspaceFile(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    case "workspace.list_branches":
      return listBranches(command, options.runtimeManager) as Promise<
        HostDaemonCommandResult<TCommand["type"]>
      >;
    default: {
      const _exhaustive: never = command;
      throw new Error(`Unhandled command type: ${String(_exhaustive)}`);
    }
  }
}
