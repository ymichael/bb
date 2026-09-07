import { threadScope, type ProvisioningTranscriptEntry } from "@bb/domain";
import type {
  EnvironmentProvisionCommand,
  HostDaemonCommandResult,
} from "@bb/host-daemon-contract";
import {
  getPersonalWorkspaceRoot,
  validatePersonalWorkspaceTargetPath,
  type ProvisionWorkspaceArgs,
} from "@bb/host-workspace";
import {
  type CommandDispatchOptions,
  type CommandOf,
} from "../command-dispatch-support.js";

type ProvisionProgressCallback = (entry: ProvisioningTranscriptEntry) => void;
interface ProvisionProgressEmitter {
  flush: () => void;
  onProgress: ProvisionProgressCallback;
}
type BuildOnProgressArgs = {
  command: CommandOf<"environment.provision">;
  options: CommandDispatchOptions;
  transcript: ProvisioningTranscriptEntry[];
};

const PROVISION_PROGRESS_BATCH_MS = 1_000;

export async function provisionEnvironment(
  command: CommandOf<"environment.provision">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.provision">> {
  const alreadyExists =
    options.runtimeManager.get(command.environmentId) != null;

  const transcript: ProvisioningTranscriptEntry[] = [];
  const progress = buildOnProgress({
    command,
    options,
    transcript,
  });

  try {
    const entry = await options.runtimeManager.ensureEnvironment({
      environmentId: command.environmentId,
      provision: toProvisionWorkspaceOptions(
        command,
        options,
        progress.onProgress,
      ),
    });

    const [branchName, resolvedDefaultBranch] = await Promise.all([
      entry.workspace.getCurrentBranch(),
      entry.workspace.isGitRepo
        ? entry.workspace.getDefaultBranch()
        : Promise.resolve(null),
    ]);
    const defaultBranch = entry.workspace.isGitRepo
      ? (resolvedDefaultBranch ?? branchName)
      : null;

    if (!alreadyExists) {
      if (!entry.workspace.managed) {
        progress.onProgress({
          type: "step",
          key: "workspace-path",
          text: `Using workspace: ${entry.workspace.path}`,
          status: "completed",
          startedAt: Date.now(),
        });
      }
      if (entry.workspace.isGitRepo && branchName) {
        let branchText = `Using branch: ${branchName}`;
        const metadata: { branchName: string; sha?: string } = { branchName };
        try {
          const sha = await entry.workspace.getHeadSha();
          if (sha) {
            branchText = `Using branch: ${branchName} (${sha.slice(0, 7)})`;
            metadata.sha = sha;
          }
        } catch {}
        progress.onProgress({
          type: "step",
          key: "workspace-branch",
          text: branchText,
          status: "completed",
          startedAt: Date.now(),
          metadata,
        });
      }
    }

    return {
      path: entry.workspace.path,
      isGitRepo: entry.workspace.isGitRepo,
      isWorktree: entry.workspace.isWorktree,
      branchName,
      defaultBranch,
      transcript: alreadyExists ? [] : transcript,
    };
  } finally {
    progress.flush();
    if (command.initiator) {
      await options.eventSink.flush();
    }
  }
}

export function cancelEnvironmentProvision(
  command: CommandOf<"environment.provision.cancel">,
  options: CommandDispatchOptions,
): Promise<HostDaemonCommandResult<"environment.provision.cancel">> {
  return options.runtimeManager.cancelEnvironmentProvision({
    environmentId: command.environmentId,
  });
}

function buildOnProgress(args: BuildOnProgressArgs): ProvisionProgressEmitter {
  const { command, options, transcript } = args;
  const initiator = command.initiator;
  const eventSink = options.eventSink;
  if (!initiator) {
    return {
      flush: () => undefined,
      onProgress: (entry) => {
        transcript.push(entry);
      },
    };
  }
  const threadId = initiator.threadId;
  const pendingEntries: ProvisioningTranscriptEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (pendingEntries.length === 0) {
      return;
    }
    const entries = pendingEntries.splice(0, pendingEntries.length);
    eventSink.emit({
      threadId,
      event: {
        type: "system/thread-provisioning",
        threadId,
        scope: threadScope(),
        provisioningId: initiator.provisioningId,
        status: "active",
        environmentId: command.environmentId,
        entries,
      },
    });
  };

  const scheduleFlush = () => {
    if (flushTimer !== null) {
      return;
    }
    flushTimer = setTimeout(flush, PROVISION_PROGRESS_BATCH_MS);
  };

  return {
    flush,
    onProgress: (entry) => {
      transcript.push(entry);
      pendingEntries.push(entry);
      scheduleFlush();
    },
  };
}

function toProvisionWorkspaceOptions(
  command: EnvironmentProvisionCommand,
  options: Pick<CommandDispatchOptions, "dataDir">,
  onProgress?: ProvisionProgressCallback,
): ProvisionWorkspaceArgs {
  switch (command.workspaceProvisionType) {
    case "unmanaged": {
      return {
        workspaceProvisionType: "unmanaged" as const,
        path: command.path,
        ...(command.checkout ? { checkout: command.checkout } : {}),
        onProgress,
      };
    }
    case "managed-worktree": {
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        sourcePath: command.sourcePath,
        targetPath: command.targetPath,
        branchName: command.branchName,
        baseBranch: command.baseBranch,
        timeoutMs: command.setupTimeoutMs,
        onProgress,
      };
    }
    case "personal": {
      const personalWorkspaceRoot = getPersonalWorkspaceRoot(options.dataDir);
      const targetPath = validatePersonalWorkspaceTargetPath({
        environmentId: command.environmentId,
        personalWorkspaceRoot,
        targetPath: command.targetPath,
      });
      return {
        workspaceProvisionType: command.workspaceProvisionType,
        environmentId: command.environmentId,
        personalWorkspaceRoot,
        targetPath,
        onProgress,
      };
    }
  }
}
