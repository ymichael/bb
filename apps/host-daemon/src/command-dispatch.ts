import type {
  HostDaemonCommand,
  HostDaemonCommandResult,
  HostDaemonCommandType,
} from "@bb/host-daemon-contract";
import type {
  ResolvedThreadExecutionOptions,
  RuntimeThreadExecutionOptions,
} from "@bb/domain";
import {
  defaultListModels,
  defaultListProviders,
  requireExistingEnvironment,
  requireWorkspaceEnvironment,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";
import { provisionEnvironment } from "./command-handlers/environment.js";
import { listHostBranches } from "./command-handlers/host-branches.js";
import {
  listHostFiles,
  listHostPaths,
  readHostFile,
  readHostFileMetadata,
  readHostRelativeFile,
  readHostStatusVersion,
} from "./command-handlers/host-files.js";
import { resolveInteractiveRequest } from "./command-handlers/interactive.js";
import {
  getReplayCapture,
  listReplayCaptures,
  removeReplayCapture,
  runReplay,
} from "./command-handlers/replay.js";
import {
  completeCodexInference,
  transcribeCodexVoice,
} from "./codex-chatgpt-client.js";
import {
  ensureThreadRuntime,
  handleThreadDeleted,
  startThread,
  submitTurn,
} from "./command-handlers/thread.js";
import { WorkspaceError } from "@bb/host-workspace";
import { squashMerge } from "./command-handlers/workspace.js";

export {
  CommandDispatchError,
  getErrorCode,
  noopEventSink,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

function recordReplayThreadMetadata(
  command:
    | Extract<HostDaemonCommand, { type: "thread.start" }>
    | Extract<HostDaemonCommand, { type: "turn.submit" }>,
  options: CommandDispatchOptions,
): void {
  if (!options.recordReplayCaptureThreadMetadata) {
    return;
  }
  const runtimeContext =
    command.type === "thread.start" ? command : command.resumeContext;
  options.recordReplayCaptureThreadMetadata({
    environmentId: command.environmentId,
    projectId: runtimeContext.projectId,
    providerId: runtimeContext.providerId,
    threadId: command.threadId,
    title: null,
  });
}

/**
 * Translate runtime-shape execution options (which carry permissionEscalation
 * details and no source field) into the server-shape used by stored client
 * turn-request events, which is what the manifest persists for replay.
 */
function toReplayCaptureExecution(
  options: RuntimeThreadExecutionOptions,
): ResolvedThreadExecutionOptions {
  return {
    model: options.model,
    serviceTier: options.serviceTier,
    reasoningLevel: options.reasoningLevel,
    permissionMode: options.permissionMode,
    source: "client/turn/requested",
  };
}

function recordReplayTurnRequest(
  command:
    | Extract<HostDaemonCommand, { type: "thread.start" }>
    | Extract<HostDaemonCommand, { type: "turn.submit" }>,
  options: CommandDispatchOptions,
): void {
  if (!options.recordReplayCaptureTurnRequest) {
    return;
  }
  if (command.type === "thread.start") {
    options.recordReplayCaptureTurnRequest({
      threadId: command.threadId,
      kind: "thread-start",
      input: command.input,
      execution: toReplayCaptureExecution(command.options),
    });
    return;
  }
  // Only "start" guarantees a new turn (and thus a turn/started event that
  // consumes the buffered request). "auto" and "steer" may resolve to a steer
  // that emits no turn/started — leaving a stale request that would mislabel
  // a later capture. Skip them.
  if (command.target.mode !== "start") {
    return;
  }
  options.recordReplayCaptureTurnRequest({
    threadId: command.threadId,
    kind: "turn-start",
    input: command.input,
    execution: toReplayCaptureExecution(command.options),
  });
}

type CommandHandlerMap = {
  [TType in HostDaemonCommandType]: (
    command: Extract<HostDaemonCommand, { type: TType }>,
    options: CommandDispatchOptions,
  ) => Promise<HostDaemonCommandResult<TType>>;
};

const commandHandlers: CommandHandlerMap = {
  "thread.start": async (
    command: Extract<HostDaemonCommand, { type: "thread.start" }>,
    options: CommandDispatchOptions,
  ) => {
    recordReplayThreadMetadata(command, options);
    recordReplayTurnRequest(command, options);
    return startThread(command, options);
  },
  "turn.submit": async (
    command: Extract<HostDaemonCommand, { type: "turn.submit" }>,
    options: CommandDispatchOptions,
  ) => {
    recordReplayThreadMetadata(command, options);
    recordReplayTurnRequest(command, options);
    const entry = await ensureThreadRuntime(command, options);
    return submitTurn(command, entry, options);
  },
  "thread.stop": async (
    command: Extract<HostDaemonCommand, { type: "thread.stop" }>,
    options: CommandDispatchOptions,
  ) => {
    const replayTask = options.replayTasks?.get(command.threadId);
    if (replayTask) {
      replayTask.abort.abort();
      return {};
    }
    const entry = await requireExistingEnvironment(
      command.environmentId,
      options.runtimeManager,
    );
    await entry.runtime.stopThread({ threadId: command.threadId });
    // Stop completion finalizes server-side thread state. Flush provider
    // events first so buffered lifecycle events cannot arrive after that.
    await options.eventSink.flush();
    options.runtimeManager.forgetThread(
      command.environmentId,
      command.threadId,
    );
    return {};
  },
  "thread.rename": async (
    command: Extract<HostDaemonCommand, { type: "thread.rename" }>,
    options: CommandDispatchOptions,
  ) => {
    const entry = await requireExistingEnvironment(
      command.environmentId,
      options.runtimeManager,
    );
    await entry.runtime.renameThread({
      threadId: command.threadId,
      title: command.title,
    });
    return {};
  },
  "thread.archive": async (
    command: Extract<HostDaemonCommand, { type: "thread.archive" }>,
    options: CommandDispatchOptions,
  ) => {
    const entry = await requireWorkspaceEnvironment(
      {
        environmentId: command.environmentId,
        workspaceContext: command.workspaceContext,
      },
      options.runtimeManager,
    );
    await entry.runtime.archiveThread({
      threadId: command.threadId,
      providerId: command.providerId,
      providerThreadId: command.providerThreadId,
    });
    options.runtimeManager.forgetThread(
      command.environmentId,
      command.threadId,
    );
    return {};
  },
  "thread.unarchive": async (
    command: Extract<HostDaemonCommand, { type: "thread.unarchive" }>,
    options: CommandDispatchOptions,
  ) => {
    const runtime =
      await options.runtimeManager.ensureProviderMaintenanceRuntime({
        dataDir: options.dataDir,
      });
    await runtime.unarchiveThread({
      threadId: command.threadId,
      providerId: command.providerId,
      providerThreadId: command.providerThreadId,
    });
    return {};
  },
  "thread.deleted": async (
    command: Extract<HostDaemonCommand, { type: "thread.deleted" }>,
    options: CommandDispatchOptions,
  ) => handleThreadDeleted(command, options),
  "replay.capture_list": async (
    _command: Extract<HostDaemonCommand, { type: "replay.capture_list" }>,
    options: CommandDispatchOptions,
  ) => listReplayCaptures(options),
  "replay.capture_get": async (
    command: Extract<HostDaemonCommand, { type: "replay.capture_get" }>,
    options: CommandDispatchOptions,
  ) => getReplayCapture(command, options),
  "replay.capture_delete": async (
    command: Extract<HostDaemonCommand, { type: "replay.capture_delete" }>,
    options: CommandDispatchOptions,
  ) => removeReplayCapture(command, options),
  "replay.run": async (
    command: Extract<HostDaemonCommand, { type: "replay.run" }>,
    options: CommandDispatchOptions,
  ) => runReplay(command, options),
  "interactive.resolve": async (
    command: Extract<HostDaemonCommand, { type: "interactive.resolve" }>,
    options: CommandDispatchOptions,
  ) => resolveInteractiveRequest(command, options),
  "codex.inference.complete": async (
    command: Extract<HostDaemonCommand, { type: "codex.inference.complete" }>,
    _options: CommandDispatchOptions,
  ) => completeCodexInference(command),
  "codex.voice.transcribe": async (
    command: Extract<HostDaemonCommand, { type: "codex.voice.transcribe" }>,
    _options: CommandDispatchOptions,
  ) => transcribeCodexVoice(command),
  "host.list_files": async (
    command: Extract<HostDaemonCommand, { type: "host.list_files" }>,
    _options: CommandDispatchOptions,
  ) => listHostFiles(command),
  "host.list_paths": async (
    command: Extract<HostDaemonCommand, { type: "host.list_paths" }>,
    _options: CommandDispatchOptions,
  ) => listHostPaths(command),
  "host.list_branches": async (
    command: Extract<HostDaemonCommand, { type: "host.list_branches" }>,
    _options: CommandDispatchOptions,
  ) => listHostBranches(command),
  "host.file_metadata": async (
    command: Extract<HostDaemonCommand, { type: "host.file_metadata" }>,
    _options: CommandDispatchOptions,
  ) => readHostFileMetadata(command),
  "host.status_version": async (
    command: Extract<HostDaemonCommand, { type: "host.status_version" }>,
    _options: CommandDispatchOptions,
  ) => readHostStatusVersion(command),
  "host.read_file": async (
    command: Extract<HostDaemonCommand, { type: "host.read_file" }>,
    _options: CommandDispatchOptions,
  ) => readHostFile(command),
  "host.read_file_relative": async (
    command: Extract<HostDaemonCommand, { type: "host.read_file_relative" }>,
    _options: CommandDispatchOptions,
  ) => readHostRelativeFile(command),
  "provider.list": async (
    _command: Extract<HostDaemonCommand, { type: "provider.list" }>,
    options: CommandDispatchOptions,
  ) => ({
    providers: (options.listProviders ?? defaultListProviders)(),
  }),
  "provider.list_models": async (
    command: Extract<HostDaemonCommand, { type: "provider.list_models" }>,
    options: CommandDispatchOptions,
  ) =>
    (options.listModels ?? defaultListModels)({
      providerId: command.providerId,
    }),
  "environment.provision": async (
    command: Extract<HostDaemonCommand, { type: "environment.provision" }>,
    options: CommandDispatchOptions,
  ) => provisionEnvironment(command, options),
  "environment.destroy": async (
    command: Extract<HostDaemonCommand, { type: "environment.destroy" }>,
    options: CommandDispatchOptions,
  ) => {
    try {
      await requireWorkspaceEnvironment(command, options.runtimeManager);
      options.terminalManager?.closeEnvironmentTerminals(
        command.environmentId,
        "environment-destroyed",
      );
      await options.runtimeManager.destroyEnvironment(command.environmentId);
    } catch (error) {
      // Treat already-missing workspaces as successful destroy (idempotent retry).
      if (error instanceof WorkspaceError && error.code === "path_not_found") {
        return {};
      }
      throw error;
    }
    return {};
  },
  "workspace.status": async (
    command: Extract<HostDaemonCommand, { type: "workspace.status" }>,
    options: CommandDispatchOptions,
  ) => {
    const entry = await requireWorkspaceEnvironment(
      command,
      options.runtimeManager,
    );
    return {
      workspaceStatus: await entry.workspace.getStatus({
        mergeBaseBranch: command.mergeBaseBranch,
      }),
    };
  },
  "workspace.diff": async (
    command: Extract<HostDaemonCommand, { type: "workspace.diff" }>,
    options: CommandDispatchOptions,
  ) => {
    const entry = await requireWorkspaceEnvironment(
      command,
      options.runtimeManager,
    );
    return {
      diff: await entry.workspace.getDiff({
        target: command.target,
        maxDiffBytes: command.maxDiffBytes,
        maxFileListBytes: command.maxFileListBytes,
      }),
    };
  },
  "workspace.commit": async (
    command: Extract<HostDaemonCommand, { type: "workspace.commit" }>,
    options: CommandDispatchOptions,
  ) => {
    const entry = await requireWorkspaceEnvironment(
      command,
      options.runtimeManager,
    );
    return entry.workspace.commit({
      message: command.message,
      noVerify: true,
    });
  },
  "workspace.squash_merge": async (
    command: Extract<HostDaemonCommand, { type: "workspace.squash_merge" }>,
    options: CommandDispatchOptions,
  ) => squashMerge(command, options.runtimeManager),
};

function dispatchCommandByType<TType extends HostDaemonCommandType>(
  type: TType,
  command: Extract<HostDaemonCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TType>> {
  return commandHandlers[type](command, options);
}

export function dispatchCommand<TType extends HostDaemonCommandType>(
  command: Extract<HostDaemonCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TType>> {
  return dispatchCommandByType(command.type, command, options);
}
