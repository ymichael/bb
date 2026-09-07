import {
  providerCliInstallEventSchema,
  type HostDaemonCommand,
  type HostDaemonCommandResult,
  type HostDaemonOnlineRpcCommand,
  type HostDaemonOnlineRpcCommandType,
  type HostDaemonOnlineRpcResult,
  type HostDaemonSettledCommandType,
  type ProviderCliInstallEvent,
} from "@bb/host-daemon-contract";
import semver from "semver";
import {
  ExpectedCommandDispatchError,
  resolveRuntimeBridgeLaunch,
  type CommandOf,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";
import {
  cancelEnvironmentProvision,
  provisionEnvironment,
} from "./command-handlers/environment.js";
import {
  inspectHostGitSource,
  listHostBranchOptions,
} from "./command-handlers/host-branches.js";
import {
  installGlobalSkills,
  readGlobalSkillsStatus,
} from "./command-handlers/install-global-skills.js";
import { listHostCommands } from "./command-handlers/list-commands.js";
import {
  deleteHostSkill,
  listHostSkills,
  writeHostSkill,
} from "./command-handlers/list-skills.js";
import {
  browseHostDirectory,
  checkHostPathsExist,
  listHostFiles,
  listHostPaths,
  readHostFile,
  readHostFileMetadata,
  readHostRelativeFile,
} from "./command-handlers/host-files.js";
import { writeHostFile } from "./command-handlers/file-write.js";
import {
  mkdirHostPath,
  moveHostPath,
  removeHostPath,
} from "./command-handlers/path-mutations.js";
import { resolveInteractiveRequest } from "./command-handlers/interactive.js";
import { pickHostFolder } from "./command-handlers/native-folder-picker.js";
import {
  ProviderInstallationInProgressError,
  streamProviderInstallation,
} from "./provider-installation.js";
import type {
  ProviderInstallationStatus,
  ProviderInstallationVerification,
} from "@bb/provider-bridge-protocol";
import {
  discardThreadRewind,
  ensureThreadRuntime,
  prepareThreadRewind,
  startThread,
  submitTurn,
} from "./command-handlers/thread.js";
import { WorkspaceError } from "@bb/host-workspace";
import {
  cloneProject,
  inspectProjectPath,
  resolveProjectCloneDefaultPath,
} from "./command-handlers/project.js";
import {
  requireResolvedWorkspaceForCommand,
  resolveWorkspaceForCommand,
  workspaceResolutionFailureFromError,
} from "./workspace-resolution.js";
import { userExecutableProcessOptions } from "./user-executable-env.js";

const THREAD_STOP_ACTIVE_TURN_WAIT_MS = 5_000;

export {
  CommandDispatchError,
  getErrorCode,
  type CommandDispatchOptions,
} from "./command-dispatch-support.js";

type CommandHandlerMap = {
  [TType in HostDaemonSettledCommandType]: (
    command: Extract<HostDaemonCommand, { type: TType }>,
    options: CommandDispatchOptions,
  ) => Promise<HostDaemonCommandResult<TType>>;
};

type OnlineRpcHandlerMap = {
  [TType in HostDaemonOnlineRpcCommandType]: (
    command: Extract<HostDaemonOnlineRpcCommand, { type: TType }>,
    options: CommandDispatchOptions,
  ) => Promise<HostDaemonOnlineRpcResult<TType>>;
};

function throwExpectedWorkspacePathNotFoundOrRethrow(error: unknown): never {
  if (error instanceof WorkspaceError && error.code === "path_not_found") {
    throw new ExpectedCommandDispatchError(error.code, error.message);
  }
  throw error;
}

function providerCliEnvFromShellEnv(
  shellEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return shellEnv.PATH ? { ...process.env, PATH: shellEnv.PATH } : process.env;
}

function handleProviderCliInstallEventLine(
  line: string,
  events: ProviderCliInstallEvent[],
): void {
  const trimmedLine = line.trim();
  if (trimmedLine.length === 0) {
    return;
  }
  events.push(providerCliInstallEventSchema.parse(JSON.parse(trimmedLine)));
}

function collectProviderCliInstallEventLines(
  buffer: string,
  events: ProviderCliInstallEvent[],
): string {
  const lines = buffer.split(/\r?\n/u);
  const lastLine = lines.pop();
  for (const line of lines) {
    handleProviderCliInstallEventLine(line, events);
  }
  return lastLine ?? "";
}

async function readProviderCliInstallEvents(
  stream: ReadableStream<Uint8Array>,
): Promise<ProviderCliInstallEvent[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: ProviderCliInstallEvent[] = [];
  let buffer = "";

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    buffer += decoder.decode(result.value, { stream: true });
    buffer = collectProviderCliInstallEventLines(buffer, events);
  }

  buffer += decoder.decode();
  handleProviderCliInstallEventLine(buffer, events);
  return events;
}

function failProviderInstallationVerification(args: {
  providerId: string;
  events: ProviderCliInstallEvent[];
  message: string;
}): ProviderCliInstallEvent[] {
  const verifiedEvents = [...args.events];
  const completedIndex = verifiedEvents.findIndex(
    (event) => event.type === "completed" && event.success,
  );
  const completedEvent = verifiedEvents[completedIndex];
  if (completedEvent?.type !== "completed") {
    return args.events;
  }
  verifiedEvents[completedIndex] = { ...completedEvent, success: false };
  verifiedEvents.splice(completedIndex, 0, {
    type: "error",
    provider: args.providerId,
    message: args.message,
  });
  return verifiedEvents;
}

function installationVerificationPassed(
  verification: ProviderInstallationVerification,
  status: ProviderInstallationStatus,
): boolean {
  switch (verification.kind) {
    case "installed":
      return status.installed;
    case "version_at_least": {
      const actual =
        status.currentVersion === null
          ? null
          : semver.valid(status.currentVersion);
      const expected = semver.valid(verification.version);
      return (
        actual !== null && expected !== null && semver.gte(actual, expected)
      );
    }
    case "version_changed": {
      const actual = status.currentVersion;
      if (actual === null) return false;
      const parsedActual = semver.valid(actual);
      const parsedPrevious = semver.valid(verification.previousVersion);
      return parsedActual !== null && parsedPrevious !== null
        ? semver.gt(parsedActual, parsedPrevious)
        : actual !== verification.previousVersion;
    }
  }
  return false;
}

async function runProviderInstallationOnHost(
  command: CommandOf<"provider.installation.run">,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<"provider.installation.run">> {
  try {
    const env = providerCliEnvFromShellEnv(
      options.runtimeManager.getShellEnv(),
    );
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    const maintenanceArgs = {
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      bridgeLaunch,
    };
    const run = await options.providerInstallationRun({
      ...maintenanceArgs,
      action: command.action,
    });
    if (!run.available) {
      return {
        events: [
          {
            type: "error",
            provider: command.providerId,
            message: run.message,
          },
        ],
      };
    }
    const stream =
      options.streamProviderInstallation ?? streamProviderInstallation;
    let events = await readProviderCliInstallEvents(
      stream({
        providerId: command.providerId,
        plan: run.command,
        env,
      }),
    );
    if (events.some((event) => event.type === "completed" && event.success)) {
      try {
        const status =
          await options.providerInstallationStatus(maintenanceArgs);
        if (!installationVerificationPassed(run.verification, status)) {
          events = failProviderInstallationVerification({
            providerId: command.providerId,
            events,
            message: `${command.providerId} ${command.action} exited successfully, but the provider could not verify the installed result.`,
          });
        }
      } catch {
        events = failProviderInstallationVerification({
          providerId: command.providerId,
          events,
          message: `${command.providerId} ${command.action} exited successfully, but its installation status could not be verified.`,
        });
      }
    }
    if (events.some((event) => event.type === "completed" && event.success)) {
      await options.runtimeManager.invalidateProviderMaintenanceRuntime();
    }
    return { events };
  } catch (error) {
    if (error instanceof ProviderInstallationInProgressError) {
      return {
        events: [
          {
            type: "error",
            provider: command.providerId,
            message: error.message,
          },
        ],
      };
    }
    throw error;
  }
}

const commandHandlers: CommandHandlerMap = {
  "thread.rewind.discard": async (command, options) => {
    const release =
      await options.runtimeManager.retainEnvironmentForThreadCommand(
        command.environmentId,
        command.threadId,
      );
    try {
      return await discardThreadRewind(command, options);
    } finally {
      release();
    }
  },
  "thread.rewind.prepare": async (command, options) => {
    const release =
      await options.runtimeManager.retainEnvironmentForThreadCommand(
        command.environmentId,
        command.threadId,
      );
    try {
      return await prepareThreadRewind(command, options);
    } finally {
      release();
    }
  },
  "thread.start": async (command, options) => {
    const release =
      await options.runtimeManager.retainEnvironmentForThreadCommand(
        command.environmentId,
        command.threadId,
      );
    try {
      return await startThread(command, options);
    } finally {
      release();
    }
  },
  "turn.submit": async (command, options) => {
    const release =
      await options.runtimeManager.retainEnvironmentForThreadCommand(
        command.environmentId,
        command.threadId,
      );
    try {
      const entry = await ensureThreadRuntime(command, options);
      return await submitTurn(command, entry, options);
    } finally {
      release();
    }
  },
  "thread.stop": async (command, options) => {
    const released =
      await options.runtimeManager.releaseThreadFromOtherEnvironments({
        activeTurn: "interrupt",
        environmentId: command.environmentId,
        threadId: command.threadId,
      });
    const entry = await options.runtimeManager.getOrAwait(
      command.environmentId,
    );
    if (!entry) {
      await options.eventSink.flush();
      return {
        providerCheckpointId: released.providerCheckpointId,
      };
    }
    let providerCheckpointId = released.providerCheckpointId;
    if (entry.runtime.hasThread(command.threadId)) {
      if (command.intent === "release") {
        if (entry.runtime.getActiveTurnId(command.threadId) !== null) {
          await options.eventSink.flush();
          return { providerCheckpointId };
        }
      } else {
        await entry.runtime.waitForActiveTurn(command.threadId, {
          timeoutMs: THREAD_STOP_ACTIVE_TURN_WAIT_MS,
        });
      }
      const result = await entry.runtime.stopThread({
        threadId: command.threadId,
      });
      providerCheckpointId =
        result.providerCheckpointId ?? providerCheckpointId;
    }
    await options.eventSink.flush();
    return { providerCheckpointId };
  },
  "thread.goal.clear": async (command, options) => {
    const entry = await ensureThreadRuntime(command, options);
    const result = await entry.runtime.clearThreadGoal({
      threadId: command.threadId,
    });
    await options.eventSink.flush();
    return result;
  },
  "thread.plan.cancel": async (command, options) => {
    const owners = options.runtimeManager.listThreadOwnerEntries(
      command.threadId,
    );
    if (owners.length === 0) {
      throw new ExpectedCommandDispatchError(
        "unknown_thread_runtime",
        `No provider runtime available for thread ${command.threadId}`,
      );
    }
    const owner = owners.find(
      (entry) =>
        entry.runtime.getActiveTurnId(command.threadId) ===
        command.expectedTurnId,
    );
    if (!owner) {
      return { cancelled: false };
    }
    await owner.runtime.stopThread({ threadId: command.threadId });
    await options.eventSink.flush();
    return { cancelled: true };
  },
  "thread.rename": async (command, options) => {
    const entry = await options.runtimeManager.getOrAwait(
      command.environmentId,
    );
    if (!entry) {
      return {};
    }
    await entry.runtime.renameThread({
      threadId: command.threadId,
      title: command.title,
    });
    return {};
  },
  "thread.archive": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    await entry.runtime.archiveThread({
      threadId: command.threadId,
      providerId: command.providerId,
      providerThreadId: command.providerThreadId,
      bridgeLaunch,
    });
    return {};
  },
  "thread.unarchive": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    await options.runtimeManager.withProviderMaintenanceRuntime(
      { dataDir: options.dataDir },
      (runtime) =>
        runtime.unarchiveThread({
          threadId: command.threadId,
          providerId: command.providerId,
          providerThreadId: command.providerThreadId,
          bridgeLaunch,
        }),
    );
    return {};
  },
  "interactive.resolve": resolveInteractiveRequest,
  "environment.provision": provisionEnvironment,
  "project.clone": (command, options) =>
    cloneProject({
      dataDir: options.dataDir,
      projectSlug: command.projectSlug,
      remoteUrl: command.remoteUrl,
      ...userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
      ...(command.targetPath !== undefined
        ? { targetPath: command.targetPath }
        : {}),
    }),
  "environment.provision.cancel": cancelEnvironmentProvision,
  "environment.destroy": async (command, options) => {
    const transcript: HostDaemonCommandResult<"environment.destroy">["transcript"] =
      [];
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      if (resolution.failure.code === "path_not_found") {
        return { transcript };
      }
      throw new ExpectedCommandDispatchError(
        resolution.failure.code,
        resolution.failure.message,
      );
    }
    await options.terminalManager?.closeEnvironmentTerminals({
      environmentId: command.environmentId,
      reason: "environment-destroyed",
    });
    await options.runtimeManager.destroyEnvironment(command.environmentId, {
      timeoutMs: command.teardownTimeoutMs,
      onProgress: (entry) => transcript.push(entry),
    });
    return { transcript };
  },
  "workspace.commit": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    return entry.workspace.commit({
      message: command.message,
      noVerify: true,
    });
  },
  "workspace.pull_request_action": async (command, options) => {
    const entry = await requireResolvedWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    const cliOptions = userExecutableProcessOptions(
      options.runtimeManager.getShellEnv(),
    );
    switch (command.operation) {
      case "ready":
        await entry.workspace.runPullRequestAction(
          { operation: "ready" },
          cliOptions,
        );
        break;
      case "draft":
        await entry.workspace.runPullRequestAction(
          { operation: "draft" },
          cliOptions,
        );
        break;
      case "merge":
        await entry.workspace.runPullRequestAction(
          {
            operation: "merge",
            method: command.method,
          },
          cliOptions,
        );
        break;
      default: {
        const _exhaustive: never = command;
        throw new Error(`Unhandled pull request operation: ${_exhaustive}`);
      }
    }
    return {};
  },
};

const onlineRpcHandlers: OnlineRpcHandlerMap = {
  "desktop.browser.list_instances": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.list_tabs": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.create_tab": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.reveal_tab": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.close_tab": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.capture_tab": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.acquire_control": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.open_connection": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "desktop.browser.release_control": async (command, options) => {
    if (!options.desktopBrowserBroker)
      throw new Error("Desktop browser broker unavailable");
    return options.desktopBrowserBroker.request(command);
  },
  "connect-tunnel.ensure-identity": async (_command, options) => {
    if (!options.ensureConnectTunnelIdentity) {
      throw new Error("bb connect tunnel identity is unavailable");
    }
    return options.ensureConnectTunnelIdentity();
  },
  "host.list_files": listHostFiles,
  "host.list_paths": listHostPaths,
  "host.mkdir": mkdirHostPath,
  "host.move_path": moveHostPath,
  "host.remove_path": removeHostPath,
  "host.browse_directory": browseHostDirectory,
  "host.paths_exist": checkHostPathsExist,
  "project.inspect": async (command, options) =>
    inspectProjectPath(
      command.path,
      userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
    ),
  "project.clone_default_path": async (command, options) => ({
    path: resolveProjectCloneDefaultPath(options.dataDir, command.projectSlug),
  }),
  "host.pick_folder": pickHostFolder,
  "plugin.host.call": async () => {
    throw new Error("plugin.host.call must be routed by CommandRouter");
  },
  "plugin.host.cancel": async () => {
    throw new Error("plugin.host.cancel must be routed by CommandRouter");
  },
  "plugin.host.dispose": async () => {
    throw new Error("plugin.host.dispose must be routed by CommandRouter");
  },
  "host.list_commands": listHostCommands,
  "host.list_skills": listHostSkills,
  "host.delete_skill": deleteHostSkill,
  "host.write_skill": writeHostSkill,
  "host.install_global_skills": installGlobalSkills,
  "host.global_skills_status": async (command) =>
    readGlobalSkillsStatus(command, {}),
  "host.inspect_git_source": inspectHostGitSource,
  "host.list_branch_options": listHostBranchOptions,
  "host.file_metadata": readHostFileMetadata,
  "host.read_file": readHostFile,
  "host.read_file_relative": readHostRelativeFile,
  "host.write_file": writeHostFile,
  "provider.list_models": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    return options.listModels({
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      bridgeLaunch,
    });
  },
  "provider.health": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    return options.providerHealth({
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      bridgeLaunch,
    });
  },
  "provider.usage": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    return options.providerUsage({
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      bridgeLaunch,
    });
  },
  "provider.installation.status": async (command, options) => {
    const bridgeLaunch = await resolveRuntimeBridgeLaunch(
      command.bridgeLaunch,
      options,
    );
    return options.providerInstallationStatus({
      providerId: command.providerId,
      ...(command.cwd !== undefined ? { cwd: command.cwd } : {}),
      ...(command.requirement !== undefined
        ? { requirement: command.requirement }
        : {}),
      bridgeLaunch,
    });
  },
  "provider.installation.run": runProviderInstallationOnHost,
  "workspace.status": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      return { outcome: "unavailable", failure: resolution.failure };
    }
    try {
      return {
        outcome: "available",
        workspaceStatus: await resolution.entry.workspace.getStatus({
          mergeBaseBranch: command.mergeBaseBranch,
          maxUntrackedLineStatFiles: command.maxUntrackedLineStatFiles,
          maxUntrackedLineStatBytes: command.maxUntrackedLineStatBytes,
        }),
      };
    } catch (error) {
      return {
        outcome: "unavailable",
        failure: workspaceResolutionFailureFromError({
          error,
          workspacePath: command.workspaceContext.workspacePath,
        }),
      };
    }
  },
  "workspace.diff": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      return { outcome: "unavailable", failure: resolution.failure };
    }
    try {
      return {
        outcome: "available",
        diff: await resolution.entry.workspace.getDiff({
          target: command.target,
          maxDiffBytes: command.maxDiffBytes,
          maxFileListBytes: command.maxFileListBytes,
          maxUntrackedFiles: command.maxUntrackedFiles,
        }),
      };
    } catch (error) {
      return {
        outcome: "unavailable",
        failure: workspaceResolutionFailureFromError({
          error,
          workspacePath: command.workspaceContext.workspacePath,
        }),
      };
    }
  },
  "workspace.diffFiles": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      return { outcome: "unavailable", failure: resolution.failure };
    }
    try {
      return {
        outcome: "available",
        ...(await resolution.entry.workspace.diffFiles({
          target: command.target,
          maxFiles: command.maxFiles,
        })),
      };
    } catch (error) {
      return {
        outcome: "unavailable",
        failure: workspaceResolutionFailureFromError({
          error,
          workspacePath: command.workspaceContext.workspacePath,
        }),
      };
    }
  },
  "workspace.diffPatch": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      return { outcome: "unavailable", failure: resolution.failure };
    }
    try {
      return {
        outcome: "available",
        patches: await resolution.entry.workspace.diffPatch({
          target: command.target,
          paths: command.paths,
          maxBytesPerFile: command.maxBytesPerFile,
        }),
      };
    } catch (error) {
      return {
        outcome: "unavailable",
        failure: workspaceResolutionFailureFromError({
          error,
          workspacePath: command.workspaceContext.workspacePath,
        }),
      };
    }
  },
  "workspace.pull_request": async (command, options) => {
    const resolution = await resolveWorkspaceForCommand({
      dataDir: options.dataDir,
      environmentId: command.environmentId,
      requireGit: true,
      requireManagedWorktree: true,
      runtimeManager: options.runtimeManager,
      workspaceContext: command.workspaceContext,
    });
    if (!resolution.ok) {
      return resolution.failure.code === "not_git_repo"
        ? { outcome: "absent" }
        : { outcome: "unavailable", message: resolution.failure.message };
    }
    const lookup = await resolution.entry.workspace.getPullRequest(
      userExecutableProcessOptions(options.runtimeManager.getShellEnv()),
    );
    switch (lookup.outcome) {
      case "found":
        return { outcome: "available", pullRequest: lookup.pullRequest };
      case "none":
        return { outcome: "absent" };
      case "unavailable":
        return { outcome: "unavailable", message: lookup.message };
    }
  },
};

export async function dispatchCommand<
  TType extends HostDaemonSettledCommandType,
>(
  command: Extract<HostDaemonCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<TType>> {
  try {
    return await commandHandlers[command.type](command, options);
  } catch (error) {
    throwExpectedWorkspacePathNotFoundOrRethrow(error);
  }
}

export async function dispatchOnlineRpcCommand<
  TType extends HostDaemonOnlineRpcCommandType,
>(
  command: Extract<HostDaemonOnlineRpcCommand, { type: TType }>,
  options: CommandDispatchOptions,
): Promise<HostDaemonOnlineRpcResult<TType>> {
  try {
    return await onlineRpcHandlers[command.type](command, options);
  } catch (error) {
    throwExpectedWorkspacePathNotFoundOrRethrow(error);
  }
}
